import type { A10EmployeeRecord } from './a10.js'
import type { hrEmployee } from './schema.js'

/** A10은 값이 없을 때 undefined가 아니라 빈 문자열을 준다. DB에는 null로 넣는다. */
function value(input: string | undefined): string | null {
  return input === undefined || input === '' ? null : input
}

/** A10 날짜는 YYYYMMDD 문자열이다. 형식이 다르면(빈 값 포함) null로 본다. */
function dateValue(input: string | undefined): string | null {
  if (input === undefined || !/^\d{8}$/.test(input)) return null
  return `${input.slice(0, 4)}-${input.slice(4, 6)}-${input.slice(6, 8)}`
}

/**
 * A10 레코드 → 미러 행. I/O 없는 순수 변환이라 여기만 테스트한다.
 *
 * null을 돌려주면 호출자가 skip 카운트한다. 두 경우다:
 * - empCd가 없다 — 사번이 upsert 키라 사번 없는 행은 미러에 넣을 수 없다.
 * - 컬럼 폭을 넘는다 — 한 행만 넘쳐도 그 행이 낀 chunk의 INSERT가 통째로 실패해
 *   동기화 전체가 죽는다. 망가진 한 건 때문에 나머지 전부를 잃지 않는다.
 */
export function mapEmployee(
  record: A10EmployeeRecord,
): typeof hrEmployee.$inferInsert | null {
  const code = value(record.empCd)
  if (!code || code.length > 10) return null

  const employmentStatus = value(record.enrlFg) ?? 'J01'
  if (employmentStatus.length > 3) return null

  return {
    code,
    // 성명은 notNull이다. A10이 빈 값을 주는 일은 없어야 하지만, 그때도 행을 버리지 않고
    // 빈 문자열로 넣어 관리자가 화면에서 이상을 알아채게 한다.
    koreanName: value(record.korNm) ?? '',
    departmentCode: value(record.deptCd),
    departmentName: value(record.deptNm),
    businessPlaceCode: value(record.divCd),
    businessPlaceName: value(record.divNm),
    jobTypeName: value(record.htypNm),
    payrollEmail: value(record.emalAdd),
    // 재직구분이 비면 EIS와 같게 재직(J01)으로 본다.
    employmentStatus,
    resignationDate: dateValue(record.rtrDt),
    syncedAt: new Date(),
  }
}
