import { fileURLToPath } from 'node:url'

import cookie from '@fastify/cookie'
import formbody from '@fastify/formbody'
import helmet from '@fastify/helmet'
import fastifyStatic from '@fastify/static'
import view from '@fastify/view'
import { Eta } from 'eta'
import Fastify from 'fastify'

import { registerAuth, registerOriginCheck } from './auth.js'
import { closeDb } from './db/index.js'
import { env, isProd } from './env.js'
import { adminRoutes } from './routes/admin.js'
import { authRoutes } from './routes/auth.js'
import { portalRoutes } from './routes/portal.js'
import { purgeExpiredSessions } from './session.js'

// src/ 와 dist/ 모두 프로젝트 루트 바로 아래이므로 두 경우 모두 같은 경로가 나온다.
const viewsDir = fileURLToPath(new URL('../views', import.meta.url))
const publicDir = fileURLToPath(new URL('../public', import.meta.url))

const SESSION_PURGE_INTERVAL_MS = 60 * 60 * 1000

export async function buildServer() {
  const app = Fastify({
    logger: isProd
      ? { level: 'info' }
      : { level: 'debug', transport: { target: 'pino-pretty', options: { colorize: true } } },
    // 리버스 프록시(nginx 등) 뒤에서 X-Forwarded-* 를 신뢰한다.
    trustProxy: isProd,
  })

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // htmx가 indicator용 <style>을 런타임에 주입한다.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        // 포털이 embed하는 대상 앱은 관리자가 카탈로그에 등록한 사내 주소들이다.
        frameSrc: ['http:', 'https:'],
        formAction: ["'self'", env.OIDC_ISSUER],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    // iframe 안의 앱이 리소스를 불러오는 것을 막지 않는다.
    crossOriginResourcePolicy: false,
  })

  await app.register(cookie, { secret: env.SESSION_SECRET })
  await app.register(formbody)
  await app.register(fastifyStatic, { root: publicDir, prefix: '/static/' })

  await app.register(view, {
    engine: { eta: new Eta() },
    root: viewsDir,
    viewExt: 'eta',
    defaultContext: { appName: 'Mega Portal' },
  })

  registerOriginCheck(app)
  registerAuth(app)

  app.get('/healthz', async () => ({ status: 'ok' }))

  await app.register(authRoutes)
  await app.register(portalRoutes)
  await app.register(adminRoutes)

  app.setNotFoundHandler(async (request, reply) =>
    reply.code(404).view('error', {
      user: request.user,
      title: '페이지를 찾을 수 없다',
      message: '주소를 확인하라.',
    }),
  )

  return app
}

async function main() {
  const app = await buildServer()

  const purged = await purgeExpiredSessions()
  if (purged > 0) app.log.info({ purged }, '만료된 세션 정리')

  const timer = setInterval(() => {
    purgeExpiredSessions().catch((err: unknown) => app.log.error({ err }, '세션 정리 실패'))
  }, SESSION_PURGE_INTERVAL_MS)
  timer.unref()

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      app.log.info(`${signal} 수신, 종료한다`)
      void app
        .close()
        .then(closeDb)
        .then(() => process.exit(0))
    })
  }

  await app.listen({ port: env.PORT, host: env.HOST })
}

// 테스트에서 import할 때는 서버를 띄우지 않는다.
if (process.env.VITEST !== 'true') {
  main().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
