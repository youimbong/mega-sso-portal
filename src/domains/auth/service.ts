import { randomBytes } from 'node:crypto'

import { and, eq, gt, lt } from 'drizzle-orm'

import { db } from '../../shared/db.js'
import { sessions } from './schema.js'

/** 포털 세션 수명. Keycloak realm의 ssoSessionMaxLifespan(10시간)에 맞춘다. */
export const SESSION_TTL_MS = 10 * 60 * 60 * 1000

export const SESSION_COOKIE = 'mega_portal_session'
export const FLOW_COOKIE = 'mega_portal_oidc_flow'

export type CurrentUser = {
  sessionId: string
  sub: string
  email: string | null
  name: string | null
  roles: string[]
}

export async function createSession(input: {
  sub: string
  ssoSid?: string
  email?: string
  name?: string
  roles: string[]
  idToken: string
}): Promise<string> {
  const id = randomBytes(32).toString('base64url')

  await db.insert(sessions).values({
    id,
    userSub: input.sub,
    ssoSid: input.ssoSid ?? null,
    email: input.email ?? null,
    name: input.name ?? null,
    roles: input.roles,
    idToken: input.idToken,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  })

  return id
}

export async function loadSession(id: string): Promise<CurrentUser | null> {
  const [row] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date())))
    .limit(1)

  if (!row) return null

  return {
    sessionId: row.id,
    sub: row.userSub,
    email: row.email,
    name: row.name,
    roles: row.roles,
  }
}

/** 세션을 지우고, 로그아웃 시 Keycloak에 넘길 id_token을 돌려준다. */
export async function deleteSession(id: string): Promise<string | null> {
  const [row] = await db.delete(sessions).where(eq(sessions.id, id)).returning()
  return row?.idToken ?? null
}

/** Keycloak back-channel logout: SSO 세션 id로 해당 포털 세션들을 끊는다. */
export async function deleteSessionsBySsoSid(ssoSid: string): Promise<number> {
  const rows = await db.delete(sessions).where(eq(sessions.ssoSid, ssoSid)).returning({
    id: sessions.id,
  })
  return rows.length
}

/** logout_token에 sid가 없을 때의 대안 경로. 해당 사용자의 모든 포털 세션을 끊는다. */
export async function deleteSessionsByUserSub(sub: string): Promise<number> {
  const rows = await db.delete(sessions).where(eq(sessions.userSub, sub)).returning({
    id: sessions.id,
  })
  return rows.length
}

/** 만료된 세션 행 정리. 서버 기동 시와 주기적으로 호출한다. */
export async function purgeExpiredSessions(): Promise<number> {
  const rows = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, new Date()))
    .returning({ id: sessions.id })
  return rows.length
}
