# apps 도메인 (앱 카탈로그)

포털에 노출할 앱의 카탈로그 관리(`/admin/apps`)와 노출 정책. 계정·권한 자체는 Keycloak 소유.

## 파일

| 파일 | 역할 |
| --- | --- |
| `router.ts` | `/admin/apps*` (htmx 조각 렌더) |
| `service.ts` | 카탈로그 조회/등록/삭제/토글 |
| `visibility.ts` | 노출 정책 `canSee` (순수 함수, 테스트 있음) |
| `schema.ts` | **소유 테이블: `apps`, `app_roles`** |

## 공개 API (`index.ts`)

`appsRoutes`, `listVisibleApps`, `findVisibleApp`, `AppWithRoles`.
portal 도메인이 홈 목록에 `listVisibleApps`/`findVisibleApp`을 쓴다.
다른 도메인은 index.ts만 import한다. 내부 파일 직접 import 금지.

## 불변 규칙

- 앱에 노출 역할이 하나도 없으면 = 로그인한 **모두에게** 보인다 (`canSee`).
- `portal-admin`은 카탈로그 관리 권한일 뿐, 남의 업무 앱에 자동 접근권을 주지 않는다.
- 뷰는 htmx 부분 갱신 구조다: `form`/`table`은 조각, `after-create`는 out-of-band swap.

## 의존

auth(index: `requireAdmin`), shared(db).
