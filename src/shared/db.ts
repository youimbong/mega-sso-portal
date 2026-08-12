import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import { env } from './env.js'

// 테이블 스키마는 각 도메인의 schema.ts가 소유한다. db.query API를 쓰지 않으므로 여기서 모으지 않는다.
const sql = postgres(env.DATABASE_URL, { max: 10 })

export const db = drizzle(sql)

export async function closeDb(): Promise<void> {
  await sql.end()
}
