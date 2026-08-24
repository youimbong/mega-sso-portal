# AGENTS.md

mega-sso-portal — Fastify + Keycloak(OIDC) SSO 포털. TypeScript(ESM), Node 22+, pnpm.

## 구조

- `src/domains/<도메인>/` — apps, auth, hr, portal, sso, users. 기능은 해당 도메인 안에 둔다.
- `sso/` 는 포털을 하위 앱의 OIDC Provider로 노출한다(`/oidc/*`). 연동 매뉴얼은 `docs/SSO-CONNECT.md`.
- `src/shared/` — db, env, views 등 공용 모듈.
- `drizzle/` — 마이그레이션. 스키마 변경은 `pnpm db:generate` 로 생성한다.

## 브랜치

- 작업 브랜치는 `develop/v1`. 기본적으로 여기서 작업하고 커밋한다.
- `main` 은 릴리스용. 직접 작업하지 않는다.

## 명령

- `pnpm dev` — 개발 서버
- `pnpm typecheck` — 타입 검사
- `pnpm test` — vitest
- `pnpm infra:up` / `infra:down` — Keycloak/DB 도커 스택

## 규칙

1. 변경 후 `pnpm typecheck` 와 `pnpm test` 를 실행한다.
2. 요청 범위 밖의 파일은 건드리지 않는다. 무관한 리팩터링·포맷팅 금지.
3. secret 은 `.env` 에만 둔다. 코드·로그·커밋에 남기지 않는다.
4. 의존성은 `package.json` 에 고정 버전으로 추가한다(캐럿 미사용).
5. commit / push / 마이그레이션 실행은 사용자가 명시적으로 요청할 때만 한다.
6. 별도 브랜치를 만들지 않고 `develop/v1` 에서 작업한다. 분리가 필요하면 먼저 사용자에게 확인한다.
