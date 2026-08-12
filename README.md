# Mega SSO Portal

사내 웹솔루션의 로그인 계정을 Keycloak으로 통합 관리하고, 등록된 앱을 링크 또는 iframe으로 여는 포털.

## 기술 스택

| 영역 | 선택 | 비고 |
| --- | --- | --- |
| IdP | Keycloak 26.7 | OIDC/SAML/LDAP 표준. 계정·비밀번호·MFA·세션의 소유자 |
| 서버 | Fastify 5 + TypeScript 7 | |
| 뷰 | Eta 4 + htmx 2 | 서버 렌더. 클라이언트 번들러 없음 |
| DB | PostgreSQL 18 + Drizzle 0.45 | 앱 카탈로그와 세션만. 계정은 저장하지 않는다 |
| 인증 | openid-client 6 + jose 6 | OIDC 인증(certified) 라이브러리 |

빌드는 `tsc` 하나다. CSS·JS 번들 단계가 없고 htmx는 `public/`에 벤더링되어 있다(사내망에서 CDN 불필요).

## 시작하기

```bash
cp .env.example .env          # SESSION_SECRET은 openssl rand -base64 32 로 교체
pnpm install
pnpm infra:up                 # realm 렌더 → Keycloak + PostgreSQL
pnpm db:migrate
pnpm dev                      # http://localhost:3200
```

기본 계정(로컬 전용, `docker/keycloak/realm-mega.json`에서 import):

| 계정 | 비밀번호 | 역할 |
| --- | --- | --- |
| `admin.portal` | `admin1234` | `portal-user`, `portal-admin` |
| `user.portal` | `user1234` | `portal-user` |

Keycloak 관리 콘솔은 http://localhost:8080 (`admin` / `admin`).

### 포트 바꾸기

`.env`의 `APP_BASE_URL` **하나만** 고치고 realm을 다시 렌더링하면 된다.

```bash
sed -i '' 's|3200|3400|' .env
pnpm realm:render                                    # redirect_uri 등 재생성
docker compose -f docker/compose.yml up -d --force-recreate keycloak
pnpm dev
```

`APP_BASE_URL`이 단일 출처다. 바인딩 포트는 여기서 자동으로 뽑고, Keycloak의 `redirect_uri` /
`post.logout.redirect.uris` / back-channel logout URL도 같은 값에서 생성된다. 포트만 바꾸고
Keycloak 설정을 안 고쳐서 로그인이 깨지는 사고가 구조적으로 나지 않는다.

리버스 프록시 뒤처럼 공개 주소와 바인딩 포트가 달라야 할 때만 `PORT`를 따로 준다.

| 서비스 | 포트 | 비고 |
| --- | --- | --- |
| 포털 | 3200 | `APP_BASE_URL`로 결정 |
| Keycloak | 8080 | |
| PostgreSQL | 5433 → 컨테이너 5432 | 호스트 5432는 로컬 PostgreSQL이 사용 중 |

이 기본값은 로컬에 이미 3000·3100(다른 프로젝트)과 5432(로컬 PostgreSQL)가 떠 있어 그것을 피한 것이다.

## 검증

```bash
pnpm typecheck
pnpm test
pnpm build && pnpm start
```

## 구조

```
src/
  server.ts        Fastify 부트스트랩, 플러그인, CSP
  env.ts           zod로 환경변수 검증 (실패 시 기동 거부)
  auth.ts          세션 쿠키 → request.user, 권한 가드, Origin 검사
  oidc.ts          Keycloak discovery 캐시
  session.ts       서버측 세션 CRUD
  apps.ts          앱 카탈로그 조회/등록
  visibility.ts    앱 노출 정책 (순수 함수, 테스트 있음)
  url-safety.ts    open redirect 방어 (순수 함수, 테스트 있음)
  routes/
    auth.ts        로그인 / 콜백 / 로그아웃 / back-channel logout
    portal.ts      홈, iframe 화면
    admin.ts       앱 카탈로그 관리 (htmx)
views/             Eta 템플릿
public/            app.css, htmx.min.js
scripts/
  render-realm.mjs .env → Keycloak realm import 파일 생성
docker/
  compose.yml
  keycloak/realm-mega.template.json   원본 (git 추적)
  keycloak/realm-mega.json            생성물 (gitignore)
  postgres/init.sql
```

## 설계 결정

**세션을 쿠키가 아니라 DB에 둔다.** Keycloak ID token만 1.3KB이고 다른 토큰까지 더하면 쿠키 4KB 한계에 걸린다. 더 중요한 이유는 back-channel logout이다 — Keycloak이 보내는 `sid`로 해당 세션을 찾아 끊으려면 서버에 세션이 있어야 한다. 쿠키에는 서명된 세션 id만 담는다.

**access token / refresh token을 저장하지 않는다.** 포털은 사용자 토큰으로 다른 API를 호출하지 않는다. 필요한 것은 로그아웃용 `id_token`뿐이다. 나중에 앱을 프록시하게 되면 그때 추가한다.

**Keycloak realm 파일은 템플릿에서 생성한다.** Keycloak 26은 realm import JSON 안의 `${...}`를 치환해주지 않는다 — 확인된 동작은 `${env.FOO}`를 그대로 URI로 검증해서 `Invalid client portal: A redirect URI is not a valid URI`로 기동에 실패하는 것이다. 그래서 `scripts/render-realm.mjs`가 컨테이너에 넘기기 전에 `.env` 값으로 치환하고, JSON 파싱까지 확인한 뒤 파일을 쓴다.

**realm role을 ID token에 넣는 mapper가 필요하다.** Keycloak 기본값은 `realm_access.roles`를 access token에만 넣는다. realm JSON의 `portal` 클라이언트에 `oidc-usermodel-realm-role-mapper`를 명시적으로 추가해둔 이유다.

**iframe은 앱마다 선택한다.** 대상 앱이 `X-Frame-Options: DENY`나 CSP `frame-ancestors`로 embed를 막으면 iframe은 빈 화면이 된다. 카탈로그의 `mode`가 `link`면 새 탭, `iframe`이면 포털 안에서 연다.

**로그아웃은 POST만 받는다.** GET으로 두면 외부 사이트의 `<img src>` 한 줄로 강제 로그아웃이 가능하다.

## 운영 배포 전 필수 작업

- [ ] `SESSION_SECRET` 재생성, `OIDC_CLIENT_SECRET` Keycloak에서 재발급
- [ ] HTTPS 적용 — 세션 쿠키의 `secure` 플래그는 `APP_BASE_URL`이 `https://`일 때만 켜진다
- [ ] Keycloak을 `start-dev`가 아닌 `start`로 (`docker/compose.yml`)
- [ ] realm의 redirect URI / back-channel logout URL을 실제 도메인으로 교체
- [ ] 사내 AD·LDAP를 Keycloak User Federation에 연결
- [ ] PostgreSQL 백업, Keycloak DB 포함
