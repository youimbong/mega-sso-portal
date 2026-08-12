/**
 * auth 도메인 공개 API.
 * 다른 도메인은 이 파일을 통해서만 auth를 참조한다. 내부 파일 직접 import 금지.
 */
export { authRoutes } from './router.js'
export {
  isAdmin,
  PORTAL_ADMIN_ROLE,
  registerAuth,
  registerOriginCheck,
  requireAdmin,
  requireUser,
} from './guard.js'
export { purgeExpiredSessions } from './service.js'
export type { CurrentUser } from './service.js'
export { getOidcConfig } from './oidc.js'
