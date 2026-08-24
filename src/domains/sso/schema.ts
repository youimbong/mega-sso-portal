import { boolean, index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'

/**
 * 포털을 OP로 바라보는 하위 앱(= OIDC confidential client).
 * apps(카탈로그) 테이블과 일부러 분리한다 — 카탈로그 카드가 없는 머신 클라이언트가 있고,
 * 이 행의 삭제는 카드가 사라지는 사건이 아니라 하위 앱 로그인이 그 순간 끊기는 사건이다.
 */
export const ssoClients = pgTable('sso_clients', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** 하위 앱이 보내는 client_id. apps.slug와 같은 규칙(^[a-z0-9][a-z0-9-]*$)으로 발급한다. */
  clientId: text('client_id').notNull().unique(),
  name: text('name').notNull(),
  /** scrypt 해시. 평문 secret은 등록·재발급 화면에 1회 보여주고 어디에도 저장하지 않는다. */
  secretHash: text('secret_hash').notNull(),
  /** 완전 일치로만 비교한다. 와일드카드·prefix 매칭은 지원하지 않는다. */
  redirectUris: jsonb('redirect_uris').$type<string[]>().notNull(),
  postLogoutRedirectUris: jsonb('post_logout_redirect_uris').$type<string[]>().notNull().default([]),
  /** 없으면 back-channel logout을 보내지 않는다. 그 앱은 자체 세션 만료를 따른다. */
  backchannelLogoutUri: text('backchannel_logout_uri'),
  /**
   * 로그인에 필요한 Keycloak realm role. 비어 있으면 로그인한 모두 허용.
   * app_roles(카탈로그 노출 정책)와 의미가 다르다 — 이쪽은 인가 판단이다.
   */
  requiredRoles: jsonb('required_roles').$type<string[]>().notNull().default([]),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * 인가 코드. 수명 60초, 1회용.
 * 사용자 claim을 복사해 담지 않고 포털 세션 id만 들고 있는다 —
 * 코드 발급과 교환 사이에 세션이 끊겼으면 토큰을 내주면 안 되기 때문이다.
 */
export const ssoAuthCodes = pgTable('sso_auth_codes', {
  code: text('code').primaryKey(),
  clientId: text('client_id').notNull(),
  portalSessionId: text('portal_session_id').notNull(),
  /** 토큰 요청의 redirect_uri가 이 값과 같아야 한다(RFC 6749 4.1.3). */
  redirectUri: text('redirect_uri').notNull(),
  scope: text('scope').notNull(),
  nonce: text('nonce'),
  /** PKCE. S256만 받으므로 method 컬럼을 두지 않는다. */
  codeChallenge: text('code_challenge').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * OP 서명키(RS256). 프로세스 메모리에 두면 재기동마다 kid가 바뀌어
 * 하위 앱의 JWKS 캐시가 깨지므로 DB가 유일한 원본이다.
 * 행이 여러 개면 서명은 가장 최근 행으로, JWKS는 전 행을 노출한다(회전은 INSERT 하나로 끝난다).
 */
export const ssoSigningKeys = pgTable('sso_signing_keys', {
  /** jose calculateJwkThumbprint(공개 JWK, 'sha256') 값. */
  kid: text('kid').primaryKey(),
  privateJwk: jsonb('private_jwk').$type<Record<string, unknown>>().notNull(),
  publicJwk: jsonb('public_jwk').$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * "이 포털 세션으로 어떤 하위 앱에 로그인했는가".
 * 포털 세션이 끝날 때 여기 걸린 앱들에게 back-channel logout token을 보낸다.
 * sessions에 FK를 걸지 않는다 — cascade로 먼저 지워지면 보낼 대상을 잃는다.
 */
export const ssoSessions = pgTable(
  'sso_sessions',
  {
    /** 하위 앱에 id_token의 sid로 넘기는 값. 포털 세션 id를 그대로 주지 않는다. */
    sid: text('sid').primaryKey(),
    portalSessionId: text('portal_session_id').notNull(),
    clientId: text('client_id').notNull(),
    userSub: text('user_sub').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('sso_sessions_portal_session_idx').on(t.portalSessionId),
    unique('sso_sessions_session_client_uq').on(t.portalSessionId, t.clientId),
  ],
)

export type SsoClient = typeof ssoClients.$inferSelect
export type SsoAuthCode = typeof ssoAuthCodes.$inferSelect
export type SsoSession = typeof ssoSessions.$inferSelect
