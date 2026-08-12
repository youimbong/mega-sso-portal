import {
  boolean,
  integer,
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

export type App = typeof apps.$inferSelect
export type NewApp = typeof apps.$inferInsert
