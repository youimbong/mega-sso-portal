/**
 * apps(앱 카탈로그) 도메인 공개 API.
 * 다른 도메인은 이 파일을 통해서만 apps를 참조한다. 내부 파일 직접 import 금지.
 */
export { appsRoutes } from './router.js'
export { findVisibleApp, listVisibleApps } from './service.js'
export type { AppWithRoles } from './service.js'
