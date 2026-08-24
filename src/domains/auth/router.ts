import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { FastifyInstance } from 'fastify'
import * as client from 'openid-client'

import { env } from '../../shared/env.js'
import { sessionCookieOptions } from './guard.js'
import { getOidcConfig, readClaims, REDIRECT_URI, rolesOf } from './oidc.js'
import {
  createSession,
  deleteSession,
  deleteSessionsBySsoSid,
  deleteSessionsByUserSub,
  FLOW_COOKIE,
  SESSION_COOKIE,
} from './service.js'
import { safeReturnTo } from './url-safety.js'

const BACKCHANNEL_EVENT = 'http://schemas.openid.net/event/backchannel-logout'

const LOGIN_ERRORS: Record<string, string> = {
  'flow-expired': '로그인 요청이 만료되었다. 다시 시도하라.',
  'no-id-token': 'Keycloak이 ID token을 돌려주지 않았다. 클라이언트 스코프 설정을 확인하라.',
  'exchange-failed': '인가 코드 교환에 실패했다. 서버 로그를 확인하라.',
}

/** 인가 요청 ~ 콜백 사이에만 존재하는 값. 서명된 쿠키에 담는다. */
type FlowState = { v: string; s: string; n: string; r: string }

const flowCookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: env.APP_BASE_URL.startsWith('https://'),
  path: '/',
  signed: true,
  maxAge: 600, // 로그인 화면에 머무를 수 있는 최대 시간
} as const

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined

async function getJwks() {
  if (!jwks) {
    const meta = (await getOidcConfig()).serverMetadata()
    if (!meta.jwks_uri) throw new Error('Keycloak discovery에 jwks_uri가 없다')
    jwks = createRemoteJWKSet(new URL(meta.jwks_uri))
  }
  return jwks
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get('/login-error', async (request, reply) => {
    const reason = (request.query as Record<string, unknown>).reason
    const message =
      (typeof reason === 'string' ? LOGIN_ERRORS[reason] : undefined) ??
      '알 수 없는 오류가 발생했다.'

    return reply.code(400).view('domains/auth/views/login-error', { message })
  })

  app.get('/api/auth/login', async (request, reply) => {
    const config = await getOidcConfig()

    const codeVerifier = client.randomPKCECodeVerifier()
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier)
    const state = client.randomState()
    const nonce = client.randomNonce()

    const flow: FlowState = {
      v: codeVerifier,
      s: state,
      n: nonce,
      r: safeReturnTo((request.query as Record<string, unknown>).returnTo),
    }
    reply.setCookie(FLOW_COOKIE, JSON.stringify(flow), flowCookieOptions)

    const authUrl = client.buildAuthorizationUrl(config, {
      redirect_uri: REDIRECT_URI,
      scope: 'openid profile email',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      nonce,
    })

    return reply.redirect(authUrl.href)
  })

  app.get('/api/auth/callback', async (request, reply) => {
    const fail = (reason: string) => reply.redirect(`/login-error?reason=${reason}`)

    const rawFlow = request.cookies[FLOW_COOKIE]
    reply.clearCookie(FLOW_COOKIE, { path: '/' })
    if (!rawFlow) return fail('flow-expired')

    const unsigned = request.unsignCookie(rawFlow)
    if (!unsigned.valid || !unsigned.value) return fail('flow-expired')

    let flow: FlowState
    try {
      flow = JSON.parse(unsigned.value) as FlowState
    } catch {
      return fail('flow-expired')
    }

    // request.url은 리버스 프록시 뒤에서 내부 주소가 될 수 있다.
    // 검증에 쓰는 URL은 등록된 redirect_uri 기준으로 다시 만든다.
    const currentUrl = new URL(REDIRECT_URI)
    currentUrl.search = new URL(request.url, env.APP_BASE_URL).search

    try {
      const config = await getOidcConfig()
      const tokens = await client.authorizationCodeGrant(config, currentUrl, {
        pkceCodeVerifier: flow.v,
        expectedState: flow.s,
        expectedNonce: flow.n,
      })

      const raw = tokens.claims()
      if (!raw || !tokens.id_token) return fail('no-id-token')

      const claims = readClaims(raw)
      const sessionId = await createSession({
        sub: claims.sub,
        ssoSid: claims.sid,
        email: claims.email,
        name: claims.name ?? claims.preferred_username,
        // 표시용 성명(name)과 별도로 남긴다. 하위 앱의 preferred_username claim 원본이다.
        username: claims.preferred_username,
        employeeCode: claims.employee_code,
        roles: rolesOf(claims),
        idToken: tokens.id_token,
      })

      reply.setCookie(SESSION_COOKIE, sessionId, sessionCookieOptions)
      return reply.redirect(safeReturnTo(flow.r))
    } catch (error) {
      request.log.error({ err: error }, 'authorization code grant 실패')
      return fail('exchange-failed')
    }
  })

  /**
   * POST 전용이다. GET으로 두면 다른 사이트의 <img src> 한 줄로 강제 로그아웃이 가능하다.
   * 포털 세션을 먼저 끊고, Keycloak의 SSO 세션까지 끊도록 리다이렉트한다.
   */
  app.post('/api/auth/logout', async (request, reply) => {
    let idToken: string | null = null
    if (request.user) idToken = await deleteSession(request.user.sessionId)

    reply.clearCookie(SESSION_COOKIE, { path: '/' })

    const config = await getOidcConfig()
    const endSessionUrl = client.buildEndSessionUrl(config, {
      post_logout_redirect_uri: env.APP_BASE_URL,
      ...(idToken ? { id_token_hint: idToken } : {}),
    })

    return reply.code(303).redirect(endSessionUrl.href)
  })

  /**
   * Keycloak이 로그아웃 시 서버-서버로 호출한다.
   * 브라우저를 거치지 않으므로 logout_token(JWT) 서명 검증이 유일한 인증 수단이다.
   * 스펙: OpenID Connect Back-Channel Logout 1.0
   */
  app.post('/api/auth/backchannel-logout', async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined
    const logoutToken = body?.logout_token

    if (typeof logoutToken !== 'string') {
      return reply.code(400).send({ error: 'logout_token 누락' })
    }

    let payload: Record<string, unknown>
    try {
      const verified = await jwtVerify(logoutToken, await getJwks(), {
        issuer: env.OIDC_ISSUER,
        audience: env.OIDC_CLIENT_ID,
      })
      payload = verified.payload as Record<string, unknown>
    } catch (error) {
      request.log.warn({ err: error }, 'logout_token 검증 실패')
      return reply.code(400).send({ error: 'logout_token 검증 실패' })
    }

    // 스펙 요구사항: backchannel-logout 이벤트여야 하고, nonce가 있으면 안 된다
    // (nonce가 있으면 ID token을 logout token으로 재사용하려는 시도다).
    const events = payload.events as Record<string, unknown> | undefined
    if (!events || !(BACKCHANNEL_EVENT in events)) {
      return reply.code(400).send({ error: 'backchannel-logout 이벤트가 아니다' })
    }
    if ('nonce' in payload) {
      return reply.code(400).send({ error: 'logout_token에 nonce가 있으면 안 된다' })
    }

    const sid = typeof payload.sid === 'string' ? payload.sid : undefined
    const sub = typeof payload.sub === 'string' ? payload.sub : undefined

    let removed = 0
    if (sid) removed = await deleteSessionsBySsoSid(sid)
    else if (sub) removed = await deleteSessionsByUserSub(sub)
    else return reply.code(400).send({ error: 'sid와 sub가 모두 없다' })

    request.log.info({ sid, removed }, 'back-channel logout')

    return reply.code(200).header('cache-control', 'no-store').send()
  })
}
