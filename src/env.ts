import './load-env.js'

import { z } from 'zod'

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  /** 비워두면 APP_BASE_URL의 포트를 쓴다. 리버스 프록시 뒤에서 둘이 다를 때만 지정한다. */
  PORT: z.coerce.number().int().positive().max(65535).optional(),
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

const baseUrl = new URL(parsed.data.APP_BASE_URL)

/**
 * 실제로 바인딩할 포트.
 * PORT를 따로 주지 않으면 APP_BASE_URL을 단일 출처로 삼는다 —
 * 포트만 바꾸고 APP_BASE_URL을 안 고쳐서 OIDC redirect_uri가 어긋나는 사고를 막는다.
 */
export const env = {
  ...parsed.data,
  PORT: parsed.data.PORT ?? Number(baseUrl.port || (baseUrl.protocol === 'https:' ? 443 : 80)),
}

export const isProd = env.NODE_ENV === 'production'

/** 로컬 개발의 http:// issuer 여부. 운영에서는 https여야 한다. */
export const issuerIsInsecure = env.OIDC_ISSUER.startsWith('http://')
