import { fileURLToPath } from 'node:url'

import cookie from '@fastify/cookie'
import formbody from '@fastify/formbody'
import helmet from '@fastify/helmet'
import fastifyStatic from '@fastify/static'
import view from '@fastify/view'
import { Eta } from 'eta'
import Fastify from 'fastify'

import { appsRoutes } from './domains/apps/index.js'
import {
  authRoutes,
  purgeExpiredSessions,
  registerAuth,
  registerOriginCheck,
  setSessionEndListener,
} from './domains/auth/index.js'
import { hrRoutes } from './domains/hr/index.js'
import { portalRoutes } from './domains/portal/index.js'
import {
  ensureSigningKey,
  notifyPortalSessionsEnded,
  purgeExpiredAuthCodes,
  ssoAdminRoutes,
  ssoRoutes,
} from './domains/sso/index.js'
import { usersRoutes } from './domains/users/index.js'
import { closeDb } from './shared/db.js'
import { env, isProd } from './shared/env.js'

// .eta는 tsc가 컴파일하지 않으므로 dist에서도 src/ 안의 템플릿을 그대로 읽는다.
// src/ 와 dist/ 모두 프로젝트 루트 바로 아래이므로 두 경우 모두 같은 경로가 나온다.
const viewsDir = fileURLToPath(new URL('../src', import.meta.url))
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
    // helmet 기본값은 no-referrer인데, 그러면 Chrome이 최상위 폼 POST에 Origin을 "null"로
    // 보낸다(실측: 로그아웃 폼 → origin:"null", sec-fetch-site:same-origin, referer 없음).
    // registerOriginCheck가 그걸 거부해 로그아웃이 403으로 죽었다. same-origin이면 같은 출처
    // 요청에만 referrer가 붙고 Origin도 정상으로 온다. 외부로는 여전히 referrer를 안 보낸다.
    referrerPolicy: { policy: 'same-origin' },
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
  await app.register(appsRoutes)
  await app.register(usersRoutes)
  await app.register(hrRoutes)
  await app.register(ssoRoutes)
  await app.register(ssoAdminRoutes)

  app.setNotFoundHandler(async (request, reply) =>
    reply.code(404).view('shared/views/error', {
      user: request.user,
      title: '페이지를 찾을 수 없다',
      message: '주소를 확인하라.',
    }),
  )

  return app
}

async function main() {
  const app = await buildServer()

  // 포털 세션이 끝나면 그 세션으로 로그인한 하위 앱들에 back-channel logout을 보낸다.
  // auth는 sso를 import하지 않으므로(의존 그래프의 뿌리) 배선은 여기서 한 번만 한다.
  setSessionEndListener(notifyPortalSessionsEnded)

  // OP 서명키는 DB가 원본이다. 없으면 여기서 만든다. JWK는 절대 로그에 남기지 않는다 — kid만.
  const kid = await ensureSigningKey()
  app.log.info({ kid }, 'OP 서명키 준비')

  const purged = await purgeExpiredSessions()
  if (purged > 0) app.log.info({ purged }, '만료된 세션 정리')

  const timer = setInterval(() => {
    purgeExpiredSessions().catch((err: unknown) => app.log.error({ err }, '세션 정리 실패'))
    purgeExpiredAuthCodes().catch((err: unknown) => app.log.error({ err }, '인가 코드 정리 실패'))
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
