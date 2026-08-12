/**
 * 역할 체크박스 상태를 Keycloak에 보낼 add/remove 목록으로 바꾼다.
 *
 * 핵심은 `assignable` 교집합이다. 관리 UI가 보여주지 않는 역할
 * (`default-roles-mega`, `offline_access` 등)은 화면에 체크박스가 없으므로
 * 그대로 두면 "체크 해제됨"으로 오인되어 제거된다. 그러면 계정이 망가진다.
 * 그래서 제거 후보를 assignable 안으로 한정한다.
 */
export function diffRoles(input: {
  assignable: readonly string[]
  current: readonly string[]
  desired: readonly string[]
}): { add: string[]; remove: string[] } {
  const assignable = new Set(input.assignable)
  const current = new Set(input.current)
  const desired = new Set(input.desired.filter((r) => assignable.has(r)))

  return {
    add: [...desired].filter((r) => !current.has(r)).sort(),
    remove: [...current].filter((r) => assignable.has(r) && !desired.has(r)).sort(),
  }
}
