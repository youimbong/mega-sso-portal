# users 도메인 (사용자 관리)

포털에서 Keycloak 계정을 관리한다(`/admin/users*`). 소유 테이블 없음 — **계정은 Keycloak이 소유**하고,
`portal` 클라이언트의 service account로 Admin REST API를 호출한다. 그 계정 권한은
`query-users` / `view-users` / `view-realm` / `manage-users` 뿐이다 (`realm-admin` 없음).

## 파일

| 파일 | 역할 |
| --- | --- |
| `router.ts` | 목록/검색/등록/상세/역할/비밀번호/상태/세션/삭제 |
| `service.ts` | Keycloak Admin REST API 클라이언트 |
| `role-diff.ts` | 역할 체크박스 → add/remove (순수 함수, 테스트 있음) |

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

## 의존

auth(index: `requireAdmin`, `getOidcConfig`), shared(env).
