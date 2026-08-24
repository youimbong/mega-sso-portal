import { describe, expect, it } from 'vitest'

import { isSearchableTerm } from './search-terms.js'

describe('isSearchableTerm', () => {
  it('빈 문자열과 공백만 있는 검색어는 막는다', () => {
    expect(isSearchableTerm('')).toBe(false)
    expect(isSearchableTerm('   ')).toBe(false)
  })

  it('한글은 1자도 허용한다', () => {
    // 성 한 글자로 찾는 빈도가 높다.
    expect(isSearchableTerm('김')).toBe(true)
    expect(isSearchableTerm(' 김 ')).toBe(true)
  })

  it('라틴 문자·숫자는 2자 이상만 허용한다', () => {
    expect(isSearchableTerm('a')).toBe(false)
    expect(isSearchableTerm('2')).toBe(false)
    expect(isSearchableTerm('20')).toBe(true)
    expect(isSearchableTerm('ho')).toBe(true)
  })

  it('한글이 섞여 있으면 1자 규칙을 적용한다', () => {
    expect(isSearchableTerm('김a')).toBe(true)
  })
})
