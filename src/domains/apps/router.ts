import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { requireAdmin } from '../auth/index.js'
import { createApp, deleteApp, listAllApps, toggleApp } from './service.js'

const idParam = z.object({ id: z.uuid() })

const appForm = z.object({
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'slug는 소문자·숫자·하이픈만 쓸 수 있다')
    .max(64),
  name: z.string().trim().min(1, '이름은 필수다').max(120),
  description: z.string().trim().max(500).optional(),
  targetUrl: z.url('http(s) 주소여야 한다').refine((u) => /^https?:\/\//.test(u), {
    message: 'http 또는 https 주소여야 한다',
  }),
  mode: z.enum(['link', 'iframe']),
  sortOrder: z.coerce.number().int().min(0).max(9999).default(0),
  /** 쉼표로 구분한 Keycloak realm role. 비우면 전체 공개. */
  roles: z.string().trim().default(''),
})

function parseRoles(raw: string): string[] {
  return [...new Set(raw.split(',').map((r) => r.trim()).filter(Boolean))]
}

export async function appsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  app.get('/admin/apps', async (request, reply) => {
    return reply.view('domains/apps/views/apps', {
      user: request.user!,
      apps: await listAllApps(),
      errors: [],
      values: {},
    })
  })

  app.post('/admin/apps', async (request, reply) => {
    const parsed = appForm.safeParse(request.body)

    if (!parsed.success) {
      // htmx가 이 조각만 갈아끼운다. 폼 값은 유지해서 다시 입력하지 않게 한다.
      return reply.code(422).view('domains/apps/views/form', {
        errors: parsed.error.issues.map((i) => i.message),
        values: request.body ?? {},
      })
    }

    const { roles, description, ...rest } = parsed.data

    try {
      await createApp({
        ...rest,
        description: description || null,
        roles: parseRoles(roles),
      })
    } catch (error) {
      request.log.error({ err: error }, '앱 등록 실패')
      return reply.code(422).view('domains/apps/views/form', {
        errors: ['등록하지 못했다. slug가 이미 쓰이고 있는지 확인하라.'],
        values: request.body ?? {},
      })
    }

    // 폼과 목록을 함께 갱신한다(htmx out-of-band swap).
    return reply.view('domains/apps/views/after-create', { apps: await listAllApps() })
  })

  app.post<{ Params: { id: string } }>('/admin/apps/:id/delete', async (request, reply) => {
    const parsed = idParam.safeParse(request.params)
    if (!parsed.success) return reply.code(400).send({ error: '잘못된 id' })

    await deleteApp(parsed.data.id)
    return reply.view('domains/apps/views/table', { apps: await listAllApps() })
  })

  app.post<{ Params: { id: string } }>('/admin/apps/:id/toggle', async (request, reply) => {
    const parsed = idParam.safeParse(request.params)
    if (!parsed.success) return reply.code(400).send({ error: '잘못된 id' })

    await toggleApp(parsed.data.id)
    return reply.view('domains/apps/views/table', { apps: await listAllApps() })
  })
}
