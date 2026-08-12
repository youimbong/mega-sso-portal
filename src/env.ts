import './load-env.js'

import { z } from 'zod'

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3100),
  HOST: z.string().default('0.0.0.0'),

  APP_BASE_URL: z.url(),
  /** 세션 쿠키 서명 키. openssl rand -base64 32 */
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET은 32자 이상이어야 한다'),

  OIDC_ISSUER: z.url(),
  OIDC_CLIENT_ID: z.string().min(1),
  OIDC_CLIENT_SECRET: z.string().min(1),

  DATABASE_URL: z.string().min(1),
})

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  console.error(`환경변수 설정 오류:\n${z.prettifyError(parsed.error)}\n.env.example을 참고하라.`)
  process.exit(1)
}

export const env = parsed.data
export const isProd = env.NODE_ENV === 'production'

/** 로컬 개발의 http:// issuer 여부. 운영에서는 https여야 한다. */
export const issuerIsInsecure = env.OIDC_ISSUER.startsWith('http://')
