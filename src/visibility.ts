/**
 * 앱 노출 정책.
 * 앱에 지정된 역할이 하나도 없으면 로그인한 모두에게 보이고,
 * 있으면 그 중 하나라도 가진 사용자에게만 보인다.
 */
export function canSee(appRoles: readonly string[], userRoles: readonly string[]): boolean {
  if (appRoles.length === 0) return true
  return appRoles.some((role) => userRoles.includes(role))
}
