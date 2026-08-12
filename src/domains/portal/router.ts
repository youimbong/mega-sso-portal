import type { FastifyInstance } from 'fastify'

import { requireUser } from '../auth/index.js'
import { findVisibleApp, listVisibleApps } from '../apps/index.js'

export async function portalRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { preHandler: requireUser }, async (request, reply) => {
    const user = request.user!
    const apps = await listVisibleApps(user.roles)
    return reply.view('domains/portal/views/home', { user, apps })
  })

  app.get<{ Params: { slug: string } }>(
    '/apps/:slug',
    { preHandler: requireUser },
    async (request, reply) => {
      const user = request.user!
      const found = await findVisibleApp(request.params.slug, user.roles)

      // 권한이 없는 앱과 존재하지 않는 앱을 구분해 노출하지 않는다.
      if (!found || found.mode !== 'iframe') {
        return reply.code(404).view('shared/views/error', {
          user,
          title: '앱을 찾을 수 없다',
          message: '주소가 잘못됐거나 접근 권한이 없다.',
        })
      }

      return reply.view('domains/portal/views/embed', { user, app: found })
    },
  )
}
