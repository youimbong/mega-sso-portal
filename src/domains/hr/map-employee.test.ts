import { describe, expect, it } from 'vitest'

import { mapEmployee } from './map-employee.js'

describe('mapEmployee', () => {
  it('사번이 없으면 null을 돌려준다', () => {
    // 사번이 upsert 키라 사번 없는 행은 미러에 넣을 수 없다.
    expect(mapEmployee({ empCd: '', korNm: '홍길동' })).toBeNull()
    expect(mapEmployee({ korNm: '홍길동' })).toBeNull()
  })

  it('컬럼 폭을 넘는 행은 null을 돌려준다', () => {
    // 한 행만 넘쳐도 그 행이 낀 chunk의 INSERT가 통째로 실패해 동기화 전체가 죽는다.
    expect(mapEmployee({ empCd: '12345678901', korNm: '홍길동' })).toBeNull()
    expect(mapEmployee({ empCd: '1234567890', korNm: '홍길동' })).not.toBeNull()
    expect(mapEmployee({ empCd: '12345', enrlFg: 'J051' })).toBeNull()
  })

  it('A10의 빈 문자열은 null로 바꾼다', () => {
    const row = mapEmployee({ empCd: '12345', korNm: '홍길동', deptNm: '', emalAdd: '' })
    expect(row?.departmentName).toBeNull()
    expect(row?.payrollEmail).toBeNull()
  })

  it('YYYYMMDD 퇴사일을 date 문자열로 바꾼다', () => {
    expect(mapEmployee({ empCd: '12345', rtrDt: '20250131' })?.resignationDate).toBe('2025-01-31')
  })

  it('퇴사일이 비었거나 형식이 다르면 null이다', () => {
    expect(mapEmployee({ empCd: '12345', rtrDt: '' })?.resignationDate).toBeNull()
    expect(mapEmployee({ empCd: '12345' })?.resignationDate).toBeNull()
    expect(mapEmployee({ empCd: '12345', rtrDt: '2025-01-31' })?.resignationDate).toBeNull()
  })

  it('재직구분이 비면 재직(J01)으로 본다', () => {
    expect(mapEmployee({ empCd: '12345', enrlFg: '' })?.employmentStatus).toBe('J01')
    expect(mapEmployee({ empCd: '12345' })?.employmentStatus).toBe('J01')
    expect(mapEmployee({ empCd: '12345', enrlFg: 'J05' })?.employmentStatus).toBe('J05')
  })

  it('성명이 없어도 행을 버리지 않는다', () => {
    // koreanName은 notNull이다. 행을 버리면 그 사번이 미러에서 통째로 사라진다.
    expect(mapEmployee({ empCd: '12345' })?.koreanName).toBe('')
  })

  it('A10 필드를 미러 컬럼에 옮겨 담는다', () => {
    const row = mapEmployee({
      empCd: '12345',
      korNm: '홍길동',
      deptCd: 'D01',
      deptNm: '인사팀',
      divCd: '1000000',
      divNm: '본사',
      htypNm: '사무직',
      emalAdd: 'hong@example.com',
      enrlFg: 'J01',
    })

    expect(row).toMatchObject({
      code: '12345',
      koreanName: '홍길동',
      departmentCode: 'D01',
      departmentName: '인사팀',
      businessPlaceCode: '1000000',
      businessPlaceName: '본사',
      jobTypeName: '사무직',
      payrollEmail: 'hong@example.com',
      employmentStatus: 'J01',
    })
  })
})
