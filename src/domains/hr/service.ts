import { and, asc, count, eq, ilike, max, ne, or, sql } from 'drizzle-orm'

import { db } from '../../shared/db.js'
import { fetchAllEmployees } from './a10.js'
import { mapEmployee } from './map-employee.js'
import { hrEmployee } from './schema.js'

/** hr_employee 한 행. drizzle $inferSelect 그대로다. */
export type Employee = typeof hrEmployee.$inferSelect

export type SyncResult = {
  /** A10에서 받은 총 행 수 */
  fetched: number
  /** 미러에 insert/update된 행 수 (배치 내 중복 제거 후) */
  upserted: number
  /** empCd가 비어 건너뛴 행 수 */
  skipped: number
}

/** 퇴직 재직구분 코드. J01재직/J02파견/J03휴직/J04대기/J05퇴직. */
const RETIRED_STATUS = 'J05'

/** 한 INSERT에 넣을 행 수. postgres-js 파라미터 한도(행당 컬럼 12개)를 넉넉히 밑돈다. */
const UPSERT_CHUNK_SIZE = 500

/** 재직구분이 J05(퇴직)인가. 판정 로직을 한 곳에 묶는다. */
export function isRetired(employee: Employee): boolean {
  return employee.employmentStatus === RETIRED_STATUS
}

/** 직원 선택 목록에 한 번에 띄우는 수. 더 좁히려면 검색어를 더 치라는 뜻이다. */
const SEARCH_LIMIT = 20

/**
 * 사번·성명 부분일치 검색. 관리자 화면의 직원 선택 목록에 쓴다.
 * - q가 비었거나 2자 미만이면 빈 배열을 돌려준다(전건 로딩 방지).
 * - 퇴직자(J05)는 신규 발급 대상이 아니라 항상 제외한다.
 * - 검색어의 LIKE 와일드카드(%, _)는 이스케이프한다. 그냥 두면 '%'만 쳐도 전건이 걸린다.
 */
export async function searchEmployees(options: { q: string }): Promise<Employee[]> {
  const q = options.q.trim()
  if (q.length < 2) return []

  const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`
  const match = or(ilike(hrEmployee.code, pattern), ilike(hrEmployee.koreanName, pattern))

  return db
    .select()
    .from(hrEmployee)
    .where(and(match, ne(hrEmployee.employmentStatus, RETIRED_STATUS)))
    .orderBy(asc(hrEmployee.code))
    .limit(SEARCH_LIMIT)
}

/** 사번 정확 일치 1건. 없으면 null. 등록 시 서버측 재확인에 쓴다. */
export async function getEmployeeByCode(code: string): Promise<Employee | null> {
  const [row] = await db.select().from(hrEmployee).where(eq(hrEmployee.code, code)).limit(1)
  return row ?? null
}

/** 미러의 가장 최근 synced_at. 한 번도 동기화한 적 없으면 null. */
export async function getLastSyncedAt(): Promise<Date | null> {
  const [row] = await db.select({ value: max(hrEmployee.syncedAt) }).from(hrEmployee)
  return row?.value ?? null
}

/**
 * 동기화 화면에 띄우는 요약 수치. 도메인 밖에서 쓸 일이 없어 index.ts로는 내보내지 않는다.
 */
export async function getEmployeeCounts(): Promise<{ total: number; retired: number }> {
  const [row] = await db
    .select({
      total: count(),
      retired: count(sql`case when ${hrEmployee.employmentStatus} = ${RETIRED_STATUS} then 1 end`),
    })
    .from(hrEmployee)
  return { total: row?.total ?? 0, retired: row?.retired ?? 0 }
}

/**
 * A10 사원등록조회 전건을 받아 hr_employee에 upsert한다.
 * A10_* 자격증명(ACCESS_TOKEN/HASH_KEY/CALLER_NAME/GROUP_SEQ/CO_CD/API_BASE_URL) 중
 * 하나라도 없으면 호출 즉시 Error를 던진다(fail-fast).
 * 미러에서 행을 삭제하지 않는다 — A10에서 사라진 사원도 마지막 상태로 남는다.
 */
export async function syncEmployees(): Promise<SyncResult> {
  const records = await fetchAllEmployees()

  // 한 INSERT 문에 같은 code가 두 번 들어가면 PG가 에러를 낸다. 뒤에 온 행을 남긴다.
  const byCode = new Map<string, typeof hrEmployee.$inferInsert>()
  let skipped = 0
  for (const record of records) {
    const row = mapEmployee(record)
    if (!row) {
      skipped += 1
      continue
    }
    byCode.set(row.code, row)
  }

  const rows = [...byCode.values()]
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK_SIZE)
    await db
      .insert(hrEmployee)
      .values(chunk)
      .onConflictDoUpdate({
        target: hrEmployee.code,
        set: {
          koreanName: sql`excluded.korean_name`,
          departmentCode: sql`excluded.department_code`,
          departmentName: sql`excluded.department_name`,
          businessPlaceCode: sql`excluded.business_place_code`,
          businessPlaceName: sql`excluded.business_place_name`,
          jobTypeName: sql`excluded.job_type_name`,
          payrollEmail: sql`excluded.payroll_email`,
          employmentStatus: sql`excluded.employment_status`,
          resignationDate: sql`excluded.resignation_date`,
          syncedAt: sql`now()`,
        },
      })
  }

  return { fetched: records.length, upserted: rows.length, skipped }
}
