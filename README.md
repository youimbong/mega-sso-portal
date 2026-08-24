# Mega SSO Portal

사내 웹솔루션의 로그인 계정을 Keycloak으로 통합 관리하고, 등록된 앱을 링크 또는 iframe으로 여는 포털.

## 기술 스택

| 영역 | 선택 | 비고 |
| --- | --- | --- |
| IdP | Keycloak 26.7 | OIDC/SAML/LDAP 표준. 계정·비밀번호·MFA·세션의 소유자 |
| 서버 | Fastify 5 + TypeScript 7 | |
| 뷰 | Eta 4 + htmx 2 | 서버 렌더. 클라이언트 번들러 없음 |
| DB | PostgreSQL 18 + Drizzle 0.45 | 앱 카탈로그·세션·직원 미러. 계정은 저장하지 않는다 |
| 사원 정보 | A10 사원등록조회 (api16S05) | 사번(`empCd`)이 사내 공통 유니크 키. 포털은 읽기 전용 미러만 둔다 |
| 인증 | openid-client 6 + jose 6 | OIDC 인증(certified) 라이브러리 |

빌드는 `tsc` 하나다. CSS·JS 번들 단계가 없고 htmx는 `public/`에 벤더링되어 있다(사내망에서 CDN 불필요).

## 시작하기

```bash
cp .env.example .env          # SESSION_SECRET은 openssl rand -base64 32 로 교체
pnpm install
pnpm infra:up                 # realm 렌더 → Keycloak + PostgreSQL
pnpm db:migrate
pnpm dev                      # http://localhost:30400
```

기본 계정(로컬 전용, `docker/keycloak/realm-mega.json`에서 import):

| 계정 | 비밀번호 | 역할 |
| --- | --- | --- |
| `admin.portal` | `admin1234` | `portal-user`, `portal-admin` |
| `user.portal` | `user1234` | `portal-user` |

Keycloak 관리 콘솔은 http://localhost:8080 (`admin` / `admin`).

사번 연동(`/admin/hr`, 직원 선택 등록)을 쓰려면 `.env`에 `A10_*` 자격증명을 채워야 한다.
비워두면 포털은 정상 기동하고 로그인·앱 카탈로그도 동작하지만 동기화만 실패한다.

### realm 템플릿을 고친 뒤 다시 적용하기

Keycloak은 realm이 이미 있으면 import를 건너뛴다. 실측 로그가 그대로 말해준다.

```
Realm 'mega' already exists. Import skipped
KC-SERVICES0030: Full model import requested. Strategy: IGNORE_EXISTING
```

즉 `docker compose up -d --force-recreate keycloak` 만으로는 템플릿 변경이 반영되지 않는다.
`KC_SPI_IMPORT_SINGLE_FILE_STRATEGY`로도 못 바꾼다 — 26.7.1에서는 이 변수를 컨테이너에 넣어도
무시하고 `IGNORE_EXISTING`으로 돈다(실측). 로컬 재적용은 `kc.sh import`를 직접 부른다.

```bash
pnpm realm:render
docker exec mega-sso-portal-keycloak-1 \
  /opt/keycloak/bin/kc.sh import --file /opt/keycloak/data/import/realm-mega.json --override true
docker compose -f docker/compose.yml restart keycloak
```

`Realm 'mega' imported` 가 찍히면 된 것이다. 명령 끝에 나오는
`Unable to start the management interface on 0.0.0.0:9000 / Address already in use` 는
import를 마친 뒤 그 프로세스가 서버로 뜨려다 실패하는 것이라 무시해도 된다.

realm을 지우고 다시 만드는 것이므로 **콘솔이나 포털에서 만든 계정은 사라진다.**
운영 Keycloak은 이 방법으로 덮지 않는다 — 관리 콘솔에서 수동으로 반영한다(맨 아래 체크리스트).

바뀐 것이 portal 클라이언트 설정(`redirectUris` / `webOrigins` / `attributes`)뿐이라면
realm 전체를 다시 임포트할 이유가 없다. 계정을 보존한 채 그 클라이언트만 맞추는 쪽을 쓴다.

```bash
pnpm realm:render        # .env → docker/keycloak/realm-mega.json
pnpm realm:sync-client   # live Keycloak의 portal 클라이언트만 Admin API로 갱신
```

`APP_BASE_URL`을 바꾼 뒤 이걸 빼먹으면 로그인이 `Invalid parameter: redirect_uri` 로 깨진다.

### 포트 바꾸기

`.env`의 `APP_BASE_URL` **하나만** 고치고 realm을 다시 렌더링하면 된다.

```bash
sed -i '' 's|30400|3400|' .env
pnpm realm:render                                    # redirect_uri 등 재생성
pnpm realm:sync-client                               # 실행 중인 Keycloak에 반영 (계정 보존)
pnpm dev
```

`APP_BASE_URL`이 단일 출처다. 바인딩 포트는 여기서 자동으로 뽑고, Keycloak의 `redirect_uri` /
`post.logout.redirect.uris` / back-channel logout URL도 같은 값에서 생성된다. 포트만 바꾸고
Keycloak 설정을 안 고쳐서 로그인이 깨지는 사고가 구조적으로 나지 않는다.

리버스 프록시 뒤처럼 공개 주소와 바인딩 포트가 달라야 할 때만 `PORT`를 따로 준다.

| 서비스 | 포트 | 비고 |
| --- | --- | --- |
| 포털 | 30400 | `APP_BASE_URL`로 결정 |
| Keycloak | 8080 | |
| PostgreSQL | 5433 → 컨테이너 5432 | 호스트 5432는 로컬 PostgreSQL이 사용 중 |

이 기본값은 로컬에 이미 3000·3100(다른 프로젝트)과 5432(로컬 PostgreSQL)가 떠 있어 그것을 피한 것이다.

## pm2로 상시 구동

`ecosystem.config.cjs`가 설정 파일이다. `pnpm dev`(tsx watch)는 개발용이고, 상시 구동은
빌드 결과물(`dist/server.js`)을 pm2가 띄운다.

```bash
pnpm install
pnpm build                 # dist/ 생성. 이걸 빼먹으면 pm2가 옛 코드를 띄운다
pm2 start ecosystem.config.cjs
pm2 logs mega-sso-portal
```

`pnpm pm2:start` / `pm2:reload` 는 build 를 먼저 돌리는 단축 명령이다.

| 명령 | 하는 일 |
| --- | --- |
| `pnpm pm2:start` | build → pm2 start |
| `pnpm pm2:reload` | build → 재시작 (SIGINT → `app.close()` → `closeDb()`). **무중단이 아니다** — fork 모드에서 pm2는 hardReload 대신 restart로 떨어져 종료~기동 사이 몇 초간 포트가 닫힌다 |
| `pnpm pm2:stop` | 중지 |
| `pnpm pm2:logs` | 로그 tail |
| `pm2 delete mega-sso-portal` | 목록에서 제거 |

로그는 `logs/out.log`, `logs/error.log`에 쌓인다(gitignore). `NODE_ENV=production`이므로
pino가 JSON 한 줄씩 쓴다 — pino-pretty는 devDependency라 운영에서 쓰지 않는다.

### 전제 조건

- **Keycloak과 PostgreSQL이 먼저 떠 있어야 한다.** pm2는 이걸 관리하지 않는다 (`pnpm infra:up`).
- **`.env`가 프로젝트 루트에 있어야 한다.** `load-env.ts`가 cwd 기준 상대경로로 읽으므로
  설정의 `cwd: __dirname` 이 필수다. 환경변수 검증에 실패하면 프로세스가 즉시 `exit(1)` 한다.
- **`dist/`와 함께 `src/`도 있어야 한다.** `.eta` 템플릿은 tsc가 컴파일하지 않아 런타임에
  `dist/../src` 에서 원본을 읽는다. 배포 시 `src/`를 빼면 모든 화면이 500이 된다.
- **`package.json`이 `"type": "module"`** 이라 pm2 설정 파일은 `.cjs` 여야 한다. `.js`로 두면
  pm2가 require 하다 실패한다.

### fork 1개인 이유

`exec_mode: 'fork'`, `instances: 1` 로 고정했다. cluster로 늘리면 인스턴스마다 세션 정리
타이머(1시간 주기)가 따로 돌고, ESM + pm2 cluster 조합도 안정적이지 않다. 수평 확장이
필요해지면 그때 검토한다.

### 부팅 시 자동 기동

```bash
pm2 startup          # 출력되는 sudo 명령을 그대로 실행한다
pm2 save             # 현재 프로세스 목록을 저장
```

## 검증

```bash
pnpm typecheck
pnpm test
pnpm build && pnpm start
```

## 구조

도메인 주도 구조다. 도메인 하나 = 폴더 하나이며, 내부는 `router`(HTTP) / `service`(로직) /
`views`(Eta) / `schema`(소유 테이블) / `index.ts`(공개 API) / `CLAUDE.md`(도메인 규칙)로 고정한다.

```
src/
  server.ts        Fastify 부트스트랩, 플러그인, CSP, 도메인 라우터 등록
  shared/          횡단 관심사 — 도메인이 아니다
    env.ts           zod로 환경변수 검증 (실패 시 기동 거부)
    db.ts            PostgreSQL 연결 (테이블 스키마는 각 도메인 소유)
    views/           layout.eta, error.eta
  domains/
    auth/            로그인·콜백·로그아웃·back-channel logout, 세션, 권한 가드. sessions 테이블 소유
    portal/          홈, iframe 화면
    apps/            앱 카탈로그와 노출 정책 (/admin/apps). apps·app_roles 테이블 소유
    users/           사용자 관리 (/admin/users). Keycloak Admin REST API (service account)
    hr/              A10 사원 정보 미러와 동기화 (/admin/hr). hr_employee 테이블 소유
    sso/             포털을 하위 앱의 OIDC Provider로 노출 (/oidc/*, /admin/sso-clients).
                     sso_clients·sso_auth_codes·sso_signing_keys·sso_sessions 테이블 소유
public/            app.css, htmx.min.js
scripts/
  render-realm.mjs .env → Keycloak realm import 파일 생성
docker/
  compose.yml
  keycloak/realm-mega.template.json   원본 (git 추적)
  keycloak/realm-mega.json            생성물 (gitignore)
  postgres/init.sql
```

도메인 규칙:

- **도메인 간 참조는 상대 도메인의 `index.ts`를 통해서만** 한다. 내부 파일 직접 import 금지.
  의존 방향은 `portal → apps → auth`, `users → hr`, `users → auth`, `sso → auth` 한 방향이다.
  auth는 어떤 도메인에도 의존하지 않고, hr은 어떤 도메인도 참조하지 않는다.
- 도메인별 상세 규칙(안전장치 포함)은 각 폴더의 `CLAUDE.md`에 있다. AI 에이전트는 해당 도메인
  폴더만 읽고 작업할 수 있다.
- `.eta` 템플릿은 tsc가 컴파일하지 않으므로 빌드 후에도 `src/` 안의 원본을 그대로 읽는다.
  배포 시 `dist/`와 함께 `src/`도 있어야 한다.

## 사용자 관리

Keycloak 관리 콘솔에 들어가지 않고 포털에서 관리한다. `portal-admin` 역할이 있어야 보인다.

| 화면 | 하는 일 |
| --- | --- |
| `/admin/users` | 검색, 목록, 사용자 등록(직원 선택) |
| `/admin/users/:id` | 역할 부여, 비밀번호 재설정, 세션 강제 종료, 활성/비활성, 삭제 |
| `/admin/hr` | A10 사원 정보 미러 상태 확인과 수동 동기화 |

포털은 `portal` 클라이언트의 **service account**로 Keycloak Admin REST API를 호출한다. 그 계정에는
`realm-management`의 `query-users` / `view-users` / `view-realm` / `manage-users` 만 있다.
`realm-admin`은 주지 않았으므로 이 경로로 클라이언트나 realm 설정을 바꿀 수 없다
(`GET /clients`는 403으로 확인).

### 사번 연동

포털이 관리하는 것은 **아이디와 비밀번호뿐**이다. 성명·부서·재직구분은 A10이 소유하고,
사내 솔루션들은 **사번(`hr_employee.code` = A10 `empCd`)** 을 공통 유니크 키로 삼아 각자 조인한다.

```
A10 (사원 정보 원본)
  │  POST {A10_API_BASE_URL}/apiproxy/api16S05   전건 조회
  ▼  /admin/hr 에서 관리자가 수동 실행 (스케줄러 없음)
hr_employee (포털 소유의 읽기 전용 미러, upsert 키 = code)
  ▼  직원 검색 → 선택 → 아이디/비밀번호만 입력
Keycloak user.attributes.employeeCode = "12345"   ← 계정↔사번 연결의 원본
  ▼  portal 클라이언트의 protocol mapper
id / access / userinfo token 의 employee_code claim
  ▼
다른 사내 솔루션이 claim으로 사번을 받아 자기 hr_employee 미러와 조인한다
```

- **포털 DB에 계정 테이블도, 계정↔사번 매핑 테이블도 만들지 않는다.** 그건 Keycloak attribute와
  이중 원본이 된다. 포털 DB에 새로 생긴 테이블은 `hr_employee` 하나뿐이다.
- **미러는 사람이 편집하지 않는다.** 틀린 정보는 A10에서 고치고 다시 동기화한다.
- **`employeeCode`는 Keycloak User Profile에 선언되어 있다**(`realm-mega.template.json`의
  `components`). 선언이 없으면 Admin API로 보낸 attribute가 **조용히 버려진다** — 에러도 안 난다.
  `unmanagedAttributePolicy`를 켜는 대신 선언 방식을 쓴 이유는, realm 파일 자체가 문서 역할을
  하고 길이 검증(10자)도 함께 걸리기 때문이다.
- **선언이 반영됐는지는 계정 생성 직후 되읽어 확인한다.** 선언 없는 realm에 사번을 보내면
  Keycloak은 `201`을 주고 attribute만 버린다(실측: `POST /users` → 201, 되읽으면
  `attributes: null`, `q=employeeCode:` 0건). 그러면 등록이 성공한 것처럼 보이면서 사번 중복
  방어까지 함께 죽는다. `createUser`가 되읽어 사번이 없으면 **그 계정을 지우고** 실패시킨다 —
  아래 운영 체크리스트의 반영 단계를 빠뜨리면 첫 등록에서 바로 드러난다.
- **직원 연결 없는 계정도 만들 수 있다.** 폼 하단의 "직원 연결 없이 만들기" 경로다.
  `service-account-portal`이나 `admin.portal` 같은 사람이 아닌 계정이 이미 있고, 사번을 강제하면
  A10 동기화가 실패한 상태에서 새 관리자 계정을 아무도 못 만드는 자충수가 된다. 이 계정에는
  `employee_code` claim이 실리지 않으므로 다른 솔루션은 claim 부재를 "직원 아님"으로 읽으면 된다.
- **사번 중복은 등록 직전 조회 + 저장 직후 되읽기, 두 번으로 막는다**
  (`GET /users?q=employeeCode:12345`). Keycloak 자체에는 attribute 유니크 제약이 없다
  (중복 생성 201 실측). 조회와 생성 사이에는 잠금이 없어 두 관리자가 거의 동시에 같은 사번을
  등록하면 둘 다 사전 조회를 통과하므로, 저장한 뒤 같은 사번의 **다른** 계정이 잡히면 늦게
  도착한 쪽이 방금 만든 계정을 지우고 실패한다(사번 연결 경로는 붙인 사번을 다시 뗀다).
  이를 막자고 포털 DB에 매핑 테이블을 두면 이중 원본이라는 더 큰 문제를 산다.
- **퇴직자(J05)는 신규 등록만 막는다.** 동기화가 기존 계정을 자동 비활성화하지는 않는다 —
  A10 응답이 일부만 내려오는 사고 한 번에 대량 잠금이 일어나고, 세션까지 끊기면 되돌리기 어렵다.
  목록·상세에 `퇴직` 태그를 띄우고 처리는 관리자의 기존 "비활성화" 액션에 맡긴다.

### 안전장치

구조적으로 막아둔 것들이다. 모두 테스트로 고정했거나 실제로 검증했다.

- **관리 UI에 없는 역할은 절대 제거하지 않는다.** 체크박스가 없는 `default-roles-mega`를
  "해제됨"으로 오인해 지우면 계정이 망가진다. `diffRoles`가 제거 후보를 화면에 보이는 역할로 한정한다.
- **폼을 조작해 `realm-admin`을 밀어넣어도 무시한다.** 부여 대상도 같은 목록으로 한정한다.
- **자기 자신은** `portal-admin` 제거·비활성화·삭제가 안 된다. 마지막 관리자가 스스로 잠기는 사고를 막는다.
- **비활성화하면 세션도 함께 끊는다.** 안 그러면 최대 10시간 동안 계속 쓸 수 있다.
- **service account 계정은 목록에 나오지 않는다.**
- **외부(AD/LDAP) 사용자는 읽기 전용이다.** `federationLink`가 있으면 비밀번호 변경과 삭제를 막고
  화면에 `외부(AD/LDAP)` 배지를 붙인다. 계정 원본은 AD가 소유해야 한다.

### 역할과 앱 노출의 연결

```
포털 /admin/users/:id  →  사용자에게 hr-team 부여
포털 /admin/apps       →  인사시스템의 노출 역할 = hr-team
                       →  hr-team 보유자의 홈에만 인사시스템이 보인다
```

노출 역할을 비우면 로그인한 모두에게 보인다. `portal-admin`은 카탈로그 관리 권한일 뿐,
남의 업무 앱에 자동 접근권을 주지 않는다.

역할 **생성**은 아직 포털에 없다. 새 역할이 필요하면 Keycloak 콘솔의 Realm roles에서 만든다.

## 하위 앱을 포털에 연동하기 (포털이 OP)

운영에서 최종 사용자는 Keycloak에 직접 접속하지 않는다. 하위 사내 앱은 Keycloak이 아니라
**포털**을 OIDC Provider로 바라본다. 포털은 Keycloak의 RP이면서 동시에 하위 앱들의 OP다.

```
[하위 Node 앱] --openid-client--> [포털 /oidc/*] --openid-client--> [Keycloak]
```

**하위 Node 앱(Express / Fastify / API 서버)을 붙이는 전체 절차와 복사해 쓸 수 있는 코드는
[docs/SSO-CONNECT.md](docs/SSO-CONNECT.md) 에 있다.** 아래는 요약이다.

1. `/admin/sso-clients` 에서 앱을 등록한다. 평문 client secret은 **등록·재발급 응답 화면에만
   한 번** 나온다(DB에는 scrypt 해시만 있다). 그 자리에서 복사해 하위 앱의 `.env`에 넣는다.
2. 상세 화면의 "연동 정보" 표에 하위 앱 개발자에게 그대로 전달할 값이 있다.

| 값 | 예 |
| --- | --- |
| issuer | `http://localhost:30400/oidc` |
| discovery | `http://localhost:30400/oidc/.well-known/openid-configuration` |
| grant | `authorization_code` + PKCE `S256` (**필수**) |

하위 앱 쪽 코드는 이렇게 된다.

```js
// 끝에 슬래시를 붙이지 마라. `.../oidc/` 를 넘기면 openid-client가 issuer 문자열 비교에서 실패한다.
const config = await client.discovery(
  new URL(`${PORTAL}/oidc`),
  CLIENT_ID,
  CLIENT_SECRET,
  undefined,
  // openid-client 6은 기본적으로 https만 허용한다. 위 예처럼 포털이 개발용 http면
  // 이 분기가 없으면 `ClientError: only requests to HTTPS are allowed` 로 죽는다.
  // 운영(https)에서는 undefined가 되어 켜지지 않는다 — docs/SSO-CONNECT.md §3 참고.
  PORTAL.startsWith('http://') ? { execute: [client.allowInsecureRequests] } : undefined,
)
```

주의할 것:

- `redirect_uri` / `post_logout_redirect_uri` 는 **완전 문자열 일치**로만 검증한다. 와일드카드 없다.
- 등록 화면은 loopback(`localhost` / `127.0.0.1` / `[::1]`)을 뺀 모든 URI에 **https**를 요구한다.
  인가 코드가 쿼리스트링으로 오가므로 사내망이라도 평문 http면 가로챌 수 있다. 사내 앱을 http로
  서비스해야 한다면 그건 정책 결정이다 — `src/domains/sso/validate.ts` 한 곳을 고쳐야 한다.
- **refresh token을 발급하지 않는다.** access token 수명은 5분이고 `grant_types_supported` 에
  `authorization_code` 하나만 광고한다. 하위 앱은 자체 세션을 두고 만료되면 다시 인가를 받는다.
- back-channel logout URL을 등록해 두면 포털 세션이 끝날 때(하위 앱발 로그아웃, 포털 로그아웃,
  Keycloak 강제 로그아웃, 세션 만료) 그 앱에 `logout_token`이 POST된다. 등록하지 않은 앱은
  자체 세션 만료를 따른다.
- 서명키(RS256)는 포털 DB(`sso_signing_keys`)가 원본이다. 첫 기동 때 한 쌍을 만들고 그 뒤로는
  재기동해도 `kid`가 유지된다 — 하위 앱의 JWKS 캐시가 깨지지 않는다.

claim 레퍼런스, 역할 기반 접근 제어, back-channel logout 수신 코드, 오류별 원인 표는
[docs/SSO-CONNECT.md](docs/SSO-CONNECT.md) 를 본다.

## 설계 결정

**세션을 쿠키가 아니라 DB에 둔다.** Keycloak ID token만 1.3KB이고 다른 토큰까지 더하면 쿠키 4KB 한계에 걸린다. 더 중요한 이유는 back-channel logout이다 — Keycloak이 보내는 `sid`로 해당 세션을 찾아 끊으려면 서버에 세션이 있어야 한다. 쿠키에는 서명된 세션 id만 담는다.

**access token / refresh token을 저장하지 않는다.** 포털은 사용자 토큰으로 다른 API를 호출하지 않는다. 필요한 것은 로그아웃용 `id_token`뿐이다. 나중에 앱을 프록시하게 되면 그때 추가한다.

**Keycloak realm 파일은 템플릿에서 생성한다.** Keycloak 26은 realm import JSON 안의 `${...}`를 치환해주지 않는다 — 확인된 동작은 `${env.FOO}`를 그대로 URI로 검증해서 `Invalid client portal: A redirect URI is not a valid URI`로 기동에 실패하는 것이다. 그래서 `scripts/render-realm.mjs`가 컨테이너에 넘기기 전에 `.env` 값으로 치환하고, JSON 파싱까지 확인한 뒤 파일을 쓴다.

**realm role을 ID token에 넣는 mapper가 필요하다.** Keycloak 기본값은 `realm_access.roles`를 access token에만 넣는다. realm JSON의 `portal` 클라이언트에 `oidc-usermodel-realm-role-mapper`를 명시적으로 추가해둔 이유다.

**사번은 Keycloak user attribute에 둔다.** 계정을 Keycloak이 소유하므로 계정에 딸린 사번도 같은 곳에 있어야 원본이 하나로 유지된다. 포털 DB에 매핑 테이블을 두면 계정 삭제·이관 때마다 두 곳을 맞춰야 하고, 어느 쪽이 맞는지 판정할 방법이 없다. 소비자에게는 `employee_code` claim으로 나가므로 다른 솔루션은 포털 DB를 몰라도 된다.

**직원 정보는 A10에서 포털이 직접 받아 미러한다.** EIS DB를 읽거나 EIS API를 거치지 않는다 — 그러면 EIS 장애가 포털의 계정 등록 장애가 되고, 포털이 EIS의 내부 스키마에 묶인다. A10이 단일 원본이고 두 솔루션이 각자 미러를 갖는 편이 결합도가 낮다. 미러는 화면과 계정 생성에 실제로 쓰는 필드만 담는다. 특히 급여 계좌·생년월일·연락처는 복제하지 않는다 — SSO 포털에 있을 이유가 없고 유출 시 피해만 크다.

**동기화는 관리자 수동 실행이다.** 스케줄러를 두지 않았다. A10 호출 동시성을 EIS와 합산해 합의하기 전에 자동 호출을 얹지 않는다. 미러가 얼마나 낡았는지는 `/admin/hr`에 마지막 동기화 시각으로 보여준다.

**iframe은 앱마다 선택한다.** 대상 앱이 `X-Frame-Options: DENY`나 CSP `frame-ancestors`로 embed를 막으면 iframe은 빈 화면이 된다. 카탈로그의 `mode`가 `link`면 새 탭, `iframe`이면 포털 안에서 연다.

**로그아웃은 POST만 받는다.** GET으로 두면 외부 사이트의 `<img src>` 한 줄로 강제 로그아웃이 가능하다.

## 운영 배포 전 필수 작업

- [ ] `SESSION_SECRET` 재생성, `OIDC_CLIENT_SECRET` Keycloak에서 재발급
- [ ] HTTPS 적용 — 세션 쿠키의 `secure` 플래그는 `APP_BASE_URL`이 `https://`일 때만 켜진다
- [ ] Keycloak을 `start-dev`가 아닌 `start`로 (`docker/compose.yml`)
- [ ] realm의 redirect URI / back-channel logout URL을 실제 도메인으로 교체
- [ ] 사내 AD·LDAP를 Keycloak User Federation에 연결
- [ ] PostgreSQL 백업, Keycloak DB 포함
- [ ] `A10_*` 자격증명 발급받아 운영 `.env`에 설정 (값은 문서·저장소에 남기지 않는다)
- [ ] 운영 Keycloak에 사번 설정을 **수동으로** 반영 — import로 덮지 않는다
  - Realm settings → User profile → Create attribute: 이름 `employeeCode`, 표시명 `사번`,
    최대 길이 10, 권한은 admin만 편집 (required 체크 안 함 — 직원 연결 없는 계정이 있다)
  - Clients → `portal` → Client scopes → `portal-dedicated` → Add mapper → By configuration →
    User Attribute: user attribute `employeeCode`, token claim name `employee_code`,
    ID/Access/userinfo token 전부 On
  - 확인: 사번을 넣은 계정으로 로그인 후
    `GET /realms/mega/protocol/openid-connect/userinfo` 응답에 `employee_code`가 있다
