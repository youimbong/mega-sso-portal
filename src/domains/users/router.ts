import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'

import { requireAdmin } from '../auth/index.js'
import {
  addUserRoles,
  countUsers,
  createUser,
  deleteUser,
  getUser,
  getUserRoles,
  isFederated,
  KeycloakAdminError,
  listAssignableRoles,
  listUsers,
  logoutUser,
  removeUserRoles,
  resetPassword,
  setUserEnabled,
  type KcRole,
} from './service.js'
import { diffRoles } from './role-diff.js'

const PAGE_SIZE = 20

const listQuery = z.object({
  q: z.string().trim().max(100).default(''),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
})

const createForm = z.object({
  username: z
    .string()
    .trim()
    .min(1, '아이디는 필수다')
    .max(64)
    .regex(/^[a-zA-Z0-9._@-]+$/, '아이디에 쓸 수 없는 문자가 있다'),
  email: z.union([z.email('이메일 형식이 올바르지 않다'), z.literal('')]).default(''),
  firstName: z.string().trim().max(64).default(''),
  lastName: z.string().trim().max(64).default(''),
  password: z.string().min(8, '비밀번호는 8자 이상이어야 한다').max(200),
  temporary: z.coerce.boolean().default(false),
})

const passwordForm = z.object({
  password: z.string().min(8, '비밀번호는 8자 이상이어야 한다').max(200),
  temporary: z.coerce.boolean().default(false),
})

const idParam = z.object({ id: z.string().min(1).max(200) })

/** 폼의 체크박스는 값이 1개면 문자열, 여러 개면 배열로 온다. */
function toArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  if (typeof value === 'string') return [value]
  return []
}

function adminErrorMessage(error: unknown): string {
  if (error instanceof KeycloakAdminError) {
    if (error.status === 409) return '이미 같은 아이디 또는 이메일을 쓰는 사용자가 있다.'
    if (error.status === 403) return 'Keycloak이 이 작업을 거부했다. service account 권한을 확인하라.'
  }
  return '처리하지 못했다. 서버 로그를 확인하라.'
}

export async function usersRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  async function renderList(reply: FastifyReply, opts: { q: string; page: number; errors: string[]; values: unknown }) {
    const first = (opts.page - 1) * PAGE_SIZE
    const [users, total] = await Promise.all([
      listUsers({ search: opts.q || undefined, first, max: PAGE_SIZE }),
      countUsers(opts.q || undefined),
    ])

    return reply.view('domains/users/views/users', {
      user: reply.request.user!,
      users,
      total,
      page: opts.page,
      pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
      q: opts.q,
      errors: opts.errors,
      values: opts.values,
    })
  }

  app.get('/admin/users', async (request, reply) => {
    const { q, page } = listQuery.parse(request.query)
    return renderList(reply, { q, page, errors: [], values: {} })
  })

  /** htmx 검색. 표 부분만 갈아끼운다. */
  app.get('/admin/users/table', async (request, reply) => {
    const { q, page } = listQuery.parse(request.query)
    const first = (page - 1) * PAGE_SIZE
    const [users, total] = await Promise.all([
      listUsers({ search: q || undefined, first, max: PAGE_SIZE }),
      countUsers(q || undefined),
    ])

    return reply.view('domains/users/views/user-table', {
      users,
      total,
      page,
      pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
      q,
      oob: false,
    })
  })

  app.post('/admin/users', async (request, reply) => {
    const parsed = createForm.safeParse(request.body)

    if (!parsed.success) {
      return reply.code(422).view('domains/users/views/user-form', {
        errors: parsed.error.issues.map((i) => i.message),
        values: request.body ?? {},
      })
    }

    try {
      await createUser({ ...parsed.data, email: parsed.data.email || undefined })
    } catch (error) {
      request.log.error({ err: error }, '사용자 생성 실패')
      return reply.code(422).view('domains/users/views/user-form', {
        errors: [adminErrorMessage(error)],
        values: request.body ?? {},
      })
    }

    const [users, total] = await Promise.all([listUsers({ max: PAGE_SIZE }), countUsers()])
    return reply.view('domains/users/views/after-user-create', {
      users,
      total,
      page: 1,
      pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
      q: '',
    })
  })

  app.get<{ Params: { id: string } }>('/admin/users/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params)
    const notice = (request.query as Record<string, unknown>).notice

    const [target, assignable, assigned] = await Promise.all([
      getUser(id),
      listAssignableRoles(),
      getUserRoles(id),
    ])

    return reply.view('domains/users/views/user-detail', {
      user: request.user!,
      target,
      federated: isFederated(target),
      isSelf: request.user!.sub === target.id,
      assignable,
      assigned: assigned.map((r) => r.name),
      notice: typeof notice === 'string' ? notice : null,
      errors: [],
    })
  })

  async function detailWithError(reply: FastifyReply, id: string, message: string) {
    const [target, assignable, assigned] = await Promise.all([
      getUser(id),
      listAssignableRoles(),
      getUserRoles(id),
    ])
    return reply.code(422).view('domains/users/views/user-detail', {
      user: reply.request.user!,
      target,
      federated: isFederated(target),
      isSelf: reply.request.user!.sub === target.id,
      assignable,
      assigned: assigned.map((r) => r.name),
      notice: null,
      errors: [message],
    })
  }

  app.post<{ Params: { id: string } }>('/admin/users/:id/roles', async (request, reply) => {
    const { id } = idParam.parse(request.params)
    const target = await getUser(id)

    const [assignable, current] = await Promise.all([listAssignableRoles(), getUserRoles(id)])
    const byName = new Map<string, KcRole>(assignable.map((r) => [r.name, r]))

    const { add, remove } = diffRoles({
      assignable: assignable.map((r) => r.name),
      current: current.map((r) => r.name),
      desired: toArray((request.body as Record<string, unknown>)?.roles),
    })

    // 마지막 관리자가 스스로 portal-admin을 떼면 아무도 관리 화면에 못 들어간다.
    if (request.user!.sub === target.id && remove.includes('portal-admin')) {
      return detailWithError(reply, id, '자기 자신의 portal-admin 역할은 뗄 수 없다.')
    }

    try {
      await addUserRoles(id, add.map((n) => byName.get(n)!).filter(Boolean))
      await removeUserRoles(id, remove.map((n) => byName.get(n)!).filter(Boolean))
    } catch (error) {
      request.log.error({ err: error }, '역할 변경 실패')
      return detailWithError(reply, id, adminErrorMessage(error))
    }

    request.log.info({ actor: request.user!.sub, target: id, add, remove }, '역할 변경')
    return reply.redirect(`/admin/users/${encodeURIComponent(id)}?notice=roles-saved`)
  })

  app.post<{ Params: { id: string } }>('/admin/users/:id/password', async (request, reply) => {
    const { id } = idParam.parse(request.params)
    const target = await getUser(id)

    if (isFederated(target)) {
      return detailWithError(reply, id, '외부 저장소(AD/LDAP) 사용자의 비밀번호는 여기서 바꿀 수 없다.')
    }

    const parsed = passwordForm.safeParse(request.body)
    if (!parsed.success) {
      return detailWithError(reply, id, parsed.error.issues[0]?.message ?? '입력이 올바르지 않다.')
    }

    try {
      await resetPassword(id, parsed.data.password, parsed.data.temporary)
    } catch (error) {
      request.log.error({ err: error }, '비밀번호 재설정 실패')
      return detailWithError(reply, id, adminErrorMessage(error))
    }

    request.log.info({ actor: request.user!.sub, target: id }, '비밀번호 재설정')
    return reply.redirect(`/admin/users/${encodeURIComponent(id)}?notice=password-reset`)
  })

  app.post<{ Params: { id: string } }>('/admin/users/:id/toggle', async (request, reply) => {
    const { id } = idParam.parse(request.params)
    const target = await getUser(id)

    if (request.user!.sub === target.id) {
      return detailWithError(reply, id, '자기 자신은 비활성화할 수 없다.')
    }

    try {
      await setUserEnabled(id, !target.enabled)
      // 비활성화했다면 이미 로그인한 세션도 끊는다. 안 그러면 최대 10시간 동안 계속 쓸 수 있다.
      if (target.enabled) await logoutUser(id)
    } catch (error) {
      request.log.error({ err: error }, '활성화 상태 변경 실패')
      return detailWithError(reply, id, adminErrorMessage(error))
    }

    request.log.info({ actor: request.user!.sub, target: id, enabled: !target.enabled }, '계정 상태 변경')
    return reply.redirect(`/admin/users/${encodeURIComponent(id)}?notice=toggled`)
  })

  app.post<{ Params: { id: string } }>('/admin/users/:id/logout', async (request, reply) => {
    const { id } = idParam.parse(request.params)

    try {
      await logoutUser(id)
    } catch (error) {
      request.log.error({ err: error }, '강제 로그아웃 실패')
      return detailWithError(reply, id, adminErrorMessage(error))
    }

    request.log.info({ actor: request.user!.sub, target: id }, '강제 로그아웃')
    return reply.redirect(`/admin/users/${encodeURIComponent(id)}?notice=logged-out`)
  })

  app.post<{ Params: { id: string } }>('/admin/users/:id/delete', async (request, reply) => {
    const { id } = idParam.parse(request.params)
    const target = await getUser(id)

    if (request.user!.sub === target.id) {
      return detailWithError(reply, id, '자기 자신은 삭제할 수 없다.')
    }
    if (isFederated(target)) {
      return detailWithError(reply, id, '외부 저장소(AD/LDAP) 사용자는 여기서 삭제할 수 없다.')
    }

    try {
      await deleteUser(id)
    } catch (error) {
      request.log.error({ err: error }, '사용자 삭제 실패')
      return detailWithError(reply, id, adminErrorMessage(error))
    }

    request.log.warn({ actor: request.user!.sub, target: id, username: target.username }, '사용자 삭제')

    // htmx 요청은 302를 따라가 조각으로 갈아끼운다. 전체 페이지 이동은 이 헤더로 시킨다.
    if (request.headers['hx-request']) {
      return reply.header('hx-redirect', '/admin/users').code(204).send()
    }
    return reply.redirect('/admin/users')
  })
}
