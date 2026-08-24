import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'

import { requireAdmin } from '../auth/index.js'
import {
  getEmployeeByCode,
  getEmployeesByCodes,
  isRetired,
  isSearchableTerm,
  missingA10Config,
  searchEmployees,
  type Employee,
} from '../hr/index.js'
import {
  addUserRoles,
  countUsers,
  createUser,
  deleteUser,
  employeeCodeOf,
  EmployeeCodeConflictError,
  EmployeeCodeNotStoredError,
  findUserByEmployeeCode,
  getEffectiveUserRoles,
  getUser,
  getUserRoles,
  isFederated,
  KeycloakAdminError,
  listAssignableRoles,
  listUsers,
  logoutUser,
  removeUserRoles,
  resetPassword,
  setEmployeeCode,
  setUserEnabled,
  updateUserProfile,
  type KcRole,
  type KcUser,
} from './service.js'
import { checkAgainstMirror, pickMirrorEmail } from './mirror-check.js'
import { diffRoles } from './role-diff.js'
import { looksLikeEmployeeCode } from './search-hint.js'

const PAGE_SIZE = 20

/**
 * 점검 화면이 한 번에 훑는 계정 수 상한.
 * Keycloak에는 "사번이 붙은 계정만" 같은 조건 조회가 없어 전건을 받아 포털에서 거른다.
 * 이 수를 넘으면 화면에 잘렸다고 알린다 — 조용히 일부만 보여주면 점검이 아니다.
 */
const CHECKUP_SCAN_LIMIT = 1_000

/**
 * 주소창에서 온 값이라 잘못돼도 500이 될 이유가 없다.
 * `.catch()`로 필드마다 기본값에 떨어뜨린다(`?page=abc`가 Zod 오류 JSON을 노출했다).
 */
const listQuery = z.object({
  q: z.string().trim().max(100).catch(''),
  page: z.coerce.number().int().min(1).max(10_000).catch(1),
})

/** 직원 선택 목록 검색. 너무 짧은 검색어는 hr 쪽에서 빈 배열로 돌아온다. */
const employeeQuery = z.object({ q: z.string().trim().max(100).catch('') })

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

/** 기존 계정의 성명·이메일 수정. 직원 연동 계정에는 쓰지 않는다(미러가 원본이다). */
const profileForm = z.object({
  email: z.union([z.email('이메일 형식이 올바르지 않다'), z.literal('')]).default(''),
  firstName: z.string().trim().max(64).default(''),
  lastName: z.string().trim().max(64).default(''),
})

const linkForm = z.object({
  employeeCode: z.string({ error: '연결할 사번을 입력하라' }).trim().min(1, '연결할 사번을 입력하라').max(10),
})

/** 해제는 되돌리려면 사번을 다시 찾아 넣어야 한다. 체크 한 번을 더 받는다. */
const unlinkForm = z.object({
  confirm: z.literal('unlink', { error: '해제하려면 확인란을 체크하라.' }),
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
  if (error instanceof EmployeeCodeNotStoredError) return error.message
  if (error instanceof EmployeeCodeConflictError) return error.message
  if (error instanceof KeycloakAdminError) {
    if (error.status === 409) return '이미 같은 아이디 또는 이메일을 쓰는 사용자가 있다.'
    if (error.status === 403) return 'Keycloak이 이 작업을 거부했다. service account 권한을 확인하라.'
    // 400은 대개 User Profile 검증(잘못된 이메일 등)이다. 어느 항목인지 알려야 관리자가 고친다.
    if (error.status === 400) {
      const field = keycloakFieldError(error.message)
      if (field) return `Keycloak이 입력을 거부했다: ${field}`
    }
  }
  return '처리하지 못했다. 서버 로그를 확인하라.'
}

/** Keycloak 400 본문의 `{"field":"email","errorMessage":"error-invalid-email"}`를 한 줄로 만든다. */
function keycloakFieldError(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { field?: unknown; errorMessage?: unknown }
    const parts = [parsed.field, parsed.errorMessage].filter((v) => typeof v === 'string')
    return parts.length > 0 ? parts.join(' — ') : null
  } catch {
    return null
  }
}

export async function usersRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  /**
   * 목록 행에 사번과 미러 상태(퇴직·미러 없음·미러와 다름)를 붙인다.
   * 사번을 모아 한 번에 조회한다 — 행마다 질의하면 계정 수만큼 왕복이 생긴다.
   */
  async function annotate(users: KcUser[]) {
    const rows = users.map((u) => ({ ...u, employeeCode: employeeCodeOf(u) }))
    const codes = [...new Set(rows.map((r) => r.employeeCode).filter((c): c is string => Boolean(c)))]
    const mirror = new Map((await getEmployeesByCodes(codes)).map((e) => [e.code, e]))

    return rows.map((row) => {
      const employee = row.employeeCode ? (mirror.get(row.employeeCode) ?? null) : null
      return {
        ...row,
        employee,
        retired: employee ? isRetired(employee) : false,
        missingMirror: Boolean(row.employeeCode) && !employee,
        mismatches: checkAgainstMirror({ account: row, employee }),
      }
    })
  }

  /**
   * 목록 한 페이지.
   *
   * Keycloak의 `search=`는 username/email/성명만 훑고 attribute는 보지 않는다. 그래서 사번꼴
   * 검색어는 `findUserByEmployeeCode`로 한 건 더 찾아 첫 페이지 맨 앞에 얹는다.
   * 그 한 건은 Keycloak의 count에 안 잡히므로 total도 함께 1 늘린다.
   */
  async function loadPage(q: string, page: number) {
    const first = (page - 1) * PAGE_SIZE
    const [users, total] = await Promise.all([
      listUsers({ search: q || undefined, first, max: PAGE_SIZE }),
      countUsers(q || undefined),
    ])

    if (!looksLikeEmployeeCode(q)) return { users: await annotate(users), total }

    const byCode = await findUserByEmployeeCode(q.trim())
    if (!byCode || users.some((u) => u.id === byCode.id)) {
      return { users: await annotate(users), total }
    }
    if (first > 0) return { users: await annotate(users), total: total + 1 }

    return { users: await annotate([byCode, ...users].slice(0, PAGE_SIZE)), total: total + 1 }
  }

  async function renderList(
    reply: FastifyReply,
    opts: { q: string; page: number; errors: string[]; values: unknown },
  ) {
    const { users, total } = await loadPage(opts.q, opts.page)

    return reply.view('domains/users/views/users', {
      user: reply.request.user!,
      users,
      total,
      page: opts.page,
      pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
      q: opts.q,
      errors: opts.errors,
      values: opts.values,
      // 첫 진입은 항상 직원 검색부터다. 직원이 정해진 폼은 htmx 조각으로만 나온다.
      employee: null,
      standalone: false,
      roles: await listAssignableRoles(),
    })
  }

  /** 폼 조각(#user-form-wrap) 하나만 돌려준다. 오류 재렌더도 이 경로를 탄다. */
  async function renderForm(
    reply: FastifyReply,
    status: number,
    data: { errors: string[]; values: unknown; employee: Employee | null; standalone: boolean },
  ) {
    return reply.code(status).view('domains/users/views/user-form', {
      ...data,
      roles: await listAssignableRoles(),
    })
  }

  app.get('/admin/users', async (request, reply) => {
    const { q, page } = listQuery.parse(request.query)
    return renderList(reply, { q, page, errors: [], values: {} })
  })

  /** htmx 검색. 표 부분만 갈아끼운다. */
  app.get('/admin/users/table', async (request, reply) => {
    const { q, page } = listQuery.parse(request.query)
    const { users, total } = await loadPage(q, page)

    return reply.view('domains/users/views/user-table', {
      users,
      total,
      page,
      pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
      q,
      oob: false,
    })
  })

  /**
   * 계정 점검. 사번이 붙은 계정을 전부 미러와 대조해 퇴직·미러 없음·값 어긋남만 남긴다.
   * 자동으로 잠그거나 덮어쓰지 않는다 — 관리자가 보고 판단한다(hr/CLAUDE.md의 불변 규칙).
   */
  app.get('/admin/users/checkup', async (request, reply) => {
    const users = await listUsers({ max: CHECKUP_SCAN_LIMIT })
    const rows = (await annotate(users)).filter(
      (r) => r.employeeCode && (r.retired || r.missingMirror || r.mismatches.length > 0),
    )

    return reply.view('domains/users/views/user-checkup', {
      user: request.user!,
      title: '계정 점검',
      rows,
      scanned: users.length,
      truncated: users.length >= CHECKUP_SCAN_LIMIT,
      a10Missing: missingA10Config(),
    })
  })

  /** htmx 직원 검색. 폼 안의 #employee-picker 조각만 갈아끼운다. */
  app.get('/admin/users/employees', async (request, reply) => {
    const { q } = employeeQuery.parse(request.query)
    // 퇴직자는 신규 발급 대상이 아니므로 목록에 아예 올리지 않는다(§8-③).
    const searchable = isSearchableTerm(q)
    const employees = searchable ? await searchEmployees({ q }) : []
    return reply.view('domains/users/views/employee-picker', {
      q,
      employees,
      searchable,
      // 미러가 비어 검색이 안 되는 것인지, 그냥 없는 사람인지 구분해줘야 관리자가 조치한다.
      a10Missing: missingA10Config(),
    })
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
   * 나중에 사번을 붙이는 경로(POST /:id/employee)도 같은 검증을 쓴다.
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

  /**
   * 등록 폼에서 고른 역할을 부여한다. 부여에 실패해도 계정은 이미 만들어졌으므로
   * 지우지 않고(비밀번호까지 다시 받아야 한다) 화면에 남은 할 일을 알린다.
   */
  async function grantInitialRoles(id: string, desired: string[]): Promise<string | null> {
    if (desired.length === 0) return null

    const assignable = await listAssignableRoles()
    const { add } = diffRoles({
      assignable: assignable.map((r) => r.name),
      current: [],
      desired,
    })
    const byName = new Map<string, KcRole>(assignable.map((r) => [r.name, r]))

    try {
      await addUserRoles(id, add.map((n) => byName.get(n)!).filter(Boolean))
      return null
    } catch {
      return '계정은 만들었지만 역할을 부여하지 못했다. 상세 화면에서 역할을 지정하라.'
    }
  }

  app.post('/admin/users', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>
    const standalone = body.standalone === 'true'
    const desiredRoles = toArray(body.roles)
    /** 등록은 됐지만 뒤이은 작업이 실패했을 때 목록 위에 남기는 문구. */
    let warning: string | null = null

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

      let id: string
      try {
        id = await createUser({ ...parsed.data, email: parsed.data.email || undefined })
      } catch (error) {
        request.log.error({ err: error }, '시스템 계정 생성 실패')
        return renderForm(reply, 422, {
          errors: [adminErrorMessage(error)],
          values: body,
          employee: null,
          standalone: true,
        })
      }
      warning = await grantInitialRoles(id, desiredRoles)
      request.log.info(
        { actor: request.user!.sub, username: parsed.data.username, roles: desiredRoles },
        '시스템 계정 생성',
      )
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
      // A10 급여이메일이 이메일 형식이 아닌 사원이 있다. 그대로 넘기면 Keycloak이 400으로
      // 거절해 계정을 아예 못 만든다 — 형식이 아니면 버리고 무엇을 버렸는지 알린다.
      const mirrorEmail = pickMirrorEmail(employee.payrollEmail)

      let id: string
      try {
        id = await createUser({
          username: parsed.data.username,
          password: parsed.data.password,
          temporary: parsed.data.temporary,
          // 성명·이메일·사번은 폼이 아니라 미러에서만 온다. hidden 값을 믿으면
          // 사번과 성명이 어긋난 계정이 만들어진다.
          // 한글 성명은 2자 성씨 때문에 성/이름을 나눌 규칙이 없다 — firstName에 통째로 넣는다.
          firstName: employee.koreanName,
          email: mirrorEmail.email ?? undefined,
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

      warning = await grantInitialRoles(id, desiredRoles)
      if (!warning && mirrorEmail.rejected) {
        warning = `A10 급여이메일(${mirrorEmail.rejected})이 이메일 형식이 아니라 이메일 없이 만들었다. A10에서 고친 뒤 상세 화면에서 미러를 다시 가져와라.`
      }
      request.log.info(
        {
          actor: request.user!.sub,
          username: parsed.data.username,
          employeeCode: employee.code,
          roles: desiredRoles,
        },
        '직원 연동 계정 생성',
      )
    }

    const { users, total } = await loadPage('', 1)
    return reply.view('domains/users/views/after-user-create', {
      users,
      total,
      page: 1,
      pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
      q: '',
      errors: warning ? [warning] : [],
      roles: await listAssignableRoles(),
    })
  })

  /**
   * 상세 화면에 필요한 값 한 벌.
   * 성공(GET)과 실패(detailWithError)가 같은 화면을 그리므로 한 곳에서만 모은다.
   */
  async function detailModel(request: FastifyRequest, id: string) {
    const [target, assignable, direct, effective] = await Promise.all([
      getUser(id),
      listAssignableRoles(),
      getUserRoles(id),
      getEffectiveUserRoles(id),
    ])

    const assigned = direct.map((r) => r.name)
    // default-roles-mega 컴포지트로 딸려온 역할은 체크박스로 회수할 수 없다.
    // 직접 매핑만 보여주면 "해제했는데 그대로다"가 된다 — 상속분은 따로 표시한다.
    const inherited = effective.map((r) => r.name).filter((name) => !assigned.includes(name))

    const employeeCode = employeeCodeOf(target)
    const employee = employeeCode ? await getEmployeeByCode(employeeCode) : null

    return {
      user: request.user!,
      target,
      federated: isFederated(target),
      isSelf: request.user!.sub === target.id,
      assignable,
      assigned,
      inherited,
      employeeCode,
      employee,
      retired: employee ? isRetired(employee) : false,
      mismatches: checkAgainstMirror({ account: target, employee }),
      mirrorEmail: pickMirrorEmail(employee?.payrollEmail),
    }
  }

  async function detailWithError(reply: FastifyReply, id: string, message: string) {
    return reply.code(422).view('domains/users/views/user-detail', {
      ...(await detailModel(reply.request, id)),
      notice: null,
      errors: [message],
    })
  }

  /**
   * 없는 id로 상세를 열면(삭제 직후 뒤로 가기) Keycloak 응답 본문이 그대로 새어나갔다.
   * 포털의 404 화면으로 바꾼다.
   */
  function isNotFound(error: unknown): boolean {
    return error instanceof KeycloakAdminError && error.status === 404
  }

  function renderNotFound(request: FastifyRequest, reply: FastifyReply) {
    return reply.code(404).view('shared/views/error', {
      user: request.user,
      title: '없는 사용자',
      message: '이미 삭제되었거나 잘못된 주소다.',
    })
  }

  app.get<{ Params: { id: string } }>('/admin/users/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params)
    const notice = (request.query as Record<string, unknown>).notice

    try {
      return reply.view('domains/users/views/user-detail', {
        ...(await detailModel(request, id)),
        notice: typeof notice === 'string' ? notice : null,
        errors: [],
      })
    } catch (error) {
      if (isNotFound(error)) return renderNotFound(request, reply)
      throw error
    }
  })

  /**
   * 성명·이메일 수정.
   * 직원 연동 계정은 여기서 막는다 — A10이 단일 원천이고, 미러 반영은 아래 sync 경로가 한다.
   */
  app.post<{ Params: { id: string } }>('/admin/users/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params)
    const target = await getUser(id)

    if (isFederated(target)) {
      return detailWithError(reply, id, '외부 저장소(AD/LDAP) 사용자의 정보는 여기서 바꿀 수 없다.')
    }
    if (employeeCodeOf(target)) {
      return detailWithError(
        reply,
        id,
        '직원 연동 계정의 성명·이메일은 수기로 고치지 않는다. A10에서 고치고 동기화한 뒤 "미러에서 다시 가져오기"를 눌러라.',
      )
    }

    // 폼을 거치지 않은 빈 요청도 온다. undefined를 넘기면 Zod 원문이 화면에 뜬다.
    const parsed = profileForm.safeParse(request.body ?? {})
    if (!parsed.success) {
      return detailWithError(reply, id, parsed.error.issues[0]?.message ?? '입력이 올바르지 않다.')
    }

    try {
      await updateUserProfile(id, parsed.data)
    } catch (error) {
      request.log.error({ err: error }, '계정 정보 수정 실패')
      return detailWithError(reply, id, adminErrorMessage(error))
    }

    request.log.info({ actor: request.user!.sub, target: id }, '계정 정보 수정')
    return reply.redirect(`/admin/users/${encodeURIComponent(id)}?notice=profile-saved`)
  })

  /** 미러(A10) 값으로 성명·이메일을 다시 채운다. 직원 연동 계정에서 값을 고치는 유일한 경로다. */
  app.post<{ Params: { id: string } }>('/admin/users/:id/employee/sync', async (request, reply) => {
    const { id } = idParam.parse(request.params)
    const target = await getUser(id)

    if (isFederated(target)) {
      return detailWithError(reply, id, '외부 저장소(AD/LDAP) 사용자의 정보는 여기서 바꿀 수 없다.')
    }

    const code = employeeCodeOf(target)
    if (!code) return detailWithError(reply, id, '직원 연결이 없는 계정이다. 먼저 사번을 연결하라.')

    const employee = await getEmployeeByCode(code)
    if (!employee) {
      return detailWithError(reply, id, `미러에 없는 사번이다(${code}). 먼저 직원 동기화를 실행하라.`)
    }

    const mirrorEmail = pickMirrorEmail(employee.payrollEmail)
    try {
      await updateUserProfile(id, {
        firstName: employee.koreanName,
        // 한글 성명은 firstName에 통째로 들어간다. 남아 있던 lastName은 비운다.
        lastName: '',
        // 미러에 이메일이 없으면(실측 101명 중 100명) 계정 이메일을 지우지 않는다 —
        // "값 없음"을 "지워라"로 읽으면 쓰던 이메일이 사라진다.
        email: mirrorEmail.email ?? target.email ?? '',
      })
    } catch (error) {
      request.log.error({ err: error }, '미러 반영 실패')
      return detailWithError(reply, id, adminErrorMessage(error))
    }

    request.log.info({ actor: request.user!.sub, target: id, employeeCode: code }, '미러 값 반영')
    return reply.redirect(`/admin/users/${encodeURIComponent(id)}?notice=mirror-synced`)
  })

  /** 이미 있는 계정에 사번을 붙인다. 등록 플로우와 같은 검증(미러·퇴직·중복)을 쓴다. */
  app.post<{ Params: { id: string } }>('/admin/users/:id/employee', async (request, reply) => {
    const { id } = idParam.parse(request.params)
    const target = await getUser(id)

    if (isFederated(target)) {
      return detailWithError(reply, id, '외부 저장소(AD/LDAP) 사용자는 여기서 사번을 붙일 수 없다.')
    }
    if (employeeCodeOf(target)) {
      return detailWithError(reply, id, '이미 사번이 연결되어 있다. 먼저 연결을 해제하라.')
    }

    // 폼을 거치지 않은 빈 요청도 온다. undefined를 넘기면 Zod 원문이 화면에 뜬다.
    const parsed = linkForm.safeParse(request.body ?? {})
    if (!parsed.success) {
      return detailWithError(reply, id, parsed.error.issues[0]?.message ?? '입력이 올바르지 않다.')
    }

    const denied = await denyEmployeeCode(parsed.data.employeeCode)
    if (denied) return detailWithError(reply, id, denied)

    try {
      await setEmployeeCode(id, parsed.data.employeeCode)
    } catch (error) {
      request.log.error({ err: error }, '사번 연결 실패')
      return detailWithError(reply, id, adminErrorMessage(error))
    }

    request.log.info(
      { actor: request.user!.sub, target: id, employeeCode: parsed.data.employeeCode },
      '사번 연결',
    )
    return reply.redirect(`/admin/users/${encodeURIComponent(id)}?notice=employee-linked`)
  })

  /** 사번 연결 해제. 계정은 그대로 두고 employee_code claim만 사라진다. */
  app.post<{ Params: { id: string } }>('/admin/users/:id/employee/unlink', async (request, reply) => {
    const { id } = idParam.parse(request.params)
    const target = await getUser(id)

    const code = employeeCodeOf(target)
    if (!code) return detailWithError(reply, id, '연결된 사번이 없다.')

    // 폼을 거치지 않은 빈 요청도 온다. undefined를 넘기면 Zod 원문이 화면에 뜬다.
    const parsed = unlinkForm.safeParse(request.body ?? {})
    if (!parsed.success) {
      return detailWithError(reply, id, parsed.error.issues[0]?.message ?? '해제하려면 확인란을 체크하라.')
    }

    try {
      await setEmployeeCode(id, null)
    } catch (error) {
      request.log.error({ err: error }, '사번 연결 해제 실패')
      return detailWithError(reply, id, adminErrorMessage(error))
    }

    request.log.warn({ actor: request.user!.sub, target: id, employeeCode: code }, '사번 연결 해제')
    return reply.redirect(`/admin/users/${encodeURIComponent(id)}?notice=employee-unlinked`)
  })

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
