import { describe, expect, it } from 'vitest'

import { looksLikeEmployeeCode } from './search-hint.js'

describe('looksLikeEmployeeCode', () => {
  it('숫자 4~10자리는 사번으로 본다', () => {
    expect(looksLikeEmployeeCode('2007031101')).toBe(true)
    expect(looksLikeEmployeeCode('1357990')).toBe(true)
    expect(looksLikeEmployeeCode(' 1357 ')).toBe(true)
  })

  it('너무 짧거나 긴 숫자는 사번으로 보지 않는다', () => {
    expect(looksLikeEmployeeCode('123')).toBe(false)
    expect(looksLikeEmployeeCode('12345678901')).toBe(false)
  })

  it('숫자가 아닌 문자가 섞이면 사번이 아니다', () => {
    expect(looksLikeEmployeeCode('admin')).toBe(false)
    expect(looksLikeEmployeeCode('2007-031')).toBe(false)
    expect(looksLikeEmployeeCode('')).toBe(false)
  })
})
