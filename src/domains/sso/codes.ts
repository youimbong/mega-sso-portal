import { randomBytes } from 'node:crypto'

import { eq, lt } from 'drizzle-orm'

import { db } from '../../shared/db.js'
import { ssoAuthCodes, type SsoAuthCode } from './schema.js'

/** 인가 코드 수명. 발급 직후 서버-서버로 교환되므로 짧게 둔다. */
export const AUTH_CODE_TTL_MS = 60_000

export async function issueAuthCode(input: {
  clientId: string
  portalSessionId: string
  redirectUri: string
  scope: string
  nonce: string | null
  codeChallenge: string
}): Promise<string> {
  const code = randomBytes(32).toString('base64url')

  await db.insert(ssoAuthCodes).values({
    code,
    ...input,
    expiresAt: new Date(Date.now() + AUTH_CODE_TTL_MS),
  })

  return code
}

/**
 * DELETE ... RETURNING 으로 원자적 1회 소비. 부재·이미 사용됨·만료는 모두 null이다.
 * 만료 조건을 WHERE에 넣지 않는 이유: 만료된 코드도 이 호출에서 함께 사라져야 재사용되지 않는다.
 */
export async function consumeAuthCode(code: string): Promise<SsoAuthCode | null> {
  const [row] = await db.delete(ssoAuthCodes).where(eq(ssoAuthCodes.code, code)).returning()
  if (!row) return null

  return row.expiresAt.getTime() > Date.now() ? row : null
}

/** 교환되지 않고 버려진 코드 청소. 세션 정리 타이머에 얹는다. */
export async function purgeExpiredAuthCodes(): Promise<number> {
  const rows = await db
    .delete(ssoAuthCodes)
    .where(lt(ssoAuthCodes.expiresAt, new Date()))
    .returning({ code: ssoAuthCodes.code })
  return rows.length
}
