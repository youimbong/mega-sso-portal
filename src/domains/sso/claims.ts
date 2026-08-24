/**
 * 포털 세션 → 하위 앱 토큰 claim 매핑.
 * iss/iat/exp/jti는 서명 시점에 tokens.ts가 붙인다. 여기서는 시간에 의존하지 않는 값만 만든다.
 */

export type PortalIdentity = {
  sub: string
  email: string | null
  name: string | null
  /** Keycloak의 preferred_username. 표시용 성명(name)과 다른 값이다. */
  username: string | null
  roles: string[]
  employeeCode: string | null
}

export function buildIdTokenClaims(input: {
  identity: PortalIdentity
  clientId: string
  sid: string
  scope: string[]
  nonce: string | null
}): Record<string, unknown> {
  const { identity, scope } = input

  return {
    sub: identity.sub,
    aud: input.clientId,
    sid: input.sid,
    ...(input.nonce ? { nonce: input.nonce } : {}),
    ...profileClaims(identity, scope),
    ...emailClaims(identity, scope),
    ...employeeClaims(identity, scope),
    ...rolesClaims(identity, scope),
  }
}

export function buildUserinfoClaims(
  identity: PortalIdentity,
  scope: string[],
): Record<string, unknown> {
  return {
    sub: identity.sub,
    ...profileClaims(identity, scope),
    ...emailClaims(identity, scope),
    ...employeeClaims(identity, scope),
    ...rolesClaims(identity, scope),
  }
}

function profileClaims(identity: PortalIdentity, scope: string[]): Record<string, unknown> {
  if (!scope.includes('profile')) return {}

  // preferred_username 에 표시용 성명을 실으면 안 된다 — A10 연동 계정은 성명이 한글 이름이라
  // 동명이인 두 계정이 같은 값을 내보내고, 그 값을 로그인 키로 쓰는 하위 앱이 둘을 한 사람으로 합친다.
  // username 컬럼이 없는 옛 세션은 틀린 값을 싣느니 키를 아예 뺀다.
  return {
    ...(identity.name ? { name: identity.name } : {}),
    ...(identity.username ? { preferred_username: identity.username } : {}),
  }
}

function emailClaims(identity: PortalIdentity, scope: string[]): Record<string, unknown> {
  if (!scope.includes('email') || !identity.email) return {}
  // 포털은 이메일을 검증하지 않는다. true로 거짓말하지 않는다.
  return { email: identity.email, email_verified: false }
}

function employeeClaims(identity: PortalIdentity, scope: string[]): Record<string, unknown> {
  // 사번도 신원 정보다. profile을 요청하지 않은 앱에 딸려 나가면 최소권한이 아니다.
  if (!scope.includes('profile') || !identity.employeeCode) return {}
  // claim 이름은 Keycloak의 mapper와 같게 둔다 — 하위 앱이 Keycloak 직결에서 포털 경유로 바뀌어도 안 바뀐다.
  return { employee_code: identity.employeeCode }
}

function rolesClaims(identity: PortalIdentity, scope: string[]): Record<string, unknown> {
  // discovery의 scopes_supported가 roles를 광고한다. 광고한 대로 scope로 통제한다 —
  // 요청하지 않은 앱에 realm role 전체를 실어 보내지 않는다.
  if (!scope.includes('roles')) return {}
  // 최상위 roles 배열 하나만 쓴다. realm_access를 흉내내면 하위 앱이 어느 계약을 믿어야 할지 모호해진다.
  return { roles: identity.roles }
}
