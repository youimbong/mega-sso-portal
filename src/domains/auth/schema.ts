import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

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
    /**
     * Keycloak의 `preferred_username`. name과 따로 둔다 —
     * 하나로 합치면 표시용 성명이 preferred_username 으로 나가 동명이인이 한 사람으로 합쳐진다.
     */
    username: text('username'),
    /** Keycloak의 employeeCode attribute(= A10 사번). 하위 앱 토큰의 employee_code claim 원본이다. */
    employeeCode: text('employee_code'),
    roles: jsonb('roles').$type<string[]>().notNull().default([]),
    /** RP-initiated logout의 id_token_hint 로만 쓴다. */
    idToken: text('id_token').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sessions_sso_sid_idx').on(t.ssoSid), index('sessions_user_sub_idx').on(t.userSub)],
)

export type Session = typeof sessions.$inferSelect
