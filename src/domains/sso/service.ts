import { randomBytes } from 'node:crypto'

import { eq } from 'drizzle-orm'

// auth 도메인의 세션 조회. sso는 sessions 테이블을 직접 읽지 않는다.
import { loadSession } from '../auth/index.js'
import { db } from '../../shared/db.js'
import type { PortalIdentity } from './claims.js'
import { ssoSessions, type SsoSession } from './schema.js'

/**
 * (포털 세션, 하위 앱) 링크를 보장하고 sid를 돌려준다. 재로그인이면 기존 sid를 유지한다 —
 * 하위 앱이 이미 받아 간 id_token의 sid와 logout token의 sid가 어긋나면 로그아웃이 매칭되지 않는다.
 */
export async function ensureSsoSession(input: {
  portalSessionId: string
  clientId: string
  userSub: string
}): Promise<string> {
  const [row] = await db
    .insert(ssoSessions)
    .values({ sid: randomBytes(32).toString('base64url'), ...input })
    .onConflictDoUpdate({
      target: [ssoSessions.portalSessionId, ssoSessions.clientId],
      set: { userSub: input.userSub },
    })
    .returning({ sid: ssoSessions.sid })

  return row!.sid
}

export async function findSsoSessionBySid(sid: string): Promise<SsoSession | null> {
  const [row] = await db.select().from(ssoSessions).where(eq(ssoSessions.sid, sid)).limit(1)
  return row ?? null
}

/**
 * 포털 세션 id로 신원을 다시 읽는다. 세션이 끊겼거나 만료됐으면 null이다(= invalid_grant).
 * 코드 발급 시점의 claim을 복사해 두지 않는 이유가 이것이다.
 */
export async function loadIdentity(portalSessionId: string): Promise<PortalIdentity | null> {
  const user = await loadSession(portalSessionId)
  if (!user) return null

  return {
    sub: user.sub,
    email: user.email,
    name: user.name,
    username: user.username,
    roles: user.roles,
    employeeCode: user.employeeCode,
  }
}
