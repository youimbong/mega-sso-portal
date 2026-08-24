import { createHash } from 'node:crypto'

/**
 * client_id로 쓸 수 없는 이름.
 * Keycloak realm에 이미 `portal` clientId가 있고, 포털의 경로 이름과 겹치면 혼동이 사고로 이어진다.
 */
export const RESERVED_CLIENT_IDS = new Set([
  'portal',
  'admin',
  'api',
  'static',
  'apps',
  'oidc',
  'healthz',
  'account',
  'security-admin-console',
  'admin-cli',
  'broker',
  'realm-management',
])

export function isReservedClientId(clientId: string): boolean {
  return RESERVED_CLIENT_IDS.has(clientId)
}

/**
 * 등록된 URI와 **완전 문자열 일치**만 통과시킨다.
 * 와일드카드·prefix·대소문자 무시를 넣지 마라 — OP의 가장 흔한 취약점이 느슨한 redirect 매칭이다.
 * redirect_uri와 post_logout_redirect_uri가 같은 규칙이라 함수를 하나만 둔다.
 */
export function matchExactUri(registered: readonly string[], candidate: string | undefined): boolean {
  if (!candidate) return false
  return registered.includes(candidate)
}

/**
 * 등록된 post-logout URI에 하위 앱이 보낸 state를 얹는다.
 * 등록값 자체에 state가 들어 있으면 요청 값으로 덮는다 — 하위 앱이 돌려받길 기대하는 쪽이 요청 값이다.
 */
export function withState(uri: string, state: string | undefined): string {
  if (!state) return uri

  const url = new URL(uri)
  url.searchParams.set('state', state)
  return url.href
}

/** required가 비어 있으면 로그인한 모두 허용. 하나라도 겹치면 통과. */
export function hasRequiredRoles(required: readonly string[], userRoles: readonly string[]): boolean {
  if (required.length === 0) return true
  return required.some((role) => userRoles.includes(role))
}

/** 공백 분리·중복 제거·정렬. 응답의 scope 문자열도 이 결과를 그대로 쓴다. */
export function normalizeScope(raw: string | undefined): string[] {
  if (!raw) return []
  return [...new Set(raw.split(/\s+/).filter(Boolean))].sort()
}

/**
 * `Authorization: Basic <b64>` → client_id/client_secret.
 * RFC 6749 2.3.1 대로 두 값은 form-urlencoded 되어 있으므로 디코딩한다.
 */
export function parseBasicAuth(
  header: string | undefined,
): { clientId: string; clientSecret: string } | null {
  if (!header) return null

  const match = /^Basic +([A-Za-z0-9+/]+={0,2})$/i.exec(header.trim())
  if (!match) return null

  const decoded = Buffer.from(match[1]!, 'base64').toString('utf8')
  const sep = decoded.indexOf(':')
  if (sep < 0) return null

  try {
    const clientId = decodeURIComponent(decoded.slice(0, sep))
    const clientSecret = decodeURIComponent(decoded.slice(sep + 1))
    if (!clientId || !clientSecret) return null
    return { clientId, clientSecret }
  } catch {
    // 퍼센트 인코딩이 깨진 헤더. 인증 실패로 다룬다.
    return null
  }
}

/** PKCE S256. 양쪽 다 공개값이라 timingSafeEqual이 필요 없다. */
export function verifyPkceS256(codeChallenge: string, codeVerifier: string | undefined): boolean {
  if (!codeVerifier) return false
  // RFC 7636 4.1의 길이 제한. 짧은 verifier를 받아주면 PKCE가 무력해진다.
  if (codeVerifier.length < 43 || codeVerifier.length > 128) return false
  if (!/^[A-Za-z0-9\-._~]+$/.test(codeVerifier)) return false

  return createHash('sha256').update(codeVerifier).digest('base64url') === codeChallenge
}

/** 관리 화면의 줄바꿈 구분 URI 입력. */
export function parseUriList(raw: string | undefined): string[] {
  if (!raw) return []
  return [...new Set(raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))]
}

/** 관리 화면의 쉼표 구분 역할 입력. apps 도메인의 parseRoles와 같은 규칙이다. */
export function parseRoleList(raw: string | undefined): string[] {
  if (!raw) return []
  return [...new Set(raw.split(',').map((role) => role.trim()).filter(Boolean))]
}

/**
 * 개발 환경 예외로만 http를 허용할 호스트.
 * 브라우저도 loopback은 secure context로 취급한다.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * 등록하려는 redirect URI 검사. 통과면 null, 아니면 사용자에게 보여줄 사유.
 * portalOrigin(포털 자신)을 막는 이유: 포털을 자기 자신의 RP로 등록하면 인가 루프가 된다.
 * loopback 외에는 https를 요구한다 — 인가 코드와 state가 쿼리스트링으로 오가므로
 * 사내망이라도 평문 http면 중간에서 코드를 가로채 토큰까지 받아갈 수 있다.
 */
export function redirectUriError(uri: string, portalOrigin: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    return `${uri} 는 절대 URL이 아니다`
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `${uri} 는 http 또는 https 주소여야 한다`
  }
  if (parsed.protocol === 'http:' && !LOOPBACK_HOSTS.has(parsed.hostname)) {
    return `${uri} 는 https여야 한다 (http는 localhost 같은 loopback 주소에서만 허용한다)`
  }
  // RFC 6749 3.1.2 — redirect_uri에 fragment를 둘 수 없다.
  if (parsed.hash) return `${uri} 에 fragment(#)를 쓸 수 없다`
  if (parsed.origin === portalOrigin) return `${uri} 는 포털 자신의 주소다`

  return null
}
