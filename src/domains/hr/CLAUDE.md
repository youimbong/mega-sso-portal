# hr 도메인 (직원 미러)

A10 사원등록조회(api16S05)를 받아 담는 읽기 전용 미러와 그 동기화 화면(`/admin/hr`).
사용자 등록 화면이 사번으로 직원을 고를 때 이 미러를 읽는다.

## 파일

| 파일 | 역할 |
| --- | --- |
| `router.ts` | `/admin/hr`, `POST /admin/hr/sync` |
| `service.ts` | 동기화·검색·조회 (`syncEmployees` / `searchEmployees` / `getEmployeeByCode` / `getLastSyncedAt`) |
| `a10.ts` | A10 인증 헤더 6종 + `/apiproxy/api16S05` POST + envelope 언랩 + 페이지 순회 |
| `a10-sign.ts` | wehago-sign HMAC·페이징 계산 (순수 함수, 테스트 있음) |
| `map-employee.ts` | A10 레코드 → 미러 행 변환 (순수 함수, 테스트 있음) |
| `schema.ts` | **소유 테이블: `hr_employee`** |

## 공개 API (`index.ts`)

`hrRoutes`, `syncEmployees`, `searchEmployees`, `getEmployeeByCode`, `getLastSyncedAt`,
`isRetired`, `Employee`, `SyncResult`.
users 도메인이 직원 선택에 `searchEmployees`/`getEmployeeByCode`를 쓴다.
다른 도메인은 index.ts만 import한다. 내부 파일(`a10.ts` 등) 직접 import 금지.

## 불변 규칙

- **A10이 단일 원천이다.** 포털은 A10에 쓰지 않고, `hr_employee`를 사람이 편집하는 화면도
  만들지 않는다. 고칠 것이 있으면 A10에서 고치고 다시 동기화한다.
- **미러에서 행을 지우지 않는다.** A10 응답이 부분적으로만 내려온 사고와 실제 삭제를 구분할
  방법이 없다. A10에서 사라진 사원도 마지막 상태로 남긴다.
- **동기화는 계정을 건드리지 않는다.** 퇴직(J05)이 되어도 Keycloak 계정을 자동 비활성화하지
  않는다 — 관리자가 화면에서 판단한다.
- 사번(`code`)이 upsert 키다. `empCd`가 빈 행은 건너뛴다(`SyncResult.skipped`).
- 재직구분이 비면 재직(`J01`)으로 본다. EIS와 같은 낙관적 기본값이다.
- A10_* 자격증명은 전부 optional이다 — 없어도 포털은 뜨고, `syncEmployees`를 부르는 순간
  누락된 키 이름을 실어 즉시 실패한다.
- 동기화는 관리자 수동 실행만이다. 스케줄러는 만들지 않는다.

## 의존

auth(index: `requireAdmin`), shared(db, env).
