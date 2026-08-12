import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { env, isProd } from '../../shared/env.js'
import { loadSession, SESSION_COOKIE, SESSION_TTL_MS, type CurrentUser } from './service.js'

export const PORTAL_ADMIN_ROLE = 'portal-admin'

declare module 'fastify' {
  interface FastifyRequest {
    user: CurrentUser | null
  }
}

export function isAdmin(user: CurrentUser): boolean {
  return user.roles.includes(PORTAL_ADMIN_ROLE)
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: env.APP_BASE_URL.startsWith('https://'),
  path: '/',
  signed: true,
  maxAge: Math.floor(SESSION_TTL_MS / 1000),
} as const

/**
 * 모든 요청에 request.user를 채운다.
 * 서명이 깨졌거나 DB에 세션이 없으면 쿠키를 지워 다음 요청부터 조회하지 않게 한다.
 */
export function registerAuth(app: FastifyInstance): void {
  app.decorateRequest('user', null)

  app.addHook('onRequest', async (request, reply) => {
    const raw = request.cookies[SESSION_COOKIE]
    if (!raw) return

    const unsigned = request.unsignCookie(raw)
    if (!unsigned.valid || !unsigned.value) {
      reply.clearCookie(SESSION_COOKIE, { path: '/' })
      return
    }

    const user = await loadSession(unsigned.value)
    if (!user) {
      reply.clearCookie(SESSION_COOKIE, { path: '/' })
      return
    }

    request.user = user
  })
}

/** 로그인 필수 라우트의 preHandler. 미로그인이면 Keycloak 로그인으로 보낸다. */
export async function requireUser(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (request.user) return

  const returnTo = encodeURIComponent(request.url)
  return reply.redirect(`/api/auth/login?returnTo=${returnTo}`)
}

/** 관리자 전용 라우트의 preHandler. */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.user) {
    const returnTo = encodeURIComponent(request.url)
    return reply.redirect(`/api/auth/login?returnTo=${returnTo}`)
  }

  if (!isAdmin(request.user)) {
    return reply.code(403).view('shared/views/error', {
      user: request.user,
      title: '접근 권한이 없다',
      message: `이 화면은 ${PORTAL_ADMIN_ROLE} 역할이 필요하다. 관리자에게 요청하라.`,
    })
  }
}

/**
 * 상태를 바꾸는 요청의 Origin 검사.
 * SameSite=Lax 쿠키가 1차 방어이고, 이것은 그 위의 2차 방어다.
 */
export function registerOriginCheck(app: FastifyInstance): void {
  const unsafe = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

  app.addHook('onRequest', async (request, reply) => {
    if (!unsafe.has(request.method)) return

    // Keycloak이 서버-서버로 호출하므로 브라우저 Origin이 없다. logout_token 서명으로 인증한다.
    if (request.url.startsWith('/api/auth/backchannel-logout')) return

    const origin = request.headers.origin
    if (origin && origin === env.APP_BASE_URL) return

    // Origin 헤더가 아예 없는 경우: 브라우저 폼 POST는 항상 보내므로 정상 요청이 아니다.
    // 다만 개발 중 curl 테스트를 막지 않도록 운영에서만 차단한다.
    if (!origin && !isProd) return

    return reply.code(403).send({ error: 'origin 불일치' })
  })
}
