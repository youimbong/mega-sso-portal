import * as client from 'openid-client'

import { env } from '../../shared/env.js'
import { getOidcConfig } from '../auth/index.js'

/**
 * Keycloak Admin REST API 클라이언트.
 *
 * 포털의 service account(`portal` 클라이언트)로 호출한다.
 * 그 계정에는 realm-management의 query-users / view-users / view-realm / manage-users 만 있고
 * realm-admin은 없다. 즉 이 클라이언트로 클라이언트 설정이나 realm 설정은 건드릴 수 없다.
 */

/** `https://kc/realms/mega` → `https://kc/admin/realms/mega` */
function adminBaseUrl(): string {
  const issuer = new URL(env.OIDC_ISSUER)
  const match = issuer.pathname.match(/^(.*)\/realms\/([^/]+)\/?$/)
  if (!match) throw new Error(`OIDC_ISSUER에서 realm을 찾을 수 없다: ${env.OIDC_ISSUER}`)
  return `${issuer.origin}${match[1]}/admin/realms/${match[2]}`
}

let cachedToken: { value: string; expiresAt: number } | undefined

async function adminToken(): Promise<string> {
  // 만료 30초 전에는 새로 받는다. 요청이 도중에 만료되는 것을 막는다.
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) return cachedToken.value

  const tokens = await client.clientCredentialsGrant(await getOidcConfig())
  if (!tokens.access_token) throw new Error('service account 토큰을 받지 못했다')

  cachedToken = {
    value: tokens.access_token,
    expiresAt: Date.now() + (tokens.expiresIn() ?? 60) * 1000,
  }
  return cachedToken.value
}

export class KeycloakAdminError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'KeycloakAdminError'
  }
}

async function kc(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(`${adminBaseUrl()}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${await adminToken()}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  })

  if (!response.ok) {
    const body = await response.text()
    throw new KeycloakAdminError(response.status, body.slice(0, 400))
  }
  return response
}

async function kcJson<T>(path: string, init?: RequestInit): Promise<T> {
  return (await kc(path, init)).json() as Promise<T>
}

export type KcUser = {
  id: string
  username: string
  email?: string
  firstName?: string
  lastName?: string
  enabled: boolean
  createdTimestamp?: number
  /** AD/LDAP 등 외부 저장소에서 온 사용자. 값이 있으면 포털에서 수정할 수 없다. */
  federationLink?: string
  /**
   * Keycloak user attribute. 값은 항상 배열이다(단일 값도 원소 1개).
   * 포털이 읽는 것은 `employeeCode`(사번) 하나다 — `employeeCodeOf()`로만 꺼낸다.
   */
  attributes?: Record<string, string[] | undefined>
}

export type KcRole = { id: string; name: string; description?: string }

/**
 * 화면에 노출하지 않는 역할.
 * Keycloak이 내부적으로 쓰는 것들이라 관리자가 손댈 이유가 없다.
 */
const HIDDEN_ROLES = new Set(['offline_access', 'uma_authorization'])

function isDefaultRolesComposite(name: string): boolean {
  return name.startsWith('default-roles-')
}

export function isFederated(user: KcUser): boolean {
  return Boolean(user.federationLink)
}

/** service account 자신은 관리 목록에 나오면 안 된다. */
function isServiceAccount(user: KcUser): boolean {
  return user.username.startsWith('service-account-')
}

/** 사번은 Keycloak user attribute에 산다. 계정과 사번의 연결 원본은 여기 하나뿐이다. */
export function employeeCodeOf(user: KcUser): string | null {
  return user.attributes?.employeeCode?.[0] || null
}

export async function listUsers(options: {
  search?: string
  first?: number
  max?: number
}): Promise<KcUser[]> {
  const params = new URLSearchParams({
    first: String(options.first ?? 0),
    max: String(options.max ?? 20),
    // 기본(brief) 응답에는 attributes가 빠진다. 목록에 사번 열을 띄우려면 꺼야 한다.
    briefRepresentation: 'false',
  })
  if (options.search) params.set('search', options.search)

  const users = await kcJson<KcUser[]>(`/users?${params}`)
  return users.filter((u) => !isServiceAccount(u))
}

export async function countUsers(search?: string): Promise<number> {
  const params = new URLSearchParams()
  if (search) params.set('search', search)
  return kcJson<number>(`/users/count?${params}`)
}

export async function getUser(id: string): Promise<KcUser> {
  return kcJson<KcUser>(`/users/${encodeURIComponent(id)}`)
}

/**
 * 사번으로 계정 1건을 찾는다. 없으면 null.
 *
 * Keycloak은 attribute 중복을 막지 않으므로(같은 사번으로 두 번 만들어도 201) 중복 방지는
 * 이 조회에 전적으로 의존한다. `q=key:value`는 완전일치 검색이고 query-users 권한으로 된다.
 * 그래도 응답을 한 번 더 대조하는 것은, 이 함수가 "그 사번은 이미 쓰였다"는 판단의
 * 유일한 근거라서다.
 */
export async function findUserByEmployeeCode(code: string): Promise<KcUser | null> {
  const params = new URLSearchParams({
    q: `employeeCode:${code}`,
    max: '2',
    briefRepresentation: 'false',
  })
  const users = await kcJson<KcUser[]>(`/users?${params}`)
  return users.find((u) => employeeCodeOf(u) === code) ?? null
}

export async function createUser(input: {
  username: string
  email?: string
  firstName?: string
  lastName?: string
  password: string
  temporary: boolean
  /** A10 사번. 넣으면 employeeCode attribute로 저장되고 employee_code claim으로 나간다. */
  employeeCode?: string
}): Promise<void> {
  const created = await kc('/users', {
    method: 'POST',
    body: JSON.stringify({
      username: input.username,
      email: input.email || undefined,
      firstName: input.firstName || undefined,
      lastName: input.lastName || undefined,
      // 사번이 없으면 attributes 자체를 보내지 않는다 — 직원 연결이 없는 계정은
      // employee_code claim이 아예 실리지 않아야 소비자가 "직원 아님"으로 읽는다.
      attributes: input.employeeCode ? { employeeCode: [input.employeeCode] } : undefined,
      enabled: true,
      emailVerified: false,
      credentials: [{ type: 'password', value: input.password, temporary: input.temporary }],
    }),
  })

  if (input.employeeCode) await assertEmployeeCodeStored(created, input.employeeCode)
}

/**
 * 사번이 실제로 저장됐는지 되읽어 확인한다.
 *
 * realm의 User Profile에 `employeeCode`가 선언돼 있지 않으면 Keycloak은 attributes를
 * **201과 함께 조용히 버린다** — 응답만 보면 성공이고, 사번 없는 계정이 만들어진 줄 모른 채
 * 넘어간다. 그러면 `findUserByEmployeeCode`가 영원히 null을 돌려주어 사번 중복 방어까지
 * 함께 죽는다. realm 반영을 빠뜨렸을 때 첫 등록에서 바로 드러나게 한다.
 *
 * 확인에 실패하면 만들어진 계정을 지운다. 사번 없는 반쪽 계정을 남기는 것보다,
 * 아무것도 안 만든 상태에서 관리자가 realm을 고치고 다시 등록하는 편이 낫다.
 */
async function assertEmployeeCodeStored(created: Response, employeeCode: string): Promise<void> {
  // Keycloak은 생성된 사용자 id를 Location 헤더로만 알려준다.
  const id = created.headers.get('location')?.split('/').pop()
  if (!id) throw new Error('Keycloak이 생성된 사용자 id를 돌려주지 않았다')

  const stored = await kcJson<KcUser>(`/users/${encodeURIComponent(id)}?briefRepresentation=false`)
  if (employeeCodeOf(stored) === employeeCode) return

  await kc(`/users/${encodeURIComponent(id)}`, { method: 'DELETE' })
  throw new EmployeeCodeNotStoredError()
}

/** 이 오류만은 문구를 화면에 그대로 띄운다 — 관리자가 할 일(realm 반영)이 정해져 있다. */
export class EmployeeCodeNotStoredError extends Error {
  constructor() {
    super(
      'Keycloak이 사번을 저장하지 않았다. realm의 User Profile에 employeeCode 선언이 반영됐는지 확인하라. (계정은 만들어지지 않았다)',
    )
    this.name = 'EmployeeCodeNotStoredError'
  }
}

export async function setUserEnabled(id: string, enabled: boolean): Promise<void> {
  await kc(`/users/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
  })
}

export async function resetPassword(
  id: string,
  password: string,
  temporary: boolean,
): Promise<void> {
  await kc(`/users/${encodeURIComponent(id)}/reset-password`, {
    method: 'PUT',
    body: JSON.stringify({ type: 'password', value: password, temporary }),
  })
}

export async function deleteUser(id: string): Promise<void> {
  await kc(`/users/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** Keycloak의 SSO 세션을 끊는다. back-channel logout으로 포털 세션도 함께 끊긴다. */
export async function logoutUser(id: string): Promise<void> {
  await kc(`/users/${encodeURIComponent(id)}/logout`, { method: 'POST' })
}

/** 관리자가 부여할 수 있는 realm role 목록. */
export async function listAssignableRoles(): Promise<KcRole[]> {
  const roles = await kcJson<KcRole[]>('/roles')
  return roles
    .filter((r) => !HIDDEN_ROLES.has(r.name) && !isDefaultRolesComposite(r.name))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export async function getUserRoles(id: string): Promise<KcRole[]> {
  return kcJson<KcRole[]>(`/users/${encodeURIComponent(id)}/role-mappings/realm`)
}

export async function addUserRoles(id: string, roles: KcRole[]): Promise<void> {
  if (roles.length === 0) return
  await kc(`/users/${encodeURIComponent(id)}/role-mappings/realm`, {
    method: 'POST',
    body: JSON.stringify(roles.map((r) => ({ id: r.id, name: r.name }))),
  })
}

export async function removeUserRoles(id: string, roles: KcRole[]): Promise<void> {
  if (roles.length === 0) return
  await kc(`/users/${encodeURIComponent(id)}/role-mappings/realm`, {
    method: 'DELETE',
    body: JSON.stringify(roles.map((r) => ({ id: r.id, name: r.name }))),
  })
}
