import type { FastifyInstance } from 'fastify'

import { requireAdmin } from '../auth/index.js'
import { getEmployeeCounts, getLastSyncedAt, syncEmployees } from './service.js'

/**
 * 직원 미러 동기화 화면. 관리자가 버튼으로 직접 돌린다 — 스케줄러는 만들지 않는다.
 * 동기화는 수분이 걸릴 수 있는 단일 요청이므로 htmx 조각이 아니라 전체 페이지 + redirect다.
 */
export async function hrRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  app.get('/admin/hr', async (request, reply) => {
    const query = request.query as Record<string, unknown>
    const [counts, lastSyncedAt] = await Promise.all([getEmployeeCounts(), getLastSyncedAt()])

    return reply.view('domains/hr/views/hr', {
      user: request.user!,
      title: '직원 동기화',
      counts,
      lastSyncedAt,
      notice: typeof query.notice === 'string' ? query.notice : null,
      fetched: typeof query.fetched === 'string' ? query.fetched : null,
      upserted: typeof query.upserted === 'string' ? query.upserted : null,
      errors: [],
    })
  })

  app.post('/admin/hr/sync', async (request, reply) => {
    try {
      const result = await syncEmployees()
      request.log.info(result, 'A10 사원 동기화 완료')
      return reply.redirect(
        `/admin/hr?notice=synced&fetched=${result.fetched}&upserted=${result.upserted}`,
      )
    } catch (error) {
      request.log.error({ err: error }, 'A10 사원 동기화 실패')
      const [counts, lastSyncedAt] = await Promise.all([getEmployeeCounts(), getLastSyncedAt()])

      // 자격증명 누락·A10 오류 모두 관리자가 읽고 조치해야 하므로 메시지를 그대로 보여준다.
      return reply.code(422).view('domains/hr/views/hr', {
        user: request.user!,
        title: '직원 동기화',
        counts,
        lastSyncedAt,
        notice: null,
        fetched: null,
        upserted: null,
        errors: [error instanceof Error ? error.message : '동기화하지 못했다.'],
      })
    }
  })
}
