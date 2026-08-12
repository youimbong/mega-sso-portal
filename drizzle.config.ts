import { defineConfig } from 'drizzle-kit'

import './src/load-env.js'

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://portal:portal@localhost:5433/portal',
  },
})
