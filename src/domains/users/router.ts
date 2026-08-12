import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'

import { requireAdmin } from '../auth/index.js'
import { getEmployeeByCode, isRetired, searchEmployees, type Employee } from '../hr/index.js'
import {
  addUserRoles,
  countUsers,
  createUser,
  deleteUser,
  employeeCodeOf,
  EmployeeCodeNotStoredError,
  findUserByEmployeeCode,
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
  type KcUser,
} from './service.js'
import { diffRoles } from './role-diff.js'

const PAGE_SIZE = 20

const listQuery = z.object({
  q: z.string().trim().max(100).default(''),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
})

/** 직원 선택 목록 검색. 2자 미만은 hr 쪽에서 빈 배열로 돌아온다. */
const employeeQuery = z.object({ q: z.string().trim().max(100).default('') })

/** 폼 조각 요청. 사번이 오면 직원 연동 폼, standalone이면 시스템 계정 폼. */
const newFormQuery = z.object({
  employeeCode: z.string().trim().max(10).default(''),
  standalone: z.string().trim().max(10).default(''),
})

const accountFields = {
  username: z
    .string()
    .trim()
    .min(1, '아이디는 필수다')
    .max(64)
    .regex(/^[a-zA-Z0-9._@-]+$/, '아이디에 쓸 수 없는 문자가 있다'),
  password: z.string().min(8, '비밀번호는 8자 이상이어야 한다').max(200),
  temporary: z.coerce.boolean().default(false),
}

/** 직원 연동 등록. 성명·이메일은 받지 않는다 — 미러에서만 온다. */
const linkedCreateForm = z.object({
  ...accountFields,
  employeeCode: z.string().trim().min(1, '직원을 먼저 선택하라').max(10),
})

/** 직원 연결 없는 시스템 계정. 이 경로에서만 성명·이메일을 수기로 받는다. */
const standaloneCreateForm = z.object({
  ...accountFields,
  email: z.union([z.email('이메일 형식이 올바르지 않다'), z.literal('')]).default(''),
  firstName: z.string().trim().max(64).default(''),
  lastName: z.string().trim().max(64).default(''),
})

const passwordForm = z.object({
  password: z.string().min(8, '비밀번호는 8자 이상이어야 한다').max(200),
  temporary: z.coerce.boolean().default(false),
})

const idParam = z.object({ id: z.string().min(1).max(200) })

/** 목록 뷰가 사번 열을 그릴 수 있도록 attribute를 미리 꺼내 붙인다. */
function withEmployeeCode(users: KcUser[]) {
  return users.map((u) => ({ ...u, employeeCode: employeeCodeOf(u) }))
}

/** 폼의 체크박스는 값이 1개면 문자열, 여러 개면 배열로 온다. */
function toArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  if (typeof value === 'string') return [value]
  return []
}

function adminErrorMessage(error: unknown): string {
  if (error instanceof EmployeeCodeNotStoredError) return error.message
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
      users: withEmployeeCode(users),
      total,
      page: opts.page,
      pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
      q: opts.q,
      errors: opts.errors,
      values: opts.values,
      // 첫 진입은 항상 직원 검색부터다. 직원이 정해진 폼은 htmx 조각으로만 나온다.
      employee: null,
      standalone: false,
    })
  }

  /** 폼 조각(#user-form-wrap) 하나만 돌려준다. 오류 재렌더도 이 경로를 탄다. */
  function renderForm(
    reply: FastifyReply,
    status: number,
    data: { errors: string[]; values: unknown; employee: Employee | null; standalone: boolean },
  ) {
    return reply.code(status).view('domains/users/views/user-form', data)
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
      users: withEmployeeCode(users),
      total,
      page,
      pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
      q,
      oob: false,
    })
  })

  /** htmx 직원 검색. 폼 안의 #employee-picker 조각만 갈아끼운다. */
  app.get('/admin/users/employees', async (request, reply) => {
    const { q } = employeeQuery.parse(request.query)
    // 퇴직자는 신규 발급 대상이 아니므로 목록에 아예 올리지 않는다(§8-③).
    const employees = q.length >= 2 ? await searchEmployees({ q }) : []
    return reply.view('domains/users/views/employee-picker', { q, employees })
  })

  /**
   * 직원을 확정한(또는 시스템 계정용) 폼 조각.
   * 아이디·비밀번호를 다 친 뒤에 거절당하지 않도록 중복·퇴직 검증을 여기서 먼저 한다.
   */
  app.get('/admin/users/new', async (request, reply) => {
    const { employeeCode, standalone } = newFormQuery.parse(request.query)

    if (standalone) {
      return renderForm(reply, 200, { errors: [], values: {}, employee: null, standalone: true })
    }
    // 인자 없이 오면 처음 상태(직원 검색)로 되돌린다 — 폼의 "다시 선택"이 이 경로다.
    if (!employeeCode) {
      return renderForm(reply, 200, { errors: [], values: {}, employee: null, standalone: false })
    }

    const denied = await denyEmployeeCode(employeeCode)
    if (denied) {
      return renderForm(reply, 422, {
        errors: [denied],
        values: {},
        employee: null,
        standalone: false,
      })
    }

    const employee = await getEmployeeByCode(employeeCode)
    return renderForm(reply, 200, { errors: [], values: {}, employee, standalone: false })
  })

  /**
   * 사번을 계정에 연결할 수 없는 이유. 연결 가능하면 null.
   * 폼을 열 때와 등록할 때 두 번 부른다 — 그 사이에 다른 관리자가 먼저 만들었을 수 있다.
   */
  async function denyEmployeeCode(code: string): Promise<string | null> {
    if (!code) return '직원을 먼저 선택하라.'

    const employee = await getEmployeeByCode(code)
    if (!employee) return `미러에 없는 사번이다(${code}). 먼저 직원 동기화를 실행하라.`
    if (isRetired(employee)) return `퇴직자에게는 새 계정을 발급하지 않는다(${employee.koreanName}).`

    const existing = await findUserByEmployeeCode(code)
    if (existing) return `이 사번은 이미 ${existing.username} 계정에 연결되어 있다.`

    return null
  }

  app.post('/admin/users', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>
    const standalone = body.standalone === 'true'

    if (standalone) {
      const parsed = standaloneCreateForm.safeParse(body)
      if (!parsed.success) {
        return renderForm(reply, 422, {
          errors: parsed.error.issues.map((i) => i.message),
          values: body,
          employee: null,
          standalone: true,
        })
      }

      try {
        await createUser({ ...parsed.data, email: parsed.data.email || undefined })
      } catch (error) {
        request.log.error({ err: error }, '시스템 계정 생성 실패')
        return renderForm(reply, 422, {
          errors: [adminErrorMessage(error)],
          values: body,
          employee: null,
          standalone: true,
        })
      }
      request.log.info({ actor: request.user!.sub, username: parsed.data.username }, '시스템 계정 생성')
    } else {
      const parsed = linkedCreateForm.safeParse(body)
      if (!parsed.success) {
        const employee = typeof body.employeeCode === 'string' ? await getEmployeeByCode(body.employeeCode) : null
        return renderForm(reply, 422, {
          errors: parsed.error.issues.map((i) => i.message),
          values: body,
          employee,
          standalone: false,
        })
      }

      const denied = await denyEmployeeCode(parsed.data.employeeCode)
      if (denied) {
        return renderForm(reply, 422, { errors: [denied], values: body, employee: null, standalone: false })
      }

      // denyEmployeeCode가 통과했으므로 미러에 반드시 있다.
      const employee = (await getEmployeeByCode(parsed.data.employeeCode))!
      try {
        await createUser({
          username: parsed.data.username,
          password: parsed.data.password,
          temporary: parsed.data.temporary,
          // 성명·이메일·사번은 폼이 아니라 미러에서만 온다. hidden 값을 믿으면
          // 사번과 성명이 어긋난 계정이 만들어진다.
          // 한글 성명은 2자 성씨 때문에 성/이름을 나눌 규칙이 없다 — firstName에 통째로 넣는다.
          firstName: employee.koreanName,
          // 급여이메일이 없는 사원이 있다. 그때는 이메일 없이 만든다(Keycloak email은 optional).
          email: employee.payrollEmail || undefined,
          employeeCode: employee.code,
        })
      } catch (error) {
        request.log.error({ err: error }, '사용자 생성 실패')
        return renderForm(reply, 422, {
          errors: [adminErrorMessage(error)],
          values: body,
          employee,
          standalone: false,
        })
      }
      request.log.info(
        { actor: request.user!.sub, username: parsed.data.username, employeeCode: employee.code },
        '직원 연동 계정 생성',
      )
    }

    const [users, total] = await Promise.all([listUsers({ max: PAGE_SIZE }), countUsers()])
    return reply.view('domains/users/views/after-user-create', {
      users: withEmployeeCode(users),
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
      ...(await employeeOf(target)),
    })
  })

  /**
   * 계정에 연결된 직원 정보. 사번이 없는 계정과, 사번은 있는데 미러에 없는 계정을
   * 화면에서 구분해야 해서 code와 employee를 따로 넘긴다.
   */
  async function employeeOf(target: KcUser) {
    const employeeCode = employeeCodeOf(target)
    const employee = employeeCode ? await getEmployeeByCode(employeeCode) : null
    return { employeeCode, employee, retired: employee ? isRetired(employee) : false }
  }

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
      ...(await employeeOf(target)),
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
