# users 도메인 (사용자 관리)

포털에서 Keycloak 계정을 관리한다(`/admin/users*`). 소유 테이블 없음 — **계정은 Keycloak이 소유**하고,
`portal` 클라이언트의 service account로 Admin REST API를 호출한다. 그 계정 권한은
`query-users` / `view-users` / `view-realm` / `manage-users` 뿐이다 (`realm-admin` 없음).

## 파일

| 파일 | 역할 |
| --- | --- |
| `router.ts` | 목록/검색/직원선택/등록/상세/정보수정/사번연결/점검/역할/비밀번호/상태/세션/삭제 |
| `service.ts` | Keycloak Admin REST API 클라이언트 |
| `role-diff.ts` | 역할 체크박스 → add/remove (순수 함수, 테스트 있음) |
| `mirror-check.ts` | 계정 ↔ 미러 대조·급여이메일 형식 판정 (순수 함수, 테스트 있음) |
| `search-hint.ts` | 검색어가 사번꼴인지 판정 (순수 함수, 테스트 있음) |

## 공개 API (`index.ts`)

`usersRoutes`.
다른 도메인은 index.ts만 import한다. 내부 파일 직접 import 금지.

## 불변 규칙 (안전장치 — 테스트로 고정했거나 실제 검증됨)

- **관리 UI에 없는 역할은 절대 제거하지 않는다.** `diffRoles`가 제거 후보를 `assignable`로
  한정한다. `default-roles-mega`를 지우면 계정이 망가진다.
- **폼을 조작해 `realm-admin`을 밀어넣어도 무시한다.** 부여 대상도 `assignable`로 한정.
- **자기 자신은** `portal-admin` 제거·비활성화·삭제가 안 된다 (마지막 관리자 잠금 방지).
- **비활성화하면 세션도 함께 끊는다.** 안 끊으면 최대 10시간 계속 쓸 수 있다.
- **service account 계정은 목록에서 숨긴다.**
- **`federationLink`가 있는 외부(AD/LDAP) 사용자는 읽기 전용** — 비밀번호 변경·삭제 금지.

## 사번 연동 불변 규칙

- **계정↔사번의 원본은 Keycloak user attribute `employeeCode` 하나다.** 포털 DB에 계정 테이블도
  매핑 테이블도 만들지 않는다(이중 원본 금지). 읽을 때는 반드시 `employeeCodeOf()`를 쓴다.
- **계정 생성 후 사번이 실제로 저장됐는지 되읽어 확인한다.** realm의 User Profile에 `employeeCode`
  선언이 없으면 Keycloak은 attributes를 **201과 함께 조용히 버린다**. 확인에 실패하면 그 계정을
  지우고 `EmployeeCodeNotStoredError`를 던진다 — 사번 없는 반쪽 계정을 남기지 않는다.
- **성명·이메일은 폼에서 받지 않는다.** 직원 연동 등록은 사번만 받고, 서버가 `getEmployeeByCode`로
  미러를 다시 읽어 채운다. hidden 값을 믿으면 사번과 성명이 어긋난 계정이 생긴다.
- **한글 성명은 쪼개지 않는다.** `firstName`에 통째로 넣는다(2자 성씨 때문에 분리 규칙이 없다).
- **퇴직자(J05)에게는 새 계정을 발급하지 않는다.** 검색 목록에서 빠지고, 서버에서 한 번 더 막는다.
  단 **기존 계정을 동기화가 자동으로 잠그지는 않는다** — 상세의 `퇴직` 태그를 보고 관리자가 판단한다.
- **사번 중복은 `findUserByEmployeeCode`로 두 번 막는다** (폼 열 때 + 등록 직전). Keycloak은
  attribute 중복을 막지 않으므로 이 조회가 유일한 방어다. 경쟁 상태는 남으며, 목록의 사번 열로 발견한다.
- **직원 연결 없는 계정(시스템 계정)은 허용하되 우회 경로다.** `standalone=1`에서만 성명·이메일을
  수기 입력한다. 이 계정에는 `employeeCode` attribute가 없고 `employee_code` claim도 실리지 않는다.
  A10 동기화가 실패해도 새 관리자 계정을 만들 수 있어야 해서 남겨둔 경로다.
- **`listUsers`는 `briefRepresentation=false`로 호출한다.** 기본 응답에는 attributes가 빠져
  목록의 사번 열이 전부 비어 보인다.
- **직원 연동 계정의 성명·이메일은 화면에서 수기로 못 고친다.** A10이 원본이라 수기 입력을
  열어두면 미러와 계정이 말없이 갈라진다. 고치는 경로는 `POST /:id/employee/sync`
  (미러에서 다시 가져오기) 하나뿐이고, 직원 연결이 없는 별건 계정에서만 `POST /:id`로 고친다.
- **미러에 이메일이 없으면 계정 이메일을 지우지 않는다.** A10 급여이메일은 실측 101명 중
  100명이 비어 있다. "값 없음"을 "지워라"로 읽으면 쓰던 이메일이 사라진다.
- **A10 급여이메일이 이메일 형식이 아니면 버리고 알린다**(`pickMirrorEmail`). 그대로 넘기면
  Keycloak이 400 `error-invalid-email`로 거절해 계정을 아예 못 만든다.
- **사번을 나중에 붙일 때도 등록과 같은 검증을 쓴다**(`denyEmployeeCode`). 해제는 체크 확인을
  한 번 더 받고, 붙이고 떼는 것 모두 저장 결과를 되읽어 확인한다.
- **미러와 어긋난 계정을 자동으로 덮어쓰거나 잠그지 않는다.** `/admin/users/checkup`이
  퇴직(J05)·미러 없음·값 어긋남을 모아 보여주고, 반영은 관리자가 상세 화면에서 누른다.
- **컴포지트로 상속된 역할은 체크박스로 회수할 수 없다.** `default-roles-mega`에 `portal-user`가
  들어 있어 직접 매핑만 읽으면 "해제했다"고 말해놓고 그대로 남는다. `getEffectiveUserRoles`로
  함께 읽어 상속분은 checked+disabled로 표시한다.

## Keycloak PUT의 함정 (실측, KC 26)

- `PUT /users/{id}`에 **일부 필드만** 보내면 나머지는 남는다(`{"enabled":true}` → attributes 보존).
- 그러나 **`attributes`를 함께 보내면 그 표현이 전부다** — `{"attributes":{}}` 하나로
  `firstName`·`email`까지 지워졌다. 그래서 사번을 붙이고 떼는 경로는 현재 표현을 먼저 GET 해서
  병합한 뒤 PUT 한다(`service.ts`의 `mergeUpdate`/`setEmployeeCode`).
- 값을 **지울 때는 빈 문자열**을 보낸다. `null`은 "안 보낸 것"으로 취급돼 기존 값이 남는다.

## 의존

auth(index: `requireAdmin`, `getOidcConfig`), hr(index: `searchEmployees`, `getEmployeeByCode`,
`getEmployeesByCodes`, `isRetired`, `isSearchableTerm`, `missingA10Config`, `Employee`), shared(env).
