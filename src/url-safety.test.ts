import { describe, expect, it } from 'vitest'

import { safeReturnTo } from './url-safety.js'

describe('safeReturnTo', () => {
  it('사이트 내부 절대경로는 그대로 통과시킨다', () => {
    expect(safeReturnTo('/')).toBe('/')
    expect(safeReturnTo('/admin/apps')).toBe('/admin/apps')
    expect(safeReturnTo('/apps/groupware?tab=1')).toBe('/apps/groupware?tab=1')
  })

  it('외부 도메인으로의 리다이렉트를 막는다', () => {
    expect(safeReturnTo('https://evil.com')).toBe('/')
    expect(safeReturnTo('//evil.com')).toBe('/')
    expect(safeReturnTo('/\\evil.com')).toBe('/')
    expect(safeReturnTo('http://localhost:3100/')).toBe('/')
  })

  it('경로가 아니거나 문자열이 아니면 루트로 보낸다', () => {
    expect(safeReturnTo('admin')).toBe('/')
    expect(safeReturnTo(undefined)).toBe('/')
    expect(safeReturnTo(null)).toBe('/')
    expect(safeReturnTo(['/a'])).toBe('/')
  })
})
