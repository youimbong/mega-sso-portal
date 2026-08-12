# portal 도메인 (홈 · embed)

로그인한 사용자에게 허용된 앱 목록(홈)과 iframe embed 화면. 소유 테이블 없음.

## 파일

| 파일 | 역할 |
| --- | --- |
| `router.ts` | `/`, `/apps/:slug` |
| `views/home.eta` | 앱 카드 목록 |
| `views/embed.eta` | iframe 화면 (layout 없이 독립 렌더) |

## 공개 API (`index.ts`)

`portalRoutes`.
다른 도메인은 index.ts만 import한다. 내부 파일 직접 import 금지.

## 불변 규칙

- 권한 없는 앱과 존재하지 않는 앱을 **같은 404**로 응답한다. 존재 여부를 노출하지 않는다.
- `mode: 'iframe'`인 앱만 embed한다. `link`는 홈에서 새 탭으로 연다.

## 의존

auth(index: `requireUser`), apps(index: `listVisibleApps`, `findVisibleApp`).
