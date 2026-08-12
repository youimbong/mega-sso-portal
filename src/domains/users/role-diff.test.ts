import { describe, expect, it } from 'vitest'

import { diffRoles } from './role-diff.js'

const assignable = ['portal-admin', 'portal-user', 'hr-team']

describe('diffRoles', () => {
  it('새로 체크한 역할만 add에 담는다', () => {
    expect(
      diffRoles({ assignable, current: ['portal-user'], desired: ['portal-user', 'hr-team'] }),
    ).toEqual({ add: ['hr-team'], remove: [] })
  })

  it('체크 해제한 역할만 remove에 담는다', () => {
    expect(
      diffRoles({ assignable, current: ['portal-user', 'hr-team'], desired: ['portal-user'] }),
    ).toEqual({ add: [], remove: ['hr-team'] })
  })

  it('관리 UI에 없는 역할은 절대 제거하지 않는다', () => {
    // default-roles-mega는 체크박스가 없다. 이걸 지우면 계정이 망가진다.
    expect(
      diffRoles({
        assignable,
        current: ['default-roles-mega', 'offline_access', 'portal-user'],
        desired: ['portal-user'],
      }),
    ).toEqual({ add: [], remove: [] })
  })

  it('assignable에 없는 역할을 desired로 밀어넣어도 무시한다', () => {
    // 폼을 조작해 realm-admin 같은 역할을 보내도 부여되지 않는다.
    expect(
      diffRoles({ assignable, current: [], desired: ['realm-admin', 'hr-team'] }),
    ).toEqual({ add: ['hr-team'], remove: [] })
  })

  it('변경이 없으면 둘 다 비어 있다', () => {
    expect(diffRoles({ assignable, current: ['hr-team'], desired: ['hr-team'] })).toEqual({
      add: [],
      remove: [],
    })
  })

  it('전부 해제하면 assignable 범위 안에서만 제거한다', () => {
    expect(
      diffRoles({
        assignable,
        current: ['default-roles-mega', 'portal-admin', 'hr-team'],
        desired: [],
      }),
    ).toEqual({ add: [], remove: ['hr-team', 'portal-admin'] })
  })
})
