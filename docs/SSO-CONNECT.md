# 하위 앱을 포털 SSO에 붙이기

사내 Node 앱을 Mega SSO Portal에 연동하는 절차서다. 이 문서의 값과 동작은
`src/domains/sso/**` 의 실제 코드와 포털의 discovery 응답에서 확인한 것이다.

---

## 1. 개요

운영에서 최종 사용자는 Keycloak에 직접 접속하지 않는다. 하위 사내 앱은 Keycloak이 아니라
**포털**을 OIDC Provider로 바라본다. 포털은 Keycloak의 RP이면서 동시에 하위 앱들의 OP다
(identity broker).

```
   브라우저
      │  ① GET /login
      ▼
┌──────────────┐  ② 302 /oidc/authorize   ┌──────────────────┐
│  하위 Node 앱 │ ───────────────────────▶ │ 포털 /oidc/*      │
│  (RP)        │                          │ (OP + Keycloak RP)│
└──────────────┘                          └──────────────────┘
      ▲                                        │       ▲
      │                                        │ ③ 포털 세션이 없으면
      │                                        │   Keycloak 로그인으로
      │                                        ▼       │
      │                                   ┌──────────────────┐
      │                                   │ Keycloak (realm) │
      │                                   │ 계정·비밀번호·MFA │
      │                                   └──────────────────┘
      │                                        │
      │  ④ 302 {앱}/callback?code=…&state=…    │
      │◀───────────────────────────────────────┘
      │
      │  ⑤ POST 포털 /oidc/token   (서버-서버, client_secret + code_verifier)
      │  ⑥ id_token + access_token
      ▼
   앱 자체 세션 생성
```

이 구조를 택한 이유:

- 하위 앱은 Keycloak의 존재를 몰라도 된다. Keycloak을 교체하거나 realm 구조를 바꿔도
  하위 앱의 설정(`issuer`, `client_id`, `client_secret`)은 그대로다.
- 앱별 클라이언트 등록이 Keycloak 관리 콘솔이 아니라 포털의 `/admin/sso-clients` 화면에서
  끝난다. 포털 관리자가 Keycloak 관리자 권한 없이 앱을 붙일 수 있다.
- 역할 기반 접근 제한(`requiredRoles`)을 포털이 인가 단계에서 강제한다. 앱이 검사를
  빼먹어도 애초에 코드가 발급되지 않는다.
- 포털 세션이 끝나면 그 세션으로 로그인한 모든 하위 앱에 back-channel logout을 보낸다.
  단일 로그아웃의 팬아웃 지점이 한 곳이다.

### 포털이 제공하는 것 / 제공하지 않는 것

| | |
| --- | --- |
| grant | `authorization_code` **하나뿐** |
| PKCE | `S256` **필수** (없으면 `invalid_request`) |
| response_type / response_mode | `code` / `query` 만 |
| 서명 | RS256 |
| 클라이언트 인증 | `client_secret_basic` 또는 `client_secret_post` |
| **없는 것** | refresh_token, `prompt=none`, `response_mode=form_post`, introspection, revocation, 동의 화면, front-channel logout |

**refresh token이 없다.** access token 수명은 5분이다. 하위 앱은 자기 세션을 따로 갖고,
포털 토큰은 로그인 순간의 신원 확인에만 쓴다. 5분마다 다시 인가받는 구조를 만들지 마라.

### 엔드포인트

`PORTAL` 을 포털 주소(`http://localhost:30400`, 운영은 https)로 두면:

| | |
| --- | --- |
| issuer | `{PORTAL}/oidc` |
| discovery | `{PORTAL}/oidc/.well-known/openid-configuration` |
| authorization_endpoint | `{PORTAL}/oidc/authorize` |
| token_endpoint | `{PORTAL}/oidc/token` |
| userinfo_endpoint | `{PORTAL}/oidc/userinfo` |
| jwks_uri | `{PORTAL}/oidc/jwks` |
| end_session_endpoint | `{PORTAL}/oidc/logout` |

discovery는 세 경로로 서빙된다. openid-client가 쓰는 append 형(`{issuer}/.well-known/openid-configuration`)이
정본이고, RFC 8414 삽입형 `{PORTAL}/.well-known/openid-configuration/oidc` 와
`{PORTAL}/.well-known/oauth-authorization-server/oidc` 가 별칭이다.
**루트 bare 경로 `{PORTAL}/.well-known/openid-configuration` 은 일부러 404다** —
그 경로를 쓰는 RP는 issuer를 포털 루트로 기대하므로 어차피 issuer 불일치로 실패한다.

---

## 2. 사전 준비 — 포털 관리자에게 요청할 것

앱 담당자가 포털 관리자에게 넘겨야 하는 값이다. 넷 다 없으면 등록할 수 없다.

| 항목 | 설명 | 예 |
| --- | --- | --- |
| `client_id` | 소문자·숫자·하이픈만. 등록 후 **변경 불가**. 앱 설정에 그대로 박힌다 | `shop` |
| 앱 이름 | 관리 목록에 보일 이름 | `쇼핑몰 관리자` |
| `redirect_uri` | 콜백 주소. 여러 개면 한 줄에 하나 | `https://shop.example.co.kr/auth/callback` |
| `post_logout_redirect_uri` | 로그아웃 후 돌아올 주소. 없으면 포털 홈으로 간다 | `https://shop.example.co.kr/` |
| `backchannel_logout_uri` | (선택) 로그아웃 통지를 받을 주소 | `https://shop.example.co.kr/auth/backchannel-logout` |
| 필요 역할 | (선택) Keycloak realm role, 쉼표 구분. 비우면 로그인한 모두 허용 | `shop-admin` |

등록 시 걸리는 제약:

- URI는 **완전 문자열 일치**로만 검증한다. 와일드카드·prefix·대소문자 무시 전부 없다.
  끝 슬래시 하나만 달라도 로그인이 거부된다.
- loopback(`localhost` / `127.0.0.1` / `[::1]`)을 뺀 모든 URI는 **https여야 한다**.
  인가 코드가 쿼리스트링으로 오가므로 사내망이라도 평문 http면 가로챌 수 있다.
- fragment(`#`)를 쓸 수 없다.
- 포털 자신의 origin은 쓸 수 없다(인가 루프가 된다).
- 예약된 `client_id`가 있다: `portal`, `admin`, `api`, `static`, `apps`, `oidc`,
  `healthz`, `account`, `security-admin-console`, `admin-cli`, `broker`, `realm-management`.

### 등록 절차 (포털 관리자)

1. `portal-admin` 역할로 로그인해 `{PORTAL}/admin/sso-clients` 를 연다.
2. "새 클라이언트 등록" 폼에 위 값을 넣는다. 앱이 아직 준비되지 않았으면 **"바로 사용"을
   끈 채** 등록하고, 준비가 끝나면 목록에서 켠다.
3. 등록을 누르면 **평문 client_secret이 그 응답 화면에 한 번만** 나온다. DB에는 scrypt
   해시만 남으므로 다시 볼 수 없다. 그 자리에서 복사해 앱 담당자에게 안전한 경로로 전달한다.
   분실하면 상세 화면에서 재발급(rotate)하는 수밖에 없고, 재발급하면 기존 secret은 즉시 죽는다.
4. 목록에서 앱을 눌러 들어간 상세 화면의 **"연동 정보"** 표가 앱 개발자에게 그대로 전달할
   값이다(issuer, discovery URL, client_id, redirect_uri).

---

## 3. Express 앱 연동

### 의존성

```bash
npm i express express-session openid-client
```

Node 22+ / ESM(`"type": "module"`) 기준이다.

### 전체 코드

```js
// app.js
import express from 'express'
import session from 'express-session'
import * as client from 'openid-client'

const PORTAL = process.env.PORTAL_BASE_URL          // 예: https://portal.example.co.kr
const SELF = process.env.APP_BASE_URL               // 예: https://shop.example.co.kr
const CLIENT_ID = process.env.OIDC_CLIENT_ID
const CLIENT_SECRET = process.env.OIDC_CLIENT_SECRET

const REDIRECT_URI = `${SELF}/auth/callback`
const POST_LOGOUT_URI = `${SELF}/`
const isHttps = SELF.startsWith('https://')

// discovery URL은 반드시 **끝에 슬래시 없이** `${PORTAL}/oidc` 다.
// 슬래시를 붙이면 openid-client가 응답의 issuer와 문자열 비교에서 실패한다.
// 로컬 개발의 http:// 포털에만 allowInsecureRequests를 켠다. 운영은 https라 이 분기를 안 탄다.
const config = await client.discovery(
  new URL(`${PORTAL}/oidc`),
  CLIENT_ID,
  CLIENT_SECRET,
  undefined,
  PORTAL.startsWith('http://') ? { execute: [client.allowInsecureRequests] } : undefined,
)

const app = express()
// 리버스 프록시 뒤라면 필요하다. secure 쿠키 판정이 이것에 달려 있다.
app.set('trust proxy', 1)

app.use(
  session({
    name: 'shop_session',
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      // Lax여야 한다. Strict면 포털에서 돌아오는 콜백 GET에 쿠키가 안 실려 로그인이 무한 반복된다.
      sameSite: 'lax',
      secure: isHttps,
      maxAge: 8 * 60 * 60 * 1000,
    },
  }),
)

/** 로그인 시작. PKCE verifier·state·nonce를 세션에 넣고 포털로 보낸다. */
app.get('/auth/login', async (req, res) => {
  const codeVerifier = client.randomPKCECodeVerifier()
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier)
  const state = client.randomState()
  const nonce = client.randomNonce()

  // 세 값 모두 콜백에서 다시 필요하다. 쿼리스트링이 아니라 서버 세션에 둔다.
  req.session.oidc = { codeVerifier, state, nonce, returnTo: safeReturnTo(req.query.returnTo) }

  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: REDIRECT_URI,
    // openid는 필수다. profile/email을 빼면 name·email claim이 아예 오지 않는다.
    scope: 'openid profile email roles',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    nonce,
  })

  // 세션이 저장된 뒤에 리다이렉트해야 한다. 저장 전에 보내면 콜백에서 state를 못 찾는다.
  req.session.save(() => res.redirect(url.href))
})

/** 콜백. authorizationCodeGrant가 state·nonce·iss 확인과 id_token 서명 검증(JWKS)까지 한다. */
app.get('/auth/callback', async (req, res) => {
  const flow = req.session.oidc
  delete req.session.oidc
  if (!flow) return res.status(400).send('로그인 요청이 만료되었다. 다시 시도하라.')

  // 포털이 오류를 되돌려 보낸 경우(역할 부족은 여기로 오지 않는다 — 2번 항목 참고).
  if (req.query.error) {
    return res.status(400).send(`로그인 실패: ${req.query.error}`)
  }

  // req.url은 프록시 뒤에서 내부 주소가 될 수 있다. 검증에 쓰는 URL은 등록된 redirect_uri로 다시 만든다.
  const currentUrl = new URL(REDIRECT_URI)
  currentUrl.search = new URL(req.originalUrl, SELF).search

  try {
    const tokens = await client.authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: flow.codeVerifier,
      expectedState: flow.state,
      expectedNonce: flow.nonce,
    })

    const claims = tokens.claims()

    // 세션 고정 공격 방지. 로그인 성공 시점에 세션 id를 새로 뽑는다.
    req.session.regenerate((err) => {
      if (err) return res.status(500).send('세션 생성 실패')

      req.session.user = {
        sub: claims.sub,
        sid: claims.sid,              // back-channel logout 매칭 키
        name: claims.name ?? null,
        email: claims.email ?? null,
        roles: claims.roles ?? [],
        employeeCode: claims.employee_code ?? null,
      }
      // 로그아웃 때 포털에 넘길 힌트. 이게 없으면 포털 세션이 끊기지 않는다.
      req.session.idToken = tokens.id_token

      rememberSid(claims.sid, req.sessionID)
      req.session.save(() => res.redirect(flow.returnTo))
    })
  } catch (err) {
    console.error('authorization code grant 실패', err)
    res.status(400).send('로그인 처리에 실패했다.')
  }
})

/**
 * 로그아웃. POST로만 받는다 —
 * GET으로 두면 다른 사이트의 <img src> 한 줄로 강제 로그아웃이 가능하다.
 */
app.post('/auth/logout', (req, res) => {
  const idToken = req.session.idToken
  const sid = req.session.user?.sid
  if (sid) forgetSid(sid, req.sessionID)

  req.session.destroy(() => {
    // 포털은 브라우저 쿠키 세션을 기준으로 포털 세션을 끊는다. id_token_hint가 없어도
    // 로그아웃은 된다 — 그래도 있으면 넘겨라. 앱을 식별하는 근거가 하나 더 늘고,
    // 그 앱의 링크가 확실히 정리된다. client_id는 openid-client가 알아서 붙인다.
    const url = client.buildEndSessionUrl(config, {
      ...(idToken ? { id_token_hint: idToken } : {}),
      // 포털에 등록된 값과 완전히 같아야 한다. 다르면 조용히 포털 홈으로 보내진다.
      post_logout_redirect_uri: POST_LOGOUT_URI,
    })
    res.redirect(303, url.href)
  })
})

app.get('/', (req, res) => {
  if (!req.session.user) return res.redirect('/auth/login')
  res.json(req.session.user)
})

/** open redirect 방지. 외부 절대 URL을 returnTo로 받지 않는다. */
function safeReturnTo(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : '/'
}

app.listen(3000)
```

`rememberSid` / `forgetSid` 와 back-channel logout 엔드포인트는 8절에 있다.
back-channel logout을 안 쓸 앱이면 그 두 호출을 지우면 된다.

### 인가 요청에서 실제로 나가는 파라미터

`buildAuthorizationUrl` 이 만드는 URL이다. 포털이 요구하는 것은 아래가 전부다.

```
GET {PORTAL}/oidc/authorize
  ?client_id=shop
  &redirect_uri=https%3A%2F%2Fshop.example.co.kr%2Fauth%2Fcallback
  &response_type=code
  &scope=openid+profile+email+roles
  &code_challenge=…&code_challenge_method=S256
  &state=…&nonce=…
```

---

## 4. Fastify 앱 연동

### 의존성

```bash
npm i fastify @fastify/cookie @fastify/formbody openid-client
```

세션 라이브러리를 쓰지 않고 **서명 쿠키 + 서버측 세션 저장소** 로 만든다. 포털 자신이
쓰는 방식과 같다. 저장소를 `Map`으로 둔 것은 예제라서다 — 인스턴스가 둘 이상이거나
재기동으로 세션이 날아가면 곤란한 앱은 Redis나 DB로 바꿔라.

### 전체 코드

```js
// server.js
import { randomBytes } from 'node:crypto'

import cookie from '@fastify/cookie'
import formbody from '@fastify/formbody'
import Fastify from 'fastify'
import * as client from 'openid-client'

// sid → 우리 세션 id 표와 그 헬퍼는 8절의 backchannel.js 한 곳에만 둔다.
// 여기서 다시 선언하면 같은 파일에 합쳤을 때 `bySid has already been declared` 로 기동이 막힌다.
import { forgetSid, rememberSid, takeSessionIds } from './backchannel.js'

const PORTAL = process.env.PORTAL_BASE_URL
const SELF = process.env.APP_BASE_URL
const CLIENT_ID = process.env.OIDC_CLIENT_ID
const CLIENT_SECRET = process.env.OIDC_CLIENT_SECRET

const REDIRECT_URI = `${SELF}/auth/callback`
const POST_LOGOUT_URI = `${SELF}/`
const SESSION_COOKIE = 'shop_session'
const FLOW_COOKIE = 'shop_oidc_flow'
const isHttps = SELF.startsWith('https://')

// 끝에 슬래시를 붙이지 마라. issuer 문자열 비교에서 실패한다.
const config = await client.discovery(
  new URL(`${PORTAL}/oidc`),
  CLIENT_ID,
  CLIENT_SECRET,
  undefined,
  PORTAL.startsWith('http://') ? { execute: [client.allowInsecureRequests] } : undefined,
)

/** 세션 저장소. 예제라서 메모리다 — 운영은 Redis/DB로 바꾼다. */
const sessions = new Map()

const cookieOptions = {
  httpOnly: true,
  // Lax여야 한다. Strict면 포털에서 돌아오는 콜백 GET에 쿠키가 안 실린다.
  sameSite: 'lax',
  secure: isHttps,
  path: '/',
  signed: true,
}

const app = Fastify({ logger: true, trustProxy: true })
await app.register(cookie, { secret: process.env.SESSION_SECRET })
// 포털이 보내는 back-channel logout이 form-urlencoded다.
await app.register(formbody)

/** 모든 요청에 request.user를 채운다. 서명이 깨졌거나 없는 세션이면 쿠키를 지운다. */
app.decorateRequest('user', null)
app.addHook('onRequest', async (request, reply) => {
  const raw = request.cookies[SESSION_COOKIE]
  if (!raw) return

  const unsigned = request.unsignCookie(raw)
  const session = unsigned.valid && unsigned.value ? sessions.get(unsigned.value) : undefined
  if (!session) {
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return
  }

  request.sessionId = unsigned.value
  request.user = session.user
})

app.get('/auth/login', async (request, reply) => {
  const codeVerifier = client.randomPKCECodeVerifier()
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier)
  const state = client.randomState()
  const nonce = client.randomNonce()

  // 인가 요청 ~ 콜백 사이에만 존재하는 값이라 서명 쿠키로 충분하다. 세션을 만들 이유가 없다.
  reply.setCookie(
    FLOW_COOKIE,
    JSON.stringify({ v: codeVerifier, s: state, n: nonce, r: safeReturnTo(request.query.returnTo) }),
    { ...cookieOptions, maxAge: 600 },
  )

  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: REDIRECT_URI,
    scope: 'openid profile email roles',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    nonce,
  })

  return reply.redirect(url.href)
})

app.get('/auth/callback', async (request, reply) => {
  const raw = request.cookies[FLOW_COOKIE]
  reply.clearCookie(FLOW_COOKIE, { path: '/' })

  const unsigned = raw ? request.unsignCookie(raw) : null
  if (!unsigned?.valid || !unsigned.value) {
    return reply.code(400).send('로그인 요청이 만료되었다. 다시 시도하라.')
  }
  const flow = JSON.parse(unsigned.value)

  // request.url은 프록시 뒤에서 내부 주소가 될 수 있다. 등록된 redirect_uri 기준으로 다시 만든다.
  const currentUrl = new URL(REDIRECT_URI)
  currentUrl.search = new URL(request.url, SELF).search

  try {
    const tokens = await client.authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: flow.v,
      expectedState: flow.s,
      expectedNonce: flow.n,
    })

    const claims = tokens.claims()
    const sessionId = randomBytes(32).toString('base64url')

    sessions.set(sessionId, {
      idToken: tokens.id_token, // 로그아웃 때 포털에 넘길 힌트
      sid: claims.sid,
      user: {
        sub: claims.sub,
        name: claims.name ?? null,
        email: claims.email ?? null,
        roles: claims.roles ?? [],
        employeeCode: claims.employee_code ?? null,
      },
    })
    rememberSid(claims.sid, sessionId)

    reply.setCookie(SESSION_COOKIE, sessionId, { ...cookieOptions, maxAge: 8 * 60 * 60 })
    return reply.redirect(flow.r)
  } catch (error) {
    request.log.error({ err: error }, 'authorization code grant 실패')
    return reply.code(400).send('로그인 처리에 실패했다.')
  }
})

/** POST 전용. GET으로 두면 <img src> 한 줄로 강제 로그아웃이 가능하다. */
app.post('/auth/logout', async (request, reply) => {
  const session = request.sessionId ? sessions.get(request.sessionId) : undefined
  if (request.sessionId) sessions.delete(request.sessionId)
  if (session) forgetSid(session.sid, request.sessionId)
  reply.clearCookie(SESSION_COOKIE, { path: '/' })

  // 포털은 브라우저 쿠키 세션을 기준으로 끊는다. id_token_hint가 없어도 로그아웃은 되지만,
  // 있으면 앱 링크 정리가 확실해진다. client_id는 openid-client가 알아서 붙인다.
  const url = client.buildEndSessionUrl(config, {
    ...(session?.idToken ? { id_token_hint: session.idToken } : {}),
    post_logout_redirect_uri: POST_LOGOUT_URI,
  })
  return reply.code(303).redirect(url.href)
})

app.get('/', async (request, reply) => {
  if (!request.user) return reply.redirect('/auth/login')
  return request.user
})

function safeReturnTo(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : '/'
}

await app.listen({ port: 3000, host: '0.0.0.0' })
```

`rememberSid` / `forgetSid` 와 back-channel logout 라우트는 8절에 있다.

---

## 5. API 서버(브라우저 없는 앱) 연동

프런트(SPA 등)가 이미 포털에서 access token을 받았고, 백엔드는 그 토큰만 검증하는 경우다.
백엔드는 client_secret도 openid-client도 필요 없다 — `jose` 하나면 된다.

```bash
npm i jose
```

### access token에 무엇이 들어 있는가

포털의 access token은 RS256 서명 JWT이고 헤더의 `typ` 가 **`at+jwt`** 다. 페이로드에는
**신원 claim이 없다** — 토큰이 로그에 남았을 때 개인정보가 함께 새지 않게 한 설계다.

```json
{
  "iss": "{PORTAL}/oidc",
  "sub": "e67cd5e2-…",
  "aud": "shop",
  "sid": "…",
  "scope": "email openid profile roles",
  "jti": "…", "iat": 1770000000, "exp": 1770000300
}
```

이름·이메일·**역할**이 필요하면 `/oidc/userinfo` 를 불러야 한다. access token만으로는
역할 판정을 할 수 없다.

### 검증 코드

```js
// auth.js
import { createRemoteJWKSet, jwtVerify } from 'jose'

const PORTAL = process.env.PORTAL_BASE_URL
const ISSUER = `${PORTAL}/oidc`
const AUDIENCE = process.env.OIDC_CLIENT_ID   // access token의 aud는 발급받은 client_id다

// JWKS는 모듈 스코프에서 한 번만 만든다. createRemoteJWKSet이 캐시와 rate limit을 갖고 있어서
// 요청마다 새로 만들면 매 검증이 네트워크 왕복이 된다.
const jwks = createRemoteJWKSet(new URL(`${ISSUER}/jwks`))

/** 통과하면 토큰 정보를, 아니면 null. 사유를 호출자에게 흘리지 않는다. */
export async function verifyAccessToken(authorization) {
  if (!authorization?.startsWith('Bearer ')) return null
  const token = authorization.slice(7).trim()

  try {
    const { payload } = await jwtVerify(token, jwks, {
      // 이 셋을 빼면 검증이 아니다.
      // iss: 다른 OP가 서명한 토큰을 막는다
      // aud: 다른 앱에 발급된 토큰을 이 앱에 재생하는 것을 막는다
      // typ: id_token을 access token으로 재생하는 것을 막는다
      issuer: ISSUER,
      audience: AUDIENCE,
      typ: 'at+jwt',
      algorithms: ['RS256'],
      // exp/nbf는 jwtVerify가 항상 검사한다. 서버 시계 오차만 허용치를 준다.
      clockTolerance: 5,
    })

    if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') return null

    return {
      sub: payload.sub,
      sid: payload.sid,
      scope: String(payload.scope ?? '').split(' ').filter(Boolean),
    }
  } catch {
    return null
  }
}

/**
 * 역할·이름·이메일은 여기서만 얻는다.
 * 포털이 sid로 포털 세션 생존을 확인하므로, 로그아웃된 토큰은 서명이 멀쩡해도 401이 된다.
 * access token 수명이 5분이라 그 사이의 로그아웃을 즉시 반영하는 유일한 수단이기도 하다.
 */
export async function fetchUserinfo(accessToken) {
  const res = await fetch(`${ISSUER}/userinfo`, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) return null
  return res.json()
}
```

Express 미들웨어로 쓰는 예:

```js
app.use(async (req, res, next) => {
  const verified = await verifyAccessToken(req.headers.authorization)
  if (!verified) {
    res.set('www-authenticate', 'Bearer error="invalid_token"')
    return res.status(401).json({ error: 'invalid_token' })
  }
  req.token = verified
  next()
})
```

주의:

- 포털은 **introspection·revocation 엔드포인트를 제공하지 않는다.** 토큰이 살아 있는지
  서버측에서 확인하는 방법은 `/oidc/userinfo` 호출뿐이다. 매 요청마다 부르면 포털이
  병목이 되므로, 짧게(예: 60초) 캐시하고 5분 만료에 기대는 쪽이 현실적이다.
- 서명 검증만으로 통과시키는 API는 **최대 5분간 로그아웃을 반영하지 못한다.** 그 5분이
  받아들일 수 없는 API라면 요청마다 userinfo를 불러야 한다. 이건 정책 결정이다.
- `aud`를 검사하지 않으면 다른 하위 앱에 발급된 토큰이 이 API를 통과한다. 반드시 넣어라.

---

## 6. claim 레퍼런스

### id_token

`{PORTAL}/oidc/token` 응답의 `id_token`. 수명 300초, RS256, 헤더 `typ: "JWT"`.

| claim | 타입 | 출처 | 언제 없는가 |
| --- | --- | --- | --- |
| `iss` | string | 포털 `APP_BASE_URL` + `/oidc` | 항상 있다 |
| `aud` | string | 요청한 `client_id` (배열 아님) | 항상 있다 |
| `sub` | string | Keycloak 사용자 UUID | 항상 있다 |
| `iat` / `exp` | number | 서명 시각 / +300초 | 항상 있다 |
| `sid` | string | 포털이 발급하는 (포털 세션 × 앱) 링크 id | 항상 있다 |
| `nonce` | string | 인가 요청의 `nonce` 를 그대로 반사 | 요청에 `nonce`를 안 보냈으면 없다 |
| `name` | string | Keycloak id_token의 `name` (없으면 `preferred_username`) → 포털 세션 | `scope`에 `profile`이 없거나, Keycloak 계정에 이름이 비어 있으면 없다 |
| `preferred_username` | string | Keycloak id_token의 `preferred_username`(= 로그인 아이디) → 포털 세션 | `scope`에 `profile`이 없으면 없다. 포털 세션이 이 컬럼을 갖기 전에 만들어진 옛 세션도 없다 |
| `email` | string | Keycloak id_token의 `email` → 포털 세션 | `scope`에 `email`이 없거나, 계정에 이메일이 없으면 없다 |
| `email_verified` | boolean | **항상 `false`** | `email`이 있을 때만 함께 나온다 |
| `employee_code` | string | Keycloak 사용자의 `employeeCode` attribute(= A10 사번) → id_token `employee_code` mapper → 포털 세션 | `scope`에 `profile`이 없거나, 그 사용자에게 사번이 연동돼 있지 않으면 없다 |
| `roles` | string[] | Keycloak id_token의 `realm_access.roles` → 포털 세션 | `scope`에 `roles`가 없으면 키 자체가 없다. 있으면 항상 배열이다(역할이 없으면 빈 배열) |

주의할 점:

- `preferred_username` 은 Keycloak 로그인 아이디다. 표시용 성명(`name`)과 다른 값이며,
  동명이인이 있어도 서로 구분된다. 다만 사용자를 식별하는 키로는 `sub` 를 써라 —
  Keycloak에서 아이디를 바꾸면 `preferred_username` 도 함께 바뀐다.
- `employee_code` 와 `roles` 도 scope로 통제된다. 사번은 `profile`, 역할은 `roles` 를
  인가 요청의 `scope` 에 넣어야 실린다. 권장 scope는 `openid profile email roles` 다.
- `email_verified` 는 **언제나 `false`** 다. 포털은 이메일을 검증하지 않으므로 `true`로
  거짓말하지 않는다. 이 값으로 분기하지 마라.
- 역할은 최상위 `roles` 배열 **하나뿐**이다. Keycloak의 `realm_access.resource_access`
  구조는 흉내내지 않는다.
- `azp`, `auth_time`, `at_hash` 는 넣지 않는다.
- 값은 **토큰 교환 시점에 포털 세션에서 다시 읽는다.** 인가 코드 발급 시점의 값을 복사해
  두지 않으므로, 그 사이에 포털 세션이 끊겼으면 토큰 대신 `invalid_grant` 가 온다.

### userinfo (`GET {PORTAL}/oidc/userinfo`)

`Authorization: Bearer <access_token>` **헤더만** 받는다. 쿼리 파라미터 방식은 토큰이
로그·referer에 남으므로 지원하지 않는다.

id_token과 같은 규칙으로 `sub`, `name`, `preferred_username`, `email`, `email_verified`,
`employee_code`, `roles` 를 준다. `sid` / `nonce` / `aud` 는 없다.
scope 게이팅은 **access token에 실린 scope**(= 인가 요청 때의 scope)를 따른다.

실제 응답 예:

```json
{
  "sub": "e67cd5e2-…",
  "name": "Portal Admin",
  "preferred_username": "admin.portal",
  "email": "admin.portal@mega.local",
  "email_verified": false,
  "roles": ["portal-admin", "portal-user"]
}
```

401이 오는 경우: 헤더 없음 / 서명·`typ`·`iss` 불일치 / 만료 / **포털 세션이 이미 끝남**.
본문은 `{"error":"invalid_token", …}` 이다.

### 신원의 최신성

포털 세션은 **Keycloak 로그인 시점의 스냅샷**이다. Keycloak에서 사용자의 역할이나 사번을
바꿔도, 그 사용자가 포털에 다시 로그인하기 전까지는 id_token·userinfo에 반영되지 않는다.
권한을 즉시 회수해야 하면 Keycloak에서 그 사용자의 세션을 강제로 끊어야 한다.

---

## 7. 역할 기반 접근 제어

역할의 원본은 Keycloak의 **realm role** 이다. 포털은 로그인 시 `realm_access.roles` 를
세션에 저장하고, 하위 앱에는 최상위 `roles` 배열로 넘긴다.

### 포털이 하는 검사

등록 화면의 "필요 역할"(`requiredRoles`)이 비어 있지 않으면, 포털은 `/oidc/authorize`
단계에서 사용자의 역할과 대조한다. **하나라도 겹치면 통과**(AND가 아니라 OR)다.

실패하면 포털은 **하위 앱으로 리다이렉트하지 않는다.** 403 화면을 포털에서 직접 보여준다:

```
<h1>접근 권한이 없다</h1>
이 앱은 portal-admin 역할이 필요하다. 관리자에게 요청하라.
```

`error=access_denied` 로 되돌리지 않는 이유는, 하위 앱이 곧바로 다시 인가 요청을 보내
무한 리다이렉트 루프가 되는 것이 예측 가능한 실패이기 때문이다. **따라서 하위 앱은
"역할 부족" 을 콜백에서 관측할 수 없다.** 사용자는 포털 화면에 남는다.

### 하위 앱이 해야 하는 검사

포털의 `requiredRoles` 는 **문지기 하나**다. "이 앱에 들어올 수 있는가"만 결정한다.
앱 안의 세부 권한("이 사용자가 정산을 승인할 수 있는가")은 앱이 직접 판단해야 한다.

```js
/** roles claim은 항상 배열이다(권한이 없으면 빈 배열). */
function hasRole(user, ...roles) {
  return roles.some((role) => user.roles.includes(role))
}

app.post('/settlements/:id/approve', (req, res) => {
  if (!req.session.user) return res.redirect('/auth/login')
  if (!hasRole(req.session.user, 'shop-admin')) {
    return res.status(403).send('승인 권한이 없다.')
  }
  // …
})
```

설계 지침:

- 앱 진입 자체를 막을 역할만 포털의 `requiredRoles` 에 넣는다. 화면 단위 권한을 거기에
  나열하지 마라 — 역할이 하나만 겹쳐도 통과하는 OR 규칙이라 의도대로 동작하지 않는다.
- 역할 문자열은 앱마다 접두사를 붙여 관리한다(`shop-admin`, `wms-operator`). realm 전체가
  하나의 이름 공간이다.
- 세션에 넣어 둔 `roles` 는 로그인 시점 값이다. 장시간 세션을 쓰는 앱이라면 앱 세션 수명을
  짧게 잡거나, 중요한 작업 직전에 `/oidc/userinfo` 로 다시 확인하라.
- 역할 추가·회수는 Keycloak 관리 콘솔에서 한다. 포털에는 역할을 만드는 기능이 없다.

---

## 8. 로그아웃 / 단일 로그아웃

### 흐름

RP-initiated logout은 실제로 네 홉이다(실측).

```
① 앱 POST /auth/logout            앱 세션을 먼저 지우고 302
      ▼
② {PORTAL}/oidc/logout?client_id=shop&id_token_hint=…&post_logout_redirect_uri=…
      브라우저 쿠키 세션을 기준으로 포털 세션 삭제
      + 같은 세션을 쓰던 다른 앱들에 back-channel logout 발송
      ▼
③ {KEYCLOAK}/realms/…/logout?post_logout_redirect_uri={PORTAL}/oidc/logout/callback…
      Keycloak SSO 세션 삭제
      ▼
④ {PORTAL}/oidc/logout/callback?client_id=shop&to=https%3A%2F%2Fshop…%2F
      to를 등록값과 다시 대조한 뒤
      ▼
⑤ https://shop.example.co.kr/
```

③에서 Keycloak에 넘어가는 것은 **포털 자신의 주소**다. 하위 앱 주소를 그대로 넘기면
Keycloak이 `Invalid redirect uri` 로 거부하고, 그러면 Keycloak SSO 세션이 살아남는다.
하위 앱으로 돌아오는 마지막 한 홉을 ④가 맡는다. 앱은 이 내부 사정을 몰라도 되지만,
로그아웃 후 URL에 낯선 홉이 보이는 이유가 이것이다.

### 하위 앱이 지켜야 할 것

1. **`id_token_hint` 는 있으면 넘겨라(필수는 아니다).** 포털이 세션을 끊는 근거는
   브라우저가 들고 온 포털 세션 쿠키이지 hint가 아니다 — hint가 없어도 포털·Keycloak
   세션은 함께 끊긴다. hint를 넘기면 어느 앱의 요청인지가 확실해져 그 앱의 링크 정리가
   보장된다. 단, hint가 **다른 사람의 세션**을 가리키면 포털은 아무 것도 하지 않고
   리다이렉트만 한다(남의 세션을 끊게 두지 않는다).
   포털 세션 쿠키가 아예 없는 요청(브라우저가 아닌 curl 등)도 마찬가지로 아무 상태도
   바꾸지 않는다.
2. `post_logout_redirect_uri` 는 **등록된 값과 완전히 같아야 한다.** 다르면 오류 없이
   조용히 포털 홈으로 보내진다(open redirect 방지).
3. 로그아웃 라우트는 **POST**로 둬라. GET이면 외부 사이트의 `<img>` 한 줄로 강제
   로그아웃이 된다.
4. `state` 를 함께 넘기면 돌아올 때 쿼리에 그대로 붙어 온다.

### back-channel logout 수신 (선택)

`backchannel_logout_uri` 를 등록해 두면, 포털 세션이 끝나는 **모든 경우**에 그 주소로
`logout_token` 이 POST된다: 다른 하위 앱발 로그아웃, 포털 자체 로그아웃, Keycloak 강제
로그아웃, 세션 만료. 등록하지 않은 앱은 자체 세션 만료를 따를 뿐이다.

포털이 보내는 요청:

```
POST {등록한 backchannel_logout_uri}
Content-Type: application/x-www-form-urlencoded

logout_token=eyJhbGciOiJSUzI1NiIsImtpZCI6…
```

- 브라우저를 거치지 않는 **서버-서버** 호출이다. 쿠키도 Origin도 없다. `logout_token`
  서명 검증이 유일한 인증 수단이다.
- 타임아웃 5초. **재시도하지 않는다.** 응답 본문은 보지 않는다.
- 헤더 `typ` 는 `logout+jwt`, 수명 120초.

```js
// backchannel.js
import { createRemoteJWKSet, jwtVerify } from 'jose'

const ISSUER = `${process.env.PORTAL_BASE_URL}/oidc`
const CLIENT_ID = process.env.OIDC_CLIENT_ID
const BACKCHANNEL_EVENT = 'http://schemas.openid.net/event/backchannel-logout'

const jwks = createRemoteJWKSet(new URL(`${ISSUER}/jwks`))

/** 통과하면 { sub, sid }, 아니면 null. */
export async function verifyLogoutToken(logoutToken) {
  if (typeof logoutToken !== 'string') return null

  try {
    const { payload } = await jwtVerify(logoutToken, jwks, {
      issuer: ISSUER,
      audience: CLIENT_ID,
      // typ 검사가 없으면 남의 id_token을 로그아웃 토큰으로 재생할 수 있다.
      typ: 'logout+jwt',
      algorithms: ['RS256'],
      clockTolerance: 5,
    })

    // OIDC Back-Channel Logout 1.0 §2.4 — events가 없거나 nonce가 있으면 거부한다.
    // nonce 금지는 id_token을 그대로 로그아웃 토큰으로 쓰는 것을 막는 규칙이다.
    if (!payload.events?.[BACKCHANNEL_EVENT]) return null
    if ('nonce' in payload) return null
    if (typeof payload.sid !== 'string') return null

    return { sub: payload.sub, sid: payload.sid }
  } catch {
    return null
  }
}
```

세션을 찾으려면 로그인 때 `sid → 우리 세션 id` 를 기록해 둬야 한다. 같은 사용자가
여러 브라우저로 들어와 있으면 sid 하나에 세션이 여럿 걸릴 수 있으므로 Set으로 둔다.

```js
const bySid = new Map()   // sid -> Set<우리 세션 id>

export function rememberSid(sid, sessionId) {
  if (!sid) return
  if (!bySid.has(sid)) bySid.set(sid, new Set())
  bySid.get(sid).add(sessionId)
}

export function forgetSid(sid, sessionId) {
  const set = sid ? bySid.get(sid) : undefined
  if (!set) return
  set.delete(sessionId)
  if (set.size === 0) bySid.delete(sid)
}

export function takeSessionIds(sid) {
  const set = bySid.get(sid)
  bySid.delete(sid)
  return set ? [...set] : []
}
```

Express 라우트:

```js
app.post(
  '/auth/backchannel-logout',
  express.urlencoded({ extended: false }),
  async (req, res) => {
    const verified = await verifyLogoutToken(req.body.logout_token)
    // 응답 코드로 검증 결과를 알려도 상관없다. 포털은 재시도하지 않는다.
    if (!verified) return res.status(400).set('cache-control', 'no-store').end()

    for (const id of takeSessionIds(verified.sid)) req.sessionStore.destroy(id, () => {})

    res.status(200).set('cache-control', 'no-store').end()
  },
)
```

Fastify 라우트(4절의 `sessions` Map 기준):

```js
app.post('/auth/backchannel-logout', async (request, reply) => {
  const verified = await verifyLogoutToken(request.body?.logout_token)
  if (!verified) return reply.code(400).header('cache-control', 'no-store').send()

  for (const id of takeSessionIds(verified.sid)) sessions.delete(id)

  return reply.code(200).header('cache-control', 'no-store').send()
})
```

이 엔드포인트는 앱의 CSRF/Origin 검사 대상에서 **빼야 한다.** 브라우저가 아니라 포털이
직접 부르므로 Origin 헤더가 없다.

`sid` 를 저장할 곳이 없거나 back-channel logout을 다루기 곤란하면 등록하지 않아도 된다.
그 경우 앱 세션 수명을 짧게(예: 1시간) 잡아 로그아웃 반영 지연을 줄인다.

---

## 9. 환경변수 템플릿

하위 앱의 `.env` 예시다. `client_secret` 은 등록 화면에서 받은 값으로 바꿔라.

```bash
# ── 포털(OIDC Provider) ───────────────────────────────────────
# 끝에 슬래시를 붙이지 않는다. 코드에서 `${PORTAL_BASE_URL}/oidc` 로 조립한다.
PORTAL_BASE_URL=https://portal.example.co.kr

# ── 이 앱 ────────────────────────────────────────────────────
# 포털에 등록한 redirect_uri가 정확히 `${APP_BASE_URL}/auth/callback` 이어야 한다.
APP_BASE_URL=https://shop.example.co.kr
PORT=3000

# ── 포털에서 발급받은 클라이언트 자격증명 ──────────────────────
OIDC_CLIENT_ID=shop
# 등록·재발급 화면에 한 번만 나온다. 분실하면 재발급만 가능하다.
OIDC_CLIENT_SECRET=<포털-등록-화면에서-복사한-값>

# ── 앱 세션 쿠키 서명 키 ─────────────────────────────────────
# openssl rand -base64 32
SESSION_SECRET=<32자-이상-무작위-값>
```

로컬 개발이라면 포털이 http일 수 있다. 그때만 코드가 `allowInsecureRequests` 를 켜도록
`PORTAL_BASE_URL` 의 스킴으로 분기해 뒀다(3·4절 참고). 별도 플래그를 두지 않는다.

`.env` 는 저장소에 커밋하지 않는다. `.env.example` 에는 키 이름만 남기고 값은 비워라.

---

## 10. 문제 해결

아래 오류 문구는 실제 응답에서 그대로 옮긴 것이다.

### discovery 단계

| 증상 | 원인 | 해결 |
| --- | --- | --- |
| `client.discovery` 가 issuer 불일치로 throw | discovery URL에 **끝 슬래시**를 붙였다(`.../oidc/`) | ``new URL(`${PORTAL}/oidc`)`` — 슬래시 없이 |
| discovery가 404 | `{PORTAL}/.well-known/openid-configuration`(루트 bare)을 직접 쳤다. 일부러 404다 | issuer URL(`{PORTAL}/oidc`)을 openid-client에 넘기고 경로 조립은 라이브러리에 맡겨라 |
| `ClientError: only requests to HTTPS are allowed` (code `OAUTH_HTTP_REQUEST_FORBIDDEN`) | 개발용 http 포털에 붙는데 `allowInsecureRequests` 가 없다 | `{ execute: [client.allowInsecureRequests] }` 를 discovery 5번째 인자로. openid-client 6은 기본적으로 https만 허용한다 — 인가 코드와 토큰이 평문으로 오가는 것을 막기 위한 기본값이라 **운영에서 켜면 안 된다** |
| discovery는 되는데 토큰 요청이 실패 | Keycloak 주소를 issuer로 넣었다 | 하위 앱의 issuer는 **포털**이다. Keycloak을 직접 보지 않는다 |

### 인가 단계 (`/oidc/authorize`)

| 증상 | 원인 |
| --- | --- |
| 포털 화면 400 `알 수 없는 앱이다` | `client_id` 가 등록돼 있지 않거나 **"바로 사용"이 꺼져 있다**. 리다이렉트하지 않는다 |
| 포털 화면 400 `redirect_uri가 등록된 값과 다르다` | 완전 문자열 일치 실패. 끝 슬래시, http/https, 포트, 호스트명(`localhost` vs `127.0.0.1`)을 대조하라. 이 단계에서는 **절대 리다이렉트하지 않는다** — 틀린 주소로 오류를 되돌리는 것 자체가 취약점이다 |
| 포털 화면 403 `접근 권한이 없다` | `requiredRoles` 부족. 앱으로 되돌리지 않는다(무한 루프 방지). Keycloak에서 역할을 부여해야 한다 |
| 앱 콜백에 `?error=invalid_request&error_description=code_challenge…필요하다` | PKCE 파라미터가 없다. `code_challenge` + `code_challenge_method=S256` 이 **필수**다 |
| 앱 콜백에 `?error=invalid_scope` | `scope` 에 `openid` 가 없다 |
| 앱 콜백에 `?error=unsupported_response_type` | `response_type` 이 `code` 가 아니다 |
| 앱 콜백에 `?error=request_not_supported` | `request` (JAR)를 보냈다. 지원하지 않는다 |
| 앱 콜백에 `?error=request_uri_not_supported` | `request_uri` (JAR)를 보냈다. 지원하지 않는다. 둘을 함께 보내면 이쪽 값이 온다 |

### 토큰 교환 단계 (`/oidc/token`)

| 응답 | 원인 |
| --- | --- |
| `401 {"error":"invalid_client"}` | client_id/secret 불일치. secret을 재발급했는데 앱 `.env` 를 안 고쳤을 때 가장 흔하다. Basic 헤더와 body에 secret을 **동시에** 보내면 `400 invalid_request`(인증 방법이 둘 이상) |
| `400 {"error":"invalid_grant","error_description":"인가 코드가 유효하지 않다"}` | ① 코드 재사용(1회용이다) ② 60초 만료 ③ `code_verifier` 불일치 ④ 토큰 요청의 `redirect_uri` 가 인가 요청 때와 다름 ⑤ 다른 클라이언트의 코드 |
| `400 {"error":"invalid_grant","error_description":"포털 세션이 이미 종료됐다"}` | 인가와 교환 사이에 포털 세션이 끊겼다(로그아웃·만료). 다시 로그인시켜라 |
| `400 {"error":"unsupported_grant_type"}` | `refresh_token` 을 시도했다. 포털은 refresh token을 발급하지도 받지도 않는다 |

콜백에서 `unknown state` / "로그인 요청이 만료되었다" 가 자주 뜨면 앱 세션 쿠키가
`SameSite=Strict` 인지 확인하라. Strict면 포털에서 돌아오는 콜백 GET에 쿠키가 실리지
않아 state를 못 찾는다. `Lax` 여야 한다.

### userinfo

| 응답 | 원인 |
| --- | --- |
| `401 {"error":"invalid_token"}` | 헤더 없음 / `Bearer ` 접두사 없음 / 서명·`iss`·`typ` 불일치 / 만료(5분) / **포털 세션이 끝남** |
| 쿼리 파라미터로 토큰을 보냈는데 401 | 헤더 방식만 지원한다. 토큰이 로그·referer에 남는 것을 막기 위해서다 |

### 로그아웃

| 증상 | 원인 |
| --- | --- |
| 로그아웃했는데 다시 로그인하면 **자격증명 없이 통과** | 브라우저가 포털 세션 쿠키를 싣지 않았다(다른 브라우저·시크릿 창에서 로그아웃을 보냈거나, 앱이 서버에서 대신 호출했다). 로그아웃은 **사용자의 브라우저를 포털로 보내는 리다이렉트**여야 한다. `id_token_hint` 가 다른 포털 세션을 가리켜도 같은 결과가 된다 |
| 로그아웃 후 앱이 아니라 **포털 홈**으로 간다 | `post_logout_redirect_uri` 가 등록값과 완전히 같지 않다(또는 아예 등록돼 있지 않다). 오류를 내지 않고 조용히 포털 홈으로 보낸다 — open redirect 방지 |
| Keycloak 화면에 `Invalid redirect uri` | 포털이 Keycloak에 하위 앱 주소를 넘기던 시절의 결함이다. 현재 코드는 포털 자신의 주소만 넘기고 `/oidc/logout/callback` 이 마지막 홉을 맡는다. 이 화면이 다시 보이면 포털 쪽 회귀다 |
| back-channel logout이 안 온다 | `backchannel_logout_uri` 미등록 / 앱이 5초 안에 응답하지 못함 / 포털에서 앱으로 나가는 방화벽이 막힘. 포털은 **재시도하지 않는다** |
| back-channel logout이 403 | 앱의 CSRF·Origin 검사에 걸렸다. 서버-서버 호출이라 Origin이 없다. 그 경로를 검사에서 빼라 |

---

## 11. 운영 체크리스트

### 전송

- [ ] 포털과 하위 앱 모두 **https**로 서비스한다. 등록 화면이 loopback을 뺀 http URI를
      거부하지만, 앱 자체가 http로 떠 있으면 그 검사를 우회한 것과 같다.
- [ ] 하위 앱 코드에서 `allowInsecureRequests` 가 **운영 경로로 들어오지 않는지** 확인한다.
      `PORTAL_BASE_URL` 스킴으로 분기하고 상수로 켜 두지 마라.
- [ ] 리버스 프록시 뒤라면 `trust proxy`(Express) / `trustProxy`(Fastify)를 켜고
      `X-Forwarded-Proto` 를 전달한다. 안 그러면 secure 쿠키 판정이 틀린다.

### 자격증명

- [ ] `client_secret` 은 `.env` 또는 시크릿 저장소에만 둔다. 저장소·로그·이슈에 남기지 않는다.
- [ ] 유출이 의심되면 포털 상세 화면에서 **재발급**한다. 재발급 즉시 기존 secret이 죽으므로
      앱 `.env` 교체와 재기동을 같은 창에서 처리한다.
- [ ] 앱을 폐기할 때는 `/admin/sso-clients` 에서 삭제한다. 클라이언트 행을 지우면 그 앱의
      로그인이 그 순간 끊긴다.
- [ ] 준비 중인 앱은 "바로 사용"을 꺼 둔 채 등록한다.

### 세션 쿠키 (하위 앱)

- [ ] `httpOnly: true`
- [ ] `sameSite: 'lax'` — Strict면 OIDC 콜백에서 세션을 잃는다
- [ ] `secure: true` (https 운영)
- [ ] `path: '/'`, 서명된 값 또는 추측 불가능한 랜덤 id
- [ ] 로그인 성공 시점에 세션 id를 새로 뽑는다(세션 고정 방지)
- [ ] 앱 세션 수명을 포털 세션보다 길게 잡지 않는다. back-channel logout을 등록하지 않은
      앱이라면 특히 짧게 잡아라

### 포털 재기동과 JWKS

- 서명키(RS256)의 원본은 포털 DB의 `sso_signing_keys` 다. 첫 기동 때 한 쌍을 만들고
  그 뒤로는 재기동해도 `kid` 가 유지된다 — 하위 앱의 JWKS 캐시가 깨지지 않는다.
- [ ] 하위 앱은 `createRemoteJWKSet` 인스턴스를 **모듈 스코프에서 한 번만** 만든다.
      요청마다 새로 만들면 캐시가 없어 매 검증이 네트워크 왕복이 된다.
- [ ] 포털 DB를 새로 만들거나 `sso_signing_keys` 를 비우면 `kid` 가 바뀐다. 그 순간
      하위 앱들이 캐시된 JWKS로 검증에 실패한다. `createRemoteJWKSet` 이 모르는 `kid` 를
      만나면 재조회하므로 대개 자동 회복되지만, 계획된 작업이라면 하위 앱 재기동을 함께 잡아라.
- [ ] `jwks_uri` 응답은 `cache-control: public, max-age=300` 이다. 앞단 캐시를 두더라도
      이보다 길게 잡지 마라.

### 운영 전 확인

- [ ] `{PORTAL}/oidc/.well-known/openid-configuration` 의 `issuer` 가 운영 도메인인가
      (포털 `.env` 의 `APP_BASE_URL` 파생이다)
- [ ] 등록된 `redirect_uri` 가 앱이 실제로 보내는 값과 한 글자도 다르지 않은가
- [ ] 로그인 → 로그아웃 → 재로그인에서 **자격증명 화면이 다시 나오는가**
      (나오지 않으면 로그아웃이 사용자의 브라우저를 포털로 보내지 않은 것이다)
- [ ] `requiredRoles` 를 건 앱에서 권한 없는 계정이 403을 받는가
