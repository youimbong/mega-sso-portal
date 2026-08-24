# sso 도메인 (포털을 OIDC Provider로)

하위 사내 앱은 Keycloak이 아니라 **포털**을 OP로 바라본다. 포털은 Keycloak의 RP이면서 동시에
하위 앱들의 OP다(identity broker).

```
[하위 Node 앱] --openid-client--> [포털 /oidc/*] --openid-client--> [Keycloak]
```

## 파일

| 파일 | 역할 |
| --- | --- |
| `router.ts` | `/oidc/*` (discovery, jwks, authorize, token, userinfo, logout) |
| `admin-router.ts` | `/admin/sso-clients*` (htmx 조각 렌더) |
| `clients.ts` | 클라이언트 조회·등록·수정·secret 재발급 |
| `codes.ts` | 인가 코드 발급/1회 소비/만료 정리 |
| `keys.ts` | OP 서명키(RS256) 부팅 생성·조회, JWKS |
| `tokens.ts` | id_token / access token / logout token 서명·검증 |
| `service.ts` | (포털 세션, 클라이언트) 링크와 신원 재조회 |
| `logout.ts` | 하위 앱으로 back-channel logout **송신** |
| `claims.ts` | 세션 → claim 매핑 (순수 함수, 테스트 있음) |
| `validate.ts` | redirect 일치·역할·scope·Basic·PKCE (순수 함수, 테스트 있음) |
| `secret.ts` | client secret 생성·scrypt 해시·검증 (순수 함수, 테스트 있음) |
| `metadata.ts` | discovery 문서 (순수 함수, 테스트 있음) |
| `schema.ts` | **소유 테이블: `sso_clients`, `sso_auth_codes`, `sso_signing_keys`, `sso_sessions`** |

## 공개 API (`index.ts`)

`ssoRoutes`, `ssoAdminRoutes`, `ensureSigningKey`(부팅 시 1회), `notifyPortalSessionsEnded`
(포털 세션 종료 시 배선), `purgeExpiredAuthCodes`(정리 타이머).

## 불변 규칙

1. `redirect_uri`·`post_logout_redirect_uri`는 **완전 문자열 일치**로만 검증한다. 와일드카드 금지.
2. PKCE `S256`은 **필수**다. 없으면 `invalid_request`.
3. `client_id`/`redirect_uri`가 틀린 요청은 **절대 리다이렉트하지 않는다**(포털 화면에 에러).
   그 뒤 단계의 오류만 하위 앱으로 되돌린다.
4. 평문 client secret은 등록·재발급 응답 화면에만 존재한다. DB·로그·커밋 어디에도 남기지 않는다.
5. issuer와 모든 endpoint URL은 `env.APP_BASE_URL` 파생이다. `request` 객체로 만들지 마라.
6. 등록 화면은 loopback(`localhost`/`127.0.0.1`/`[::1]`)을 뺀 모든 redirect·logout URI에 https를
   요구한다. 인가 코드가 쿼리스트링으로 오가므로 사내망이라도 평문 http면 가로챌 수 있다.

## 관리 화면 (`/admin/sso-clients`)

목록·등록·상세(수정)·활성 토글·삭제·secret 재발급. 상세 화면의 `views/integration.eta` 가
하위 앱 개발자에게 그대로 전달할 값(issuer, discovery URL, client_id, redirect_uri)을 보여준다.
평문 secret은 등록·재발급 응답에만 나온다 — 목록·상세에는 없다.

## discovery 경로

정본은 `/oidc/.well-known/openid-configuration`이다(openid-client는 append 형으로 붙인다).
RFC 8414 삽입형 `/.well-known/openid-configuration/oidc` 와
`/.well-known/oauth-authorization-server/oidc` 를 별칭으로 함께 서빙한다.
**루트 bare 경로(`/.well-known/openid-configuration`)는 일부러 404다** — 그 경로를 쓰는 RP는
issuer를 포털 루트로 기대하므로 어차피 issuer 불일치로 실패한다. 404가 진단하기 쉽다.

하위 앱은 반드시 **끝에 슬래시 없이** `new URL(\`${PORTAL}/oidc\`)`를 discovery에 넘겨야 한다.

## 로그아웃 경로

`/oidc/logout` 이 Keycloak의 `end_session_endpoint` 에 넘기는 `post_logout_redirect_uri` 는
**항상 포털 자신의 주소**다. Keycloak의 `portal` 클라이언트에는 하위 앱 주소가 등록돼 있지 않아
그대로 넘기면 Keycloak이 `Invalid redirect uri` 로 거부하고, 그러면 Keycloak SSO 세션이
살아남아 다음 로그인이 자격증명 없이 통과한다. 하위 앱으로 돌아가는 마지막 한 홉은
`/oidc/logout/callback` 이 맡는다 — 아무나 부를 수 있는 경로라 `to` 를 등록된 값과
다시 완전 일치로 검증한다.

포털 세션을 끊는 근거는 **요청자의 쿠키 세션**이다. `id_token_hint` 는 어느 앱의 요청인지
보정하는 보조 수단일 뿐이라 없어도 로그아웃은 된다. 반대로 쿠키가 없거나 hint 가 다른
포털 세션을 가리키면 **아무 상태도 바꾸지 않고** 리다이렉트만 한다 — 유출된 토큰 하나로
남의 세션·링크를 지울 수 있으면 back-channel logout 전파가 원격에서 무력화된다.

## 범위 밖(의도적 제외)

refresh_token, `prompt=none`, `response_mode=form_post`, introspection/revocation, 동의 화면,
프런트채널 로그아웃, 키 회전 UI. `grant_types_supported`에 `authorization_code`만 광고해
하위 앱이 애초에 시도하지 않게 한다.

## 의존

auth(`requireUser`/`requireAdmin`/`getOidcConfig`, 세션 조회·삭제), shared(db, env, views).
