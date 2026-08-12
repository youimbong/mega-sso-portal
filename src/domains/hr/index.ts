/**
 * hr(직원 미러) 도메인 공개 API.
 * 다른 도메인은 이 파일을 통해서만 hr을 참조한다. 내부 파일 직접 import 금지.
 */
export { hrRoutes } from './router.js'
export {
  getEmployeeByCode,
  getLastSyncedAt,
  isRetired,
  searchEmployees,
  syncEmployees,
} from './service.js'
export type { Employee, SyncResult } from './service.js'
