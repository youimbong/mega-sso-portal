import { desc, sql } from 'drizzle-orm'
import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  importJWK,
  type CryptoKey,
  type JSONWebKeySet,
  type JWK,
} from 'jose'

import { db } from '../../shared/db.js'
import { ssoSigningKeys } from './schema.js'

export type SigningKey = { kid: string; privateKey: CryptoKey }

let cached: SigningKey | undefined

/**
 * 부팅 시 1회. 키가 없으면 RS256 키쌍을 만들어 저장한다. 이미 있으면 아무것도 하지 않는다.
 * 반환값은 로그에 찍을 활성 kid다 — JWK는 어떤 경우에도 로그에 남기지 않는다.
 */
export async function ensureSigningKey(): Promise<string> {
  const existing = await latestKid()
  if (existing) return existing

  return db.transaction(async (tx) => {
    // 여러 인스턴스가 동시에 부팅하면 서로 다른 키를 넣어 JWKS에 쓸모없는 키가 쌓인다.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('sso_signing_key_bootstrap'))`)

    const [row] = await tx
      .select({ kid: ssoSigningKeys.kid })
      .from(ssoSigningKeys)
      .orderBy(desc(ssoSigningKeys.createdAt))
      .limit(1)
    if (row) return row.kid

    const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true })
    const publicJwk = await exportJWK(publicKey)
    const privateJwk = await exportJWK(privateKey)
    const kid = await calculateJwkThumbprint(publicJwk, 'sha256')

    await tx.insert(ssoSigningKeys).values({
      kid,
      privateJwk: { ...privateJwk, kid, use: 'sig', alg: 'RS256' },
      publicJwk: { ...publicJwk, kid, use: 'sig', alg: 'RS256' },
    })

    return kid
  })
}

/** 서명에 쓸 최신 키. 회전 코드가 없으므로 무효화 로직도 두지 않는다. */
export async function getSigningKey(): Promise<SigningKey> {
  if (cached) return cached

  const [row] = await db
    .select()
    .from(ssoSigningKeys)
    .orderBy(desc(ssoSigningKeys.createdAt))
    .limit(1)
  if (!row) throw new Error('OP 서명키가 없다. 부팅 시 ensureSigningKey를 호출했는지 확인하라')

  const privateKey = (await importJWK(row.privateJwk as JWK, 'RS256')) as CryptoKey
  cached = { kid: row.kid, privateKey }
  return cached
}

/** JWKS 응답 본문. 개인키 필드가 섞이지 않도록 public_jwk 컬럼만 내보낸다. */
export async function getPublicJwks(): Promise<JSONWebKeySet> {
  const rows = await db
    .select({ publicJwk: ssoSigningKeys.publicJwk })
    .from(ssoSigningKeys)
    .orderBy(desc(ssoSigningKeys.createdAt))

  return { keys: rows.map((row) => row.publicJwk as JWK) }
}

async function latestKid(): Promise<string | null> {
  const [row] = await db
    .select({ kid: ssoSigningKeys.kid })
    .from(ssoSigningKeys)
    .orderBy(desc(ssoSigningKeys.createdAt))
    .limit(1)
  return row?.kid ?? null
}
