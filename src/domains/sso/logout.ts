import { inArray } from 'drizzle-orm'

import { db } from '../../shared/db.js'
import { findClient } from './clients.js'
import { ssoSessions } from './schema.js'
import { signLogoutToken } from './tokens.js'

/**
 * 포털 세션이 끝났다. 그 세션으로 로그인한 하위 앱들에 back-channel logout token을 보낸다.
 * 실패해도 포털 로그아웃을 막지 않는다 — 하위 앱이 죽어 있다고 사용자가 로그아웃을 못 하면 안 된다.
 */
export function notifyPortalSessionsEnded(portalSessionIds: string[]): void {
  if (portalSessionIds.length === 0) return
  void sendLogoutTokens(portalSessionIds).catch((err: unknown) => {
    console.error({ err }, 'back-channel logout 발송 실패')
  })
}

/** 2xx로 받아들여진 개수를 돌려준다. 수동 호출·테스트용. */
export async function sendLogoutTokens(portalSessionIds: string[]): Promise<number> {
  if (portalSessionIds.length === 0) return 0

  // DELETE ... RETURNING 으로 대상을 뽑아 같은 세션에 대한 중복 발송을 막는다.
  const rows = await db
    .delete(ssoSessions)
    .where(inArray(ssoSessions.portalSessionId, portalSessionIds))
    .returning()

  const results = await Promise.all(
    rows.map(async (row) => {
      const client = await findClient(row.clientId)
      if (!client?.backchannelLogoutUri) return false

      const logoutToken = await signLogoutToken({
        clientId: row.clientId,
        sub: row.userSub,
        sid: row.sid,
      })

      // 재시도하지 않는다. 하위 앱은 어차피 자체 세션 만료를 갖고 있다.
      // 다만 실패는 반드시 남긴다 — 링크 행은 위에서 이미 지웠으므로 여기 로그가
      // "그 앱은 로그아웃을 못 받았다"를 아는 유일한 흔적이다.
      let response: Response
      try {
        response = await fetch(client.backchannelLogoutUri, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ logout_token: logoutToken }),
          signal: AbortSignal.timeout(5000),
        })
      } catch (err) {
        // 토큰 본문은 절대 남기지 않는다.
        console.error({ clientId: row.clientId, err }, 'back-channel logout 발송 실패')
        return false
      }

      if (!response.ok) {
        console.warn(
          { clientId: row.clientId, status: response.status },
          'back-channel logout 거부(하위 앱 세션이 남아 있을 수 있다)',
        )
        return false
      }

      console.info({ clientId: row.clientId, status: response.status }, 'back-channel logout 발송')
      return true
    }),
  )

  return results.filter(Boolean).length
}
