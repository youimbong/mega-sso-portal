import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import * as oidcClient from 'openid-client'

import { deleteSession, getOidcConfig, requireUser, SESSION_COOKIE } from '../auth/index.js'
import { env } from '../../shared/env.js'
import { buildIdTokenClaims, buildUserinfoClaims } from './claims.js'
import { authenticateClient, findEnabledClient } from './clients.js'
import { consumeAuthCode, issueAuthCode } from './codes.js'
import { getPublicJwks } from './keys.js'
import { notifyPortalSessionsEnded } from './logout.js'
import { discoveryDocument, normalizeBaseUrl } from './metadata.js'
import { ensureSsoSession, findSsoSessionBySid, loadIdentity } from './service.js'
import {
  ACCESS_TOKEN_TTL_S,
  signAccessToken,
  signIdToken,
  verifyAccessToken,
  verifyIdTokenHint,
} from './tokens.js'
import {
  hasRequiredRoles,
  matchExactUri,
  normalizeScope,
  parseBasicAuth,
  verifyPkceS256,
  withState,
} from './validate.js'

const PORTAL_HOME = normalizeBaseUrl(env.APP_BASE_URL)

/** 같은 파라미터가 두 번 오면 배열이 된다. 해석이 갈리는 요청은 값이 없는 것으로 다룬다. */
function one(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function errorPage(
  request: FastifyRequest,
  reply: FastifyReply,
  code: number,
  title: string,
  message: string,
) {
  return reply.code(code).view('shared/views/error', { user: request.user, title, message })
}

/** OAuth 오류를 하위 앱으로 되돌린다. redirect_uri 검증을 통과한 뒤에만 쓸 수 있다. */
function redirectError(
  reply: FastifyReply,
  redirectUri: string,
  error: string,
  description: string,
  state: string | undefined,
) {
  const url = new URL(redirectUri)
  url.searchParams.set('error', error)
  url.searchParams.set('error_description', description)
  if (state) url.searchParams.set('state', state)

  return reply.header('cache-control', 'no-store').redirect(url.href)
}

function tokenError(reply: FastifyReply, code: number, error: string, description: string) {
  return reply
    .code(code)
    .header('cache-control', 'no-store')
    .header('pragma', 'no-cache')
    .send({ error, error_description: description })
}

export async function ssoRoutes(app: FastifyInstance): Promise<void> {
  const discovery = async (_request: FastifyRequest, reply: FastifyReply) =>
    reply
      .header('cache-control', 'public, max-age=300')
      .send(discoveryDocument(env.APP_BASE_URL))

  // openid-client의 기본 경로(append 형)가 정본이다.
  app.get('/oidc/.well-known/openid-configuration', discovery)
  // RFC 8414의 경로 삽입형. Spring Security 등 일부 RP가 이쪽을 쓴다.
  app.get('/.well-known/openid-configuration/oidc', discovery)
  // openid-client의 algorithm:'oauth2' 대응. 핸들러 재사용이라 비용이 없다.
  app.get('/.well-known/oauth-authorization-server/oidc', discovery)
  // 루트 bare 경로(/.well-known/openid-configuration)는 일부러 서빙하지 않는다.
  // 그 경로를 때리는 RP는 issuer를 포털 루트로 기대하므로 어차피 issuer 불일치로 실패한다.

  app.get('/oidc/jwks', async (_request, reply) => {
    return reply.header('cache-control', 'public, max-age=300').send(await getPublicJwks())
  })

  /**
   * 인가 엔드포인트. 미로그인이면 requireUser가 Keycloak 로그인으로 보내고,
   * returnTo로 이 요청 URL이 그대로 보존되어 로그인 후 같은 지점으로 돌아온다.
   */
  app.get('/oidc/authorize', { preHandler: requireUser }, async (request, reply) => {
    const query = request.query as Record<string, unknown>
    const user = request.user!

    const clientId = one(query.client_id)
    const redirectUri = one(query.redirect_uri)
    const state = one(query.state)

    // 1) client_id — 여기서 실패하면 어디로도 리다이렉트하지 않는다.
    const client = clientId ? await findEnabledClient(clientId) : null
    if (!client) {
      return errorPage(
        request,
        reply,
        400,
        '알 수 없는 앱이다',
        'client_id가 등록돼 있지 않거나 사용 중지 상태다. 포털 관리자에게 문의하라.',
      )
    }

    // 2) redirect_uri — 완전 일치. 틀린 주소로 오류를 되돌리는 것 자체가 취약점이다.
    if (!matchExactUri(client.redirectUris, redirectUri)) {
      return errorPage(
        request,
        reply,
        400,
        'redirect_uri가 등록된 값과 다르다',
        '하위 앱의 설정과 포털에 등록된 주소가 정확히 같아야 한다. 포털 관리자에게 문의하라.',
      )
    }
    const target = redirectUri!

    // 3) 여기서부터의 오류는 하위 앱으로 되돌린다.
    if (one(query.request) || one(query.request_uri)) {
      const isUri = Boolean(one(query.request_uri))
      return redirectError(
        reply,
        target,
        isUri ? 'request_uri_not_supported' : 'request_not_supported',
        'request 객체를 지원하지 않는다',
        state,
      )
    }
    if (one(query.response_type) !== 'code') {
      return redirectError(reply, target, 'unsupported_response_type', 'code만 지원한다', state)
    }
    const responseMode = one(query.response_mode)
    if (responseMode && responseMode !== 'query') {
      return redirectError(reply, target, 'invalid_request', 'response_mode는 query만 지원한다', state)
    }

    const scope = normalizeScope(one(query.scope))
    if (!scope.includes('openid')) {
      return redirectError(reply, target, 'invalid_scope', 'openid scope가 필요하다', state)
    }

    // PKCE는 필수다. confidential 클라이언트라도 인가 코드 가로채기를 막는 값이 하나 더 있는 편이 낫고,
    // 선택으로 두면 하위 앱이 조용히 빼먹는다.
    const codeChallenge = one(query.code_challenge)
    if (!codeChallenge || one(query.code_challenge_method) !== 'S256') {
      return redirectError(
        reply,
        target,
        'invalid_request',
        'code_challenge와 code_challenge_method=S256이 필요하다',
        state,
      )
    }

    // 4) 역할 검사. 실패해도 하위 앱으로 되돌리지 않는다 —
    //    하위 앱이 곧바로 다시 인가 요청을 보내 무한 루프가 되는 것이 예측 가능한 실패다.
    if (!hasRequiredRoles(client.requiredRoles, user.roles)) {
      request.log.warn(
        { clientId: client.clientId, sub: user.sub, error: 'access_denied' },
        'sso 인가 거부(역할 부족)',
      )
      return errorPage(
        request,
        reply,
        403,
        '접근 권한이 없다',
        `이 앱은 ${client.requiredRoles.join(', ')} 역할이 필요하다. 관리자에게 요청하라.`,
      )
    }

    await ensureSsoSession({
      portalSessionId: user.sessionId,
      clientId: client.clientId,
      userSub: user.sub,
    })

    const code = await issueAuthCode({
      clientId: client.clientId,
      portalSessionId: user.sessionId,
      redirectUri: target,
      scope: scope.join(' '),
      nonce: one(query.nonce) ?? null,
      codeChallenge,
    })

    const url = new URL(target)
    url.searchParams.set('code', code)
    if (state) url.searchParams.set('state', state)

    return reply.header('cache-control', 'no-store').redirect(url.href)
  })

  /**
   * 토큰 엔드포인트. 브라우저가 아닌 하위 앱 서버가 호출하므로 Origin이 없다 —
   * guard.ts의 Origin 검사 예외 대상이고, 인증은 client_secret으로 한다.
   */
  app.post('/oidc/token', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>

    const basic = parseBasicAuth(request.headers.authorization)
    const bodyId = one(body.client_id)
    const bodySecret = one(body.client_secret)

    // RFC 6749 2.3 — 인증 방법은 하나여야 한다.
    if (basic && bodySecret) {
      return tokenError(reply, 400, 'invalid_request', '클라이언트 인증 방법이 둘 이상이다')
    }

    const client = await authenticateClient(
      basic ?? (bodyId && bodySecret ? { clientId: bodyId, clientSecret: bodySecret } : null),
    )
    if (!client) {
      return reply
        .code(401)
        .header('www-authenticate', 'Basic realm="oidc"')
        .header('cache-control', 'no-store')
        .send({ error: 'invalid_client', error_description: '클라이언트 인증에 실패했다' })
    }

    if (one(body.grant_type) !== 'authorization_code') {
      return tokenError(reply, 400, 'unsupported_grant_type', 'authorization_code만 지원한다')
    }

    const code = one(body.code)
    const row = code ? await consumeAuthCode(code) : null
    if (!row) {
      return tokenError(reply, 400, 'invalid_grant', '인가 코드가 유효하지 않다')
    }

    // 코드를 발급받은 클라이언트·주소·PKCE가 하나라도 어긋나면 교환하지 않는다.
    if (
      row.clientId !== client.clientId ||
      row.redirectUri !== one(body.redirect_uri) ||
      !verifyPkceS256(row.codeChallenge, one(body.code_verifier))
    ) {
      return tokenError(reply, 400, 'invalid_grant', '인가 코드가 유효하지 않다')
    }

    const identity = await loadIdentity(row.portalSessionId)
    if (!identity) {
      return tokenError(reply, 400, 'invalid_grant', '포털 세션이 이미 종료됐다')
    }

    // 인가 시점에 만든 링크를 다시 확인한다. 남아 있으면 같은 sid가 그대로 돌아온다.
    const sid = await ensureSsoSession({
      portalSessionId: row.portalSessionId,
      clientId: client.clientId,
      userSub: identity.sub,
    })

    const scope = normalizeScope(row.scope)
    const idToken = await signIdToken(
      buildIdTokenClaims({
        identity,
        clientId: client.clientId,
        sid,
        scope,
        nonce: row.nonce,
      }),
    )
    const accessToken = await signAccessToken({
      sub: identity.sub,
      clientId: client.clientId,
      sid,
      scope,
    })

    return reply
      .header('cache-control', 'no-store')
      .header('pragma', 'no-cache')
      .send({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: ACCESS_TOKEN_TTL_S,
        id_token: idToken,
        scope: scope.join(' '),
      })
  })

  /** Bearer 헤더만 받는다. 쿼리 파라미터 방식은 토큰이 로그·referer에 남아 지원하지 않는다. */
  app.get('/oidc/userinfo', async (request, reply) => {
    const header = request.headers.authorization
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined

    const invalid = () =>
      reply
        .code(401)
        .header('www-authenticate', 'Bearer error="invalid_token"')
        .header('cache-control', 'no-store')
        .send({ error: 'invalid_token', error_description: 'access token이 유효하지 않다' })

    if (!token) return invalid()

    const verified = await verifyAccessToken(token)
    if (!verified) return invalid()

    // 포털 세션 생존 확인이 로그아웃을 즉시 반영하는 유일한 수단이다(access token은 저장하지 않는다).
    const link = await findSsoSessionBySid(verified.sid)
    if (!link) return invalid()

    const identity = await loadIdentity(link.portalSessionId)
    if (!identity) return invalid()

    return reply
      .header('cache-control', 'no-store')
      .send(buildUserinfoClaims(identity, verified.scope))
  })

  /**
   * RP-initiated logout. 하위 앱이 브라우저를 이리로 보낸다.
   * 포털 세션을 끊고 Keycloak의 SSO 세션까지 끊도록 이어서 리다이렉트한다.
   */
  app.get('/oidc/logout', async (request, reply) => {
    const query = request.query as Record<string, unknown>

    const hint = one(query.id_token_hint)
    const hinted = hint ? await verifyIdTokenHint(hint) : null
    const clientId = hinted?.clientId ?? one(query.client_id)

    const client = clientId ? await findEnabledClient(clientId) : null
    const requested = one(query.post_logout_redirect_uri)
    const state = one(query.state)

    // 검증 없는 post-logout redirect는 그대로 open redirect다. 등록된 값과 완전히 같을 때만 쓴다.
    const allowed =
      client && matchExactUri(client.postLogoutRedirectUris, requested) ? requested! : null
    const target = allowed ? withState(allowed, state) : PORTAL_HOME

    const link = hinted ? await findSsoSessionBySid(hinted.sid) : null
    const sessionId = request.user?.sessionId ?? null

    // 세션을 끊을 근거는 요청자의 쿠키다. id_token_hint는 어느 앱의 요청인지 보정하는 보조 수단일 뿐이다.
    // 쿠키가 없으면 요청자가 그 세션의 주인임을 증명하지 못한 것이므로 아무 상태도 바꾸지 않는다 —
    // 유출된 id_token 하나로 남의 링크를 지울 수 있으면 back-channel logout 전파가 원격에서 무력화된다.
    // hint가 다른 포털 세션을 가리키는 경우도 남의 세션 종료 요청이라 거부한다.
    if (!sessionId || (link && link.portalSessionId !== sessionId)) {
      return reply.header('cache-control', 'no-store').redirect(target)
    }

    const idToken = await deleteSession(sessionId)
    reply.clearCookie(SESSION_COOKIE, { path: '/' })

    // 같은 포털 세션을 쓰던 다른 하위 앱들에게도 알린다(요청한 앱의 링크도 함께 정리된다).
    notifyPortalSessionsEnded([sessionId])

    const config = await getOidcConfig()
    const endSessionUrl = oidcClient.buildEndSessionUrl(config, {
      // Keycloak에는 포털 주소만 넘긴다. Keycloak의 portal 클라이언트에는 하위 앱 주소가
      // 등록돼 있지 않아 그대로 넘기면 "Invalid redirect uri"로 거부되고,
      // 그러면 Keycloak SSO 세션이 살아남아 다음 로그인이 자격증명 없이 통과한다.
      post_logout_redirect_uri: allowed ? backFromKeycloakUrl(client!.clientId, allowed, state) : PORTAL_HOME,
      ...(idToken ? { id_token_hint: idToken } : {}),
    })

    request.log.info({ clientId }, 'sso RP-initiated logout')

    return reply.header('cache-control', 'no-store').redirect(endSessionUrl.href)
  })

  /**
   * Keycloak 로그아웃을 마친 브라우저가 하위 앱으로 돌아가는 중간 지점.
   * 아무나 부를 수 있는 경로라 to를 다시 완전 일치로 검증한다 —
   * 검증을 빼면 포털이 그대로 open redirect가 된다.
   */
  app.get('/oidc/logout/callback', async (request, reply) => {
    const query = request.query as Record<string, unknown>

    const clientId = one(query.client_id)
    const client = clientId ? await findEnabledClient(clientId) : null
    const to = one(query.to)

    const target =
      client && matchExactUri(client.postLogoutRedirectUris, to)
        ? withState(to!, one(query.state))
        : PORTAL_HOME

    return reply.header('cache-control', 'no-store').redirect(target)
  })
}

/** Keycloak → 포털 → 하위 앱으로 되돌아오기 위한 포털 자신의 주소. */
function backFromKeycloakUrl(clientId: string, to: string, state: string | undefined): string {
  const url = new URL(`${PORTAL_HOME}/oidc/logout/callback`)
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('to', to)
  if (state) url.searchParams.set('state', state)
  return url.href
}
