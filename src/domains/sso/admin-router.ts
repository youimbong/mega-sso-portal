import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { requireAdmin } from '../auth/index.js'
import { env } from '../../shared/env.js'
import {
  createClient,
  deleteClient,
  findClientById,
  listClients,
  rotateClientSecret,
  toggleClient,
  updateClient,
  type ClientInput,
} from './clients.js'
import { isReservedClientId, parseRoleList, parseUriList, redirectUriError } from './validate.js'

const idParam = z.object({ id: z.uuid() })

const PORTAL_ORIGIN = new URL(env.APP_BASE_URL).origin

const clientForm = z.object({
  clientId: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'client_id는 소문자·숫자·하이픈만 쓸 수 있다')
    .max(64),
  name: z.string().trim().min(1, '이름은 필수다').max(120),
  /** 줄바꿈으로 구분한다. 완전 일치로만 검증하므로 앱이 쓰는 주소를 그대로 적어야 한다. */
  redirectUris: z.string().default(''),
  postLogoutRedirectUris: z.string().default(''),
  backchannelLogoutUri: z.string().trim().default(''),
  requiredRoles: z.string().trim().default(''),
  /** 체크박스는 꺼져 있으면 필드 자체가 오지 않는다. 값의 유무로 판단한다. */
  enabled: z.literal('true').optional(),
})

type FormValues = z.infer<typeof clientForm>

/** 폼 값 → 저장 입력. URI 규칙 위반은 zod가 아니라 여기서 사람이 읽을 사유로 모은다. */
function toClientInput(values: FormValues): { input: ClientInput; errors: string[] } {
  const errors: string[] = []

  if (isReservedClientId(values.clientId)) {
    errors.push(`${values.clientId} 는 예약된 client_id다`)
  }

  const redirectUris = parseUriList(values.redirectUris)
  if (redirectUris.length === 0) errors.push('redirect_uri를 하나 이상 등록해야 한다')

  const postLogoutRedirectUris = parseUriList(values.postLogoutRedirectUris)
  const backchannel = values.backchannelLogoutUri || null

  for (const uri of [...redirectUris, ...postLogoutRedirectUris]) {
    const reason = redirectUriError(uri, PORTAL_ORIGIN)
    if (reason) errors.push(reason)
  }
  if (backchannel) {
    const reason = redirectUriError(backchannel, PORTAL_ORIGIN)
    if (reason) errors.push(reason)
  }

  return {
    input: {
      clientId: values.clientId,
      name: values.name,
      redirectUris,
      postLogoutRedirectUris,
      backchannelLogoutUri: backchannel,
      requiredRoles: parseRoleList(values.requiredRoles),
      enabled: values.enabled === 'true',
    },
    errors,
  }
}

export async function ssoAdminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  app.get('/admin/sso-clients', async (request, reply) => {
    return reply.view('domains/sso/views/sso-clients', {
      user: request.user!,
      baseUrl: env.APP_BASE_URL,
      clients: await listClients(),
      errors: [],
      // 새 폼의 기본값. 활성 체크박스는 켜진 상태로 연다.
      values: { enabled: 'true' },
    })
  })

  app.post('/admin/sso-clients', async (request, reply) => {
    const parsed = clientForm.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(422).view('domains/sso/views/form', {
        errors: parsed.error.issues.map((i) => i.message),
        values: request.body ?? {},
      })
    }

    const { input, errors } = toClientInput(parsed.data)
    if (errors.length > 0) {
      return reply.code(422).view('domains/sso/views/form', { errors, values: request.body ?? {} })
    }

    let clientSecret: string
    try {
      ;({ clientSecret } = await createClient(input))
    } catch (error) {
      request.log.error({ err: error }, 'sso 클라이언트 등록 실패')
      return reply.code(422).view('domains/sso/views/form', {
        errors: ['등록하지 못했다. client_id가 이미 쓰이고 있는지 확인하라.'],
        values: request.body ?? {},
      })
    }

    // 평문 secret은 이 응답에만 존재한다. 폼·목록과 함께 out-of-band로 얹어 보낸다.
    return reply.view('domains/sso/views/after-create', {
      clients: await listClients(),
      secret: { clientId: input.clientId, value: clientSecret },
    })
  })

  app.get<{ Params: { id: string } }>('/admin/sso-clients/:id', async (request, reply) => {
    const parsed = idParam.safeParse(request.params)
    const client = parsed.success ? await findClientById(parsed.data.id) : null
    if (!client) {
      return reply.code(404).view('shared/views/error', {
        user: request.user,
        title: '클라이언트를 찾을 수 없다',
        message: '삭제됐거나 주소가 틀렸다.',
      })
    }

    return reply.view('domains/sso/views/detail', {
      user: request.user!,
      baseUrl: env.APP_BASE_URL,
      client,
      errors: [],
    })
  })

  app.post<{ Params: { id: string } }>('/admin/sso-clients/:id', async (request, reply) => {
    const params = idParam.safeParse(request.params)
    if (!params.success) return reply.code(400).send({ error: '잘못된 id' })

    const client = await findClientById(params.data.id)
    if (!client) return reply.code(404).send({ error: '없는 클라이언트' })

    // 검증 실패 시 되돌려줄 화면 값. 체크박스는 꺼지면 필드가 오지 않으므로 따로 덮어쓴다.
    const body = (request.body ?? {}) as Record<string, unknown>
    const echoed = { ...client, ...body, enabled: body.enabled === 'true' }

    // client_id는 하위 앱 설정에 박혀 있어 수정하지 않는다. 기존 값으로 검증만 통과시킨다.
    const parsed = clientForm.safeParse({ ...body, clientId: client.clientId })
    if (!parsed.success) {
      return reply.code(422).view('domains/sso/views/edit-form', {
        client: echoed,
        errors: parsed.error.issues.map((i) => i.message),
        saved: false,
      })
    }

    const { input, errors } = toClientInput(parsed.data)
    if (errors.length > 0) {
      return reply.code(422).view('domains/sso/views/edit-form', {
        client: echoed,
        errors,
        saved: false,
      })
    }

    const { clientId: _unused, ...rest } = input
    await updateClient(client.id, rest)

    return reply.view('domains/sso/views/edit-form', {
      client: { ...client, ...rest },
      errors: [],
      saved: true,
    })
  })

  app.post<{ Params: { id: string } }>('/admin/sso-clients/:id/secret', async (request, reply) => {
    const parsed = idParam.safeParse(request.params)
    if (!parsed.success) return reply.code(400).send({ error: '잘못된 id' })

    const client = await findClientById(parsed.data.id)
    if (!client) return reply.code(404).send({ error: '없는 클라이언트' })

    const { clientSecret } = await rotateClientSecret(client.id)

    return reply.view('domains/sso/views/secret', {
      secret: { clientId: client.clientId, value: clientSecret },
      oob: false,
    })
  })

  app.post<{ Params: { id: string } }>('/admin/sso-clients/:id/toggle', async (request, reply) => {
    const parsed = idParam.safeParse(request.params)
    if (!parsed.success) return reply.code(400).send({ error: '잘못된 id' })

    await toggleClient(parsed.data.id)
    return reply.view('domains/sso/views/table', { clients: await listClients(), oob: false })
  })

  app.post<{ Params: { id: string } }>('/admin/sso-clients/:id/delete', async (request, reply) => {
    const parsed = idParam.safeParse(request.params)
    if (!parsed.success) return reply.code(400).send({ error: '잘못된 id' })

    await deleteClient(parsed.data.id)
    return reply.view('domains/sso/views/table', { clients: await listClients(), oob: false })
  })
}
