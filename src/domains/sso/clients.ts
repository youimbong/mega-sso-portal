import { and, asc, eq } from 'drizzle-orm'

import { db } from '../../shared/db.js'
import { ssoClients, type SsoClient } from './schema.js'
import { generateClientSecret, hashClientSecret, verifyClientSecret } from './secret.js'

/**
 * 존재하지 않는 client_id의 응답이 빨라 존재 여부가 새는 것을 막는 더미 해시.
 * 값 자체는 아무도 모르는 난수라 이것으로는 어떤 인증도 통과하지 못한다.
 * 해시가 비동기가 된 뒤로는 첫 사용 시점에 한 번만 만든다(모듈 로드에서 await할 수 없다).
 */
let dummyHash: Promise<string> | undefined

function getDummyHash(): Promise<string> {
  dummyHash ??= hashClientSecret(generateClientSecret())
  return dummyHash
}

export type ClientInput = {
  clientId: string
  name: string
  redirectUris: string[]
  postLogoutRedirectUris: string[]
  backchannelLogoutUri: string | null
  requiredRoles: string[]
  /** 등록 시점부터 끌 수 있어야 한다 — 앱 준비가 끝나기 전에 로그인이 열리면 안 된다. */
  enabled: boolean
}

export async function findEnabledClient(clientId: string): Promise<SsoClient | null> {
  const [row] = await db
    .select()
    .from(ssoClients)
    .where(and(eq(ssoClients.clientId, clientId), eq(ssoClients.enabled, true)))
    .limit(1)
  return row ?? null
}

/** enabled 여부와 무관한 조회. 사용 중지된 앱에도 로그아웃은 알려야 한다. */
export async function findClient(clientId: string): Promise<SsoClient | null> {
  const [row] = await db.select().from(ssoClients).where(eq(ssoClients.clientId, clientId)).limit(1)
  return row ?? null
}

/** client_secret_basic / client_secret_post 공통 진입점. 실패 이유를 구분하지 않고 null. */
export async function authenticateClient(
  auth: { clientId: string; clientSecret: string } | null,
): Promise<SsoClient | null> {
  if (!auth) return null

  const client = await findEnabledClient(auth.clientId)
  const ok = await verifyClientSecret(auth.clientSecret, client?.secretHash ?? (await getDummyHash()))

  return client && ok ? client : null
}

export async function listClients(): Promise<SsoClient[]> {
  return db.select().from(ssoClients).orderBy(asc(ssoClients.clientId))
}

export async function findClientById(id: string): Promise<SsoClient | null> {
  const [row] = await db.select().from(ssoClients).where(eq(ssoClients.id, id)).limit(1)
  return row ?? null
}

/** 평문 secret은 이 반환값이 유일한 노출 지점이다. DB에는 해시만 남는다. */
export async function createClient(input: ClientInput): Promise<{ clientSecret: string }> {
  const clientSecret = generateClientSecret()

  await db.insert(ssoClients).values({
    ...input,
    secretHash: await hashClientSecret(clientSecret),
  })

  return { clientSecret }
}

export async function updateClient(id: string, input: Omit<ClientInput, 'clientId'>): Promise<void> {
  // client_id는 하위 앱 설정에 박혀 있는 값이라 수정 대상에서 뺀다. 바꿔야 하면 새로 등록한다.
  await db
    .update(ssoClients)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(ssoClients.id, id))
}

export async function rotateClientSecret(id: string): Promise<{ clientSecret: string }> {
  const clientSecret = generateClientSecret()

  await db
    .update(ssoClients)
    .set({ secretHash: await hashClientSecret(clientSecret), updatedAt: new Date() })
    .where(eq(ssoClients.id, id))

  return { clientSecret }
}

export async function toggleClient(id: string): Promise<void> {
  const [row] = await db
    .select({ enabled: ssoClients.enabled })
    .from(ssoClients)
    .where(eq(ssoClients.id, id))
    .limit(1)
  if (!row) return

  await db
    .update(ssoClients)
    .set({ enabled: !row.enabled, updatedAt: new Date() })
    .where(eq(ssoClients.id, id))
}

export async function deleteClient(id: string): Promise<void> {
  await db.delete(ssoClients).where(eq(ssoClients.id, id))
}
