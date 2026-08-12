import * as client from 'openid-client'

import { env, issuerIsInsecure } from '../../shared/env.js'

let configPromise: Promise<client.Configuration> | undefined

/** Keycloak discovery 결과는 프로세스 단위로 캐시한다. 매 요청마다 받아올 이유가 없다. */
export function getOidcConfig(): Promise<client.Configuration> {
  configPromise ??= client.discovery(
    new URL(env.OIDC_ISSUER),
    env.OIDC_CLIENT_ID,
    env.OIDC_CLIENT_SECRET,
    undefined,
    // 로컬 개발의 http://localhost:8080 issuer를 허용한다. 운영은 https라 이 분기를 타지 않는다.
    issuerIsInsecure ? { execute: [client.allowInsecureRequests] } : undefined,
  )
  return configPromise
}

export const REDIRECT_URI = `${env.APP_BASE_URL}/api/auth/callback`

/** Keycloak ID token에서 우리가 실제로 읽는 claim들. */
export type IdTokenClaims = {
  sub: string
  sid?: string
  email?: string
  name?: string
  preferred_username?: string
  realm_access?: { roles?: string[] }
}

export function readClaims(claims: Record<string, unknown>): IdTokenClaims {
  return claims as IdTokenClaims
}

/** realm role 목록. Keycloak 기본 `roles` client scope가 realm_access를 넣어준다. */
export function rolesOf(claims: IdTokenClaims): string[] {
  return claims.realm_access?.roles ?? []
}
