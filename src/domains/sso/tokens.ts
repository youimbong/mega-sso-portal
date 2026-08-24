import { randomUUID } from 'node:crypto'

import { createLocalJWKSet, jwtVerify, SignJWT, type JWTPayload } from 'jose'

import { env } from '../../shared/env.js'
import { getPublicJwks, getSigningKey } from './keys.js'
import { issuerOf } from './metadata.js'

export const ID_TOKEN_TTL_S = 300
export const ACCESS_TOKEN_TTL_S = 300
/** logout token은 수신 즉시 처리되는 값이라 짧게 둔다. */
export const LOGOUT_TOKEN_TTL_S = 120

export const ISSUER = issuerOf(env.APP_BASE_URL)

export const BACKCHANNEL_EVENT = 'http://schemas.openid.net/event/backchannel-logout'

/**
 * 자기 서명 토큰 검증용 공개키.
 * 회전 코드가 없으므로 프로세스 캐시를 무효화하지 않는다 — 키를 추가하면 재기동이 필요하다.
 */
let localJwks: ReturnType<typeof createLocalJWKSet> | undefined

async function getLocalJwks() {
  localJwks ??= createLocalJWKSet(await getPublicJwks())
  return localJwks
}

export async function signIdToken(claims: Record<string, unknown>): Promise<string> {
  const { kid, privateKey } = await getSigningKey()

  return new SignJWT(claims as JWTPayload)
    .setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' })
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${ID_TOKEN_TTL_S}s`)
    .sign(privateKey)
}

/**
 * access token에는 신원 claim을 담지 않는다 —
 * 토큰이 로그에 남았을 때 개인정보가 함께 새지 않게 한다. 신원은 userinfo로만 준다.
 */
export async function signAccessToken(input: {
  sub: string
  clientId: string
  sid: string
  scope: string[]
}): Promise<string> {
  const { kid, privateKey } = await getSigningKey()

  return new SignJWT({ sid: input.sid, scope: input.scope.join(' ') })
    .setProtectedHeader({ alg: 'RS256', kid, typ: 'at+jwt' })
    .setIssuer(ISSUER)
    .setSubject(input.sub)
    .setAudience(input.clientId)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_S}s`)
    .sign(privateKey)
}

/**
 * typ 검사를 반드시 유지하라 — 없으면 id_token을 access token으로 재생할 수 있다.
 * aud는 검사하지 않는다: userinfo는 어느 클라이언트의 토큰인지 미리 알 수 없고,
 * 실제 인가 판단은 sid로 포털 세션 생존을 확인하는 쪽이 한다.
 */
export async function verifyAccessToken(
  token: string,
): Promise<{ sub: string; sid: string; scope: string[] } | null> {
  try {
    const { payload } = await jwtVerify(token, await getLocalJwks(), {
      issuer: ISSUER,
      typ: 'at+jwt',
      algorithms: ['RS256'],
    })

    const sid = payload.sid
    if (typeof payload.sub !== 'string' || typeof sid !== 'string') return null

    const scope = typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : []
    return { sub: payload.sub, sid, scope }
  } catch {
    return null
  }
}

/**
 * RP-initiated logout의 id_token_hint 검증.
 * 만료는 무시한다 — 로그아웃 시점에 id_token이 이미 만료된 것이 정상이다.
 * 대신 typ은 반드시 고정한다: 없으면 at+jwt(access token)와 logout+jwt까지 hint로 통과하는데,
 * 그 둘은 id_token보다 노출 지점이 넓다(헤더로 매 요청 오가고, 하위 앱으로 발송된다).
 */
export async function verifyIdTokenHint(
  token: string,
): Promise<{ clientId: string; sid: string } | null> {
  try {
    const { payload } = await jwtVerify(token, await getLocalJwks(), {
      issuer: ISSUER,
      typ: 'JWT',
      algorithms: ['RS256'],
      currentDate: new Date(0),
    })

    const aud = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud
    const sid = payload.sid
    if (typeof aud !== 'string' || typeof sid !== 'string') return null

    return { clientId: aud, sid }
  } catch {
    return null
  }
}

/** back-channel logout token. nonce를 절대 넣지 않는다(스펙 요구: id_token 재사용 방지). */
export async function signLogoutToken(input: {
  clientId: string
  sub: string
  sid: string
}): Promise<string> {
  const { kid, privateKey } = await getSigningKey()

  return new SignJWT({ sid: input.sid, events: { [BACKCHANNEL_EVENT]: {} } })
    .setProtectedHeader({ alg: 'RS256', kid, typ: 'logout+jwt' })
    .setIssuer(ISSUER)
    .setSubject(input.sub)
    .setAudience(input.clientId)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${LOGOUT_TOKEN_TTL_S}s`)
    .sign(privateKey)
}
