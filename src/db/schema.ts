import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * 포털에서 앱을 여는 방식.
 * 대상 앱이 X-Frame-Options / CSP frame-ancestors 로 embed를 막으면 iframe은 빈 화면이 된다.
 * 그래서 앱마다 명시적으로 지정한다.
 */
export const launchMode = pgEnum('launch_mode', ['link', 'iframe'])

/** 포털에 노출할 앱 카탈로그. 계정 자체는 Keycloak이 소유하고, 여기엔 메타데이터만 둔다. */
export const apps = pgTable('apps', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  targetUrl: text('target_url').notNull(),
  mode: launchMode('mode').notNull().default('link'),
  sortOrder: integer('sort_order').notNull().default(0),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * 앱을 볼 수 있는 Keycloak realm role.
 * 한 앱에 행이 하나도 없으면 = 로그인한 모든 사용자에게 노출.
 */
export const appRoles = pgTable(
  'app_roles',
  {
    appId: uuid('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
  },
  (t) => [primaryKey({ columns: [t.appId, t.role] })],
)

/**
 * 서버측 세션.
 * 쿠키에는 세션 id만 담는다 — Keycloak 토큰은 합쳐서 3KB를 넘어 쿠키 4KB 한계에 걸리고,
 * 서버에 두어야 back-channel logout(sid로 세션을 찾아 종료)과 관리자 강제 로그아웃이 가능하다.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userSub: text('user_sub').notNull(),
    /** Keycloak SSO 세션 id(`sid` claim). back-channel logout에서 이 값으로 세션을 찾는다. */
    ssoSid: text('sso_sid'),
    email: text('email'),
    name: text('name'),
    roles: jsonb('roles').$type<string[]>().notNull().default([]),
    /** RP-initiated logout의 id_token_hint 로만 쓴다. */
    idToken: text('id_token').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sessions_sso_sid_idx').on(t.ssoSid), index('sessions_user_sub_idx').on(t.userSub)],
)

export type App = typeof apps.$inferSelect
export type NewApp = typeof apps.$inferInsert
export type Session = typeof sessions.$inferSelect
