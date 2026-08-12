# auth 도메인

OIDC 로그인·로그아웃(back-channel 포함), 서버측 세션, `request.user` 주입, 권한 가드, Origin 검사.
의존 그래프의 뿌리다 — **다른 도메인에 의존하지 않는다.** shared만 쓴다.

## 파일

| 파일 | 역할 |
| --- | --- |
| `router.ts` | `/api/auth/*`, `/login-error` |
| `service.ts` | sessions 테이블 CRUD, `CurrentUser` |
| `guard.ts` | 전역 훅(`registerAuth`, `registerOriginCheck`), preHandler(`requireUser`, `requireAdmin`) |
| `oidc.ts` | Keycloak discovery 캐시, claim 읽기 |
| `url-safety.ts` | open redirect 방어 (순수 함수, 테스트 있음) |
| `schema.ts` | **소유 테이블: `sessions`** |

## 공개 API (`index.ts`)

`authRoutes`, `registerAuth`, `registerOriginCheck`, `requireUser`, `requireAdmin`, `isAdmin`,
`PORTAL_ADMIN_ROLE`, `purgeExpiredSessions`, `getOidcConfig`, `CurrentUser`.
다른 도메인은 index.ts만 import한다. 내부 파일 직접 import 금지.

## 불변 규칙

- 로그아웃은 **POST만** 받는다. GET이면 `<img src>` 한 줄로 강제 로그아웃 CSRF가 가능하다.
- `returnTo`는 반드시 `safeReturnTo`를 거친다 (open redirect 방어).
- 세션 TTL(10시간)은 Keycloak realm의 `ssoSessionMaxLifespan`에 맞춘다.
- 쿠키에는 서명된 세션 id만 담는다. 토큰은 DB에 두어야 back-channel logout이 가능하다.
- access/refresh token은 저장하지 않는다. 로그아웃용 `id_token`만 저장한다.
