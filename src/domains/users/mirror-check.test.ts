import { describe, expect, it } from 'vitest'

import { checkAgainstMirror, pickMirrorEmail } from './mirror-check.js'

const employee = { koreanName: '김승현', payrollEmail: 'kim@megastudy.net' }

describe('pickMirrorEmail', () => {
  it('빈 값은 이메일 없음으로 본다', () => {
    expect(pickMirrorEmail(null)).toEqual({ email: null, rejected: null })
    expect(pickMirrorEmail('   ')).toEqual({ email: null, rejected: null })
  })

  it('형식이 맞으면 그대로 쓴다', () => {
    expect(pickMirrorEmail(' kim@megastudy.net ')).toEqual({
      email: 'kim@megastudy.net',
      rejected: null,
    })
  })

  it('이메일 형식이 아니면 버리고 버린 값을 돌려준다', () => {
    // A10에 'test' 같은 값이 실제로 들어 있다. Keycloak은 이걸 400으로 거절한다.
    expect(pickMirrorEmail('test')).toEqual({ email: null, rejected: 'test' })
  })
})

describe('checkAgainstMirror', () => {
  it('미러가 없으면 대조하지 않는다', () => {
    expect(checkAgainstMirror({ account: { firstName: '홍길동' }, employee: null })).toEqual([])
  })

  it('성명이 다르면 잡아낸다', () => {
    expect(checkAgainstMirror({ account: { firstName: '김승', email: employee.payrollEmail }, employee })).toEqual([
      { field: 'firstName', account: '김승', mirror: '김승현' },
    ])
  })

  it('이메일이 다르면 잡아낸다', () => {
    expect(
      checkAgainstMirror({ account: { firstName: '김승현', email: 'old@megastudy.net' }, employee }),
    ).toEqual([{ field: 'email', account: 'old@megastudy.net', mirror: 'kim@megastudy.net' }])
  })

  it('미러에 이메일이 없으면 계정 이메일을 어긋난 것으로 보지 않는다', () => {
    expect(
      checkAgainstMirror({
        account: { firstName: '김승현', email: 'kept@megastudy.net' },
        employee: { koreanName: '김승현', payrollEmail: null },
      }),
    ).toEqual([])
  })

  it('미러 이메일이 형식이 아니면 대조 대상에서 뺀다', () => {
    expect(
      checkAgainstMirror({
        account: { firstName: '김승현', email: null },
        employee: { koreanName: '김승현', payrollEmail: 'test' },
      }),
    ).toEqual([])
  })

  it('같으면 빈 배열이다', () => {
    expect(
      checkAgainstMirror({ account: { firstName: '김승현', email: 'kim@megastudy.net' }, employee }),
    ).toEqual([])
  })
})
