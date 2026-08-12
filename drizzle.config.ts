import { defineConfig } from 'drizzle-kit'

import './src/shared/load-env.js'

export default defineConfig({
  // 테이블 스키마는 각 도메인이 소유한다. 새 도메인의 schema.ts도 자동으로 포함된다.
  schema: './src/domains/*/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://portal:portal@localhost:5433/portal',
  },
})
