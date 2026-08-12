import type { FastifyInstance } from 'fastify'

import { requireUser } from '../auth.js'
import { findVisibleApp, listVisibleApps } from '../apps.js'

const LOGIN_ERRORS: Record<string, string> = {
  'flow-expired': '로그인 요청이 만료되었다. 다시 시도하라.',
  'no-id-token': 'Keycloak이 ID token을 돌려주지 않았다. 클라이언트 스코프 설정을 확인하라.',
  'exchange-failed': '인가 코드 교환에 실패했다. 서버 로그를 확인하라.',
}

export async function portalRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { preHandler: requireUser }, async (request, reply) => {
    const user = request.user!
    const apps = await listVisibleApps(user.roles)
    return reply.view('home', { user, apps })
  })

  app.get<{ Params: { slug: string } }>(
    '/apps/:slug',
    { preHandler: requireUser },
    async (request, reply) => {
      const user = request.user!
      const found = await findVisibleApp(request.params.slug, user.roles)

      // 권한이 없는 앱과 존재하지 않는 앱을 구분해 노출하지 않는다.
      if (!found || found.mode !== 'iframe') {
        return reply.code(404).view('error', {
          user,
          title: '앱을 찾을 수 없다',
          message: '주소가 잘못됐거나 접근 권한이 없다.',
        })
      }

      return reply.view('embed', { user, app: found })
    },
  )

  app.get('/login-error', async (request, reply) => {
    const reason = (request.query as Record<string, unknown>).reason
    const message =
      (typeof reason === 'string' ? LOGIN_ERRORS[reason] : undefined) ??
      '알 수 없는 오류가 발생했다.'

    return reply.code(400).view('login-error', { message })
  })
}
