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

export async function listUsers(options: {
  search?: string
  first?: number
  max?: number
}): Promise<KcUser[]> {
  const params = new URLSearchParams({
    first: String(options.first ?? 0),
    max: String(options.max ?? 20),
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

export async function createUser(input: {
  username: string
  email?: string
  firstName?: string
  lastName?: string
  password: string
  temporary: boolean
}): Promise<void> {
  await kc('/users', {
    method: 'POST',
    body: JSON.stringify({
      username: input.username,
      email: input.email || undefined,
      firstName: input.firstName || undefined,
      lastName: input.lastName || undefined,
      enabled: true,
      emailVerified: false,
      credentials: [{ type: 'password', value: input.password, temporary: input.temporary }],
    }),
  })
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
