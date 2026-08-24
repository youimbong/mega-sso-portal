/**
 * 검색어가 사번처럼 보이는가.
 *
 * Keycloak의 `search=`는 username/email/firstName/lastName만 훑고 attribute는 보지 않는다.
 * 그래서 목록에 사번 열을 띄워 놓고도 사번으로는 검색되지 않았다. 사번꼴 검색어는
 * `findUserByEmployeeCode`로 한 건 더 찾아 결과에 합친다.
 *
 * A10 사번은 숫자만 쓰고 hr_employee.code가 varchar(10)이다. 4자 미만은 사번으로 보지 않는다 —
 * 짧은 숫자는 아이디·이름 검색일 가능성이 더 크고, 어차피 그쪽 검색이 함께 돈다.
 */
export function looksLikeEmployeeCode(q: string): boolean {
  return /^[0-9]{4,10}$/.test(q.trim())
}
