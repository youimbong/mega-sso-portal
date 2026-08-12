import { date, pgTable, text, timestamp, varchar } from 'drizzle-orm/pg-core'

/**
 * A10 사원등록조회(api16S05)의 읽기 전용 미러.
 *
 * A10이 단일 원천이고 포털은 사번(code)을 유니크 키로 삼아 캐시만 한다. 포털에서 이 테이블을
 * 사람이 편집하는 화면은 만들지 않는다 — 고치려면 A10에서 고치고 다시 동기화한다.
 *
 * EIS의 hr_employee는 60여 컬럼을 다 미러하지만, 포털은 화면과 계정 생성에 실제로 쓰는
 * 필드만 둔다. 부서·사업장은 이름(deptNm/divNm)이 사원 응답에 함께 오므로 비정규화해서
 * 여기에 담는다 — 부서 테이블을 따로 만들 이유가 없다.
 */
export const hrEmployee = pgTable(
  'hr_employee',
  {
    /** 사원코드 = 사번 (A10 empCd). 다른 솔루션과 공유하는 유니크 키이자 upsert 키. */
    code: varchar('code', { length: 10 }).primaryKey(),
    /** 한글 성명 (A10 korNm). Keycloak firstName에 그대로 넣는다. */
    koreanName: text('korean_name').notNull(),
    /** 부서코드 (A10 deptCd). 소프트링크 — 부서 테이블은 만들지 않는다. */
    departmentCode: varchar('department_code', { length: 10 }),
    /** 부서명 (A10 deptNm). 직원 선택 화면에서 동명이인을 구분하는 유일한 단서다. */
    departmentName: text('department_name'),
    /** 사업장코드 (A10 divCd). 응답 자릿수가 7이라 넉넉히 10으로 둔다. */
    businessPlaceCode: varchar('business_place_code', { length: 10 }),
    /** 사업장명 (A10 divNm). */
    businessPlaceName: text('business_place_name'),
    /**
     * 직종명 (A10 htypNm). 지금은 화면에 띄우지 않는다 — 실측 99/101이 채워지지만 값이
     * "사무직" 한 종류뿐이라 사람을 구분하지 못한다. 직급명(hclsNm)은 아예 0/101이라
     * (extraColumns로 요청해도 0) 이쪽을 담아두고, 계열이 늘어나면 그때 화면에 쓴다.
     */
    jobTypeName: text('job_type_name'),
    /** 급여이메일 (A10 emalAdd). extraColumns:['emalAdd']를 요청해야 내려온다.
     *  계정 생성 시 Keycloak email의 기본값이다. 없으면 이메일 없이 만든다. */
    payrollEmail: text('payroll_email'),
    /** 재직구분 (A10 enrlFg). J01재직/J02파견/J03휴직/J04대기/J05퇴직.
     *  A10이 빈 값을 주면 EIS와 같게 'J01'로 본다. */
    employmentStatus: varchar('employment_status', { length: 3 }).notNull().default('J01'),
    /** 퇴사일 (A10 rtrDt, YYYYMMDD → date). 퇴직자 표시에만 쓴다. */
    resignationDate: date('resignation_date'),
    /** 이 행을 마지막으로 A10에서 받아 쓴 시각. 미러가 얼마나 낡았는지 화면에 보여준다. */
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // 인덱스를 두지 않는다. 유일한 검색이 `ilike '%q%'`라 btree를 못 타고, 재직구분은
  // 값이 5종뿐이라 planner가 고를 이유가 없다. 수천 행 규모에서는 seq scan으로 충분하다.
)

export type HrEmployee = typeof hrEmployee.$inferSelect
export type NewHrEmployee = typeof hrEmployee.$inferInsert
