/**
 * 직원 검색어가 조회를 돌릴 만큼 좁은가.
 *
 * 라틴 문자·숫자는 2자 이상을 요구한다(사번 앞 2자리만 쳐도 후보가 크게 준다).
 * 한글은 1자도 허용한다 — 한글 한 글자는 라틴 두 글자만큼 후보를 좁히고,
 * 성 한 글자로 찾는 빈도가 높다. 상한은 SEARCH_LIMIT이 따로 막는다.
 */
export function isSearchableTerm(q: string): boolean {
  const trimmed = q.trim()
  if (trimmed.length === 0) return false
  if (/[가-힣]/.test(trimmed)) return true
  return trimmed.length >= 2
}
