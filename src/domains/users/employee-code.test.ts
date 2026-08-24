import { describe, expect, it } from 'vitest'

import { findConflictingUser, type EmployeeCodeHolder } from './employee-code.js'

const me: EmployeeCodeHolder = { id: 'u1', username: 'kim.ms1', employeeCode: '2007031101' }
const other: EmployeeCodeHolder = { id: 'u2', username: 'kim.ms2', employeeCode: '2007031101' }

describe('findConflictingUser', () => {
  it('나 혼자 그 사번을 쓰면 충돌이 없다', () => {
    expect(findConflictingUser([me], 'u1', '2007031101')).toBeNull()
  })

  it('같은 사번의 다른 계정이 있으면 그 계정을 돌려준다', () => {
    expect(findConflictingUser([me, other], 'u1', '2007031101')?.username).toBe('kim.ms2')
  })

  it('사번이 다른 계정은 충돌이 아니다', () => {
    const stranger: EmployeeCodeHolder = { id: 'u3', username: 'lee', employeeCode: '2007031102' }
    expect(findConflictingUser([me, stranger], 'u1', '2007031101')).toBeNull()
  })

  it('사번이 없는 계정은 충돌이 아니다', () => {
    const nobody: EmployeeCodeHolder = { id: 'u4', username: 'sys', employeeCode: null }
    expect(findConflictingUser([nobody], 'u1', '2007031101')).toBeNull()
  })

  it('결과가 비어 있으면 null이다', () => {
    expect(findConflictingUser([], 'u1', '2007031101')).toBeNull()
  })
})
