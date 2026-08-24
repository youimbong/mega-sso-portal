/**
 * 사번 중복 판정.
 *
 * 등록 전 조회와 실제 저장 사이에는 잠금이 없고 Keycloak도 attribute 중복을 막지 않는다
 * (같은 사번으로 두 번 POST 해도 201). 두 관리자가 거의 동시에 같은 사번을 등록하면
 * 둘 다 사전 검사를 통과해 사번이 같은 계정이 두 개 만들어진다.
 * 저장한 뒤 한 번 더 읽어 "나 말고 같은 사번을 쓰는 계정"이 잡히면 늦게 도착한 쪽이 물러난다.
 */
export type EmployeeCodeHolder = { id: string; username: string; employeeCode: string | null }

/** 없으면 null. Keycloak의 `q` 검색 결과에 다른 값이 섞여 와도 사번을 다시 대조한다. */
export function findConflictingUser(
  users: readonly EmployeeCodeHolder[],
  selfId: string,
  code: string,
): EmployeeCodeHolder | null {
  return users.find((u) => u.id !== selfId && u.employeeCode === code) ?? null
}
