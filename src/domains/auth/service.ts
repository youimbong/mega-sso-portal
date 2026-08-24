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
  username: string | null
  employeeCode: string | null
  roles: string[]
}

/**
 * 세션이 끝났을 때 호출할 콜백. sso 도메인이 하위 앱에 back-channel logout을 보내는 통로다.
 * auth는 sso를 import하지 않는다(auth는 의존 그래프의 뿌리다) — server.ts가 부팅 시 주입한다.
 * 주입 전이거나 sso를 쓰지 않는 배포에서는 아무 일도 일어나지 않는다.
 */
let onSessionsEnded: ((portalSessionIds: string[]) => void) | null = null

export function setSessionEndListener(listener: (portalSessionIds: string[]) => void): void {
  onSessionsEnded = listener
}

/** 삭제된 세션 id들을 리스너에 넘긴다. 리스너의 예외가 로그아웃 자체를 막으면 안 된다. */
function notifyEnded(ids: string[]): void {
  if (!onSessionsEnded || ids.length === 0) return
  try {
    onSessionsEnded(ids)
  } catch (err) {
    console.error({ err }, '세션 종료 리스너 실패')
  }
}

export async function createSession(input: {
  sub: string
  ssoSid?: string
  email?: string
  name?: string
  username?: string
  employeeCode?: string
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
    username: input.username ?? null,
    employeeCode: input.employeeCode ?? null,
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
    username: row.username,
    employeeCode: row.employeeCode,
    roles: row.roles,
  }
}

/** 세션을 지우고, 로그아웃 시 Keycloak에 넘길 id_token을 돌려준다. */
export async function deleteSession(id: string): Promise<string | null> {
  const [row] = await db.delete(sessions).where(eq(sessions.id, id)).returning()
  if (row) notifyEnded([row.id])
  return row?.idToken ?? null
}

/** Keycloak back-channel logout: SSO 세션 id로 해당 포털 세션들을 끊는다. */
export async function deleteSessionsBySsoSid(ssoSid: string): Promise<number> {
  const rows = await db.delete(sessions).where(eq(sessions.ssoSid, ssoSid)).returning({
    id: sessions.id,
  })
  notifyEnded(rows.map((row) => row.id))
  return rows.length
}

/** logout_token에 sid가 없을 때의 대안 경로. 해당 사용자의 모든 포털 세션을 끊는다. */
export async function deleteSessionsByUserSub(sub: string): Promise<number> {
  const rows = await db.delete(sessions).where(eq(sessions.userSub, sub)).returning({
    id: sessions.id,
  })
  notifyEnded(rows.map((row) => row.id))
  return rows.length
}

/** 만료된 세션 행 정리. 서버 기동 시와 주기적으로 호출한다. */
export async function purgeExpiredSessions(): Promise<number> {
  const rows = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, new Date()))
    .returning({ id: sessions.id })
  notifyEnded(rows.map((row) => row.id))
  return rows.length
}
