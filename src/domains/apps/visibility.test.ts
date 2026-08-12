import { describe, expect, it } from 'vitest'

import { canSee } from './visibility.js'

describe('canSee', () => {
  it('역할 제한이 없는 앱은 모두에게 보인다', () => {
    expect(canSee([], [])).toBe(true)
    expect(canSee([], ['portal-user'])).toBe(true)
  })

  it('역할이 하나라도 겹치면 보인다', () => {
    expect(canSee(['hr-team'], ['portal-user', 'hr-team'])).toBe(true)
    expect(canSee(['hr-team', 'finance'], ['finance'])).toBe(true)
  })

  it('겹치는 역할이 없으면 보이지 않는다', () => {
    expect(canSee(['hr-team'], ['portal-user'])).toBe(false)
    expect(canSee(['hr-team'], [])).toBe(false)
  })

  it('portal-admin 이라고 해서 자동으로 보이지는 않는다', () => {
    // 관리자는 카탈로그를 관리할 뿐, 남의 업무 앱에 자동 접근권을 갖지 않는다.
    expect(canSee(['hr-team'], ['portal-admin'])).toBe(false)
  })
})
