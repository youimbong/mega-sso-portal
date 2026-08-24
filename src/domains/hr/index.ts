/**
 * hr(직원 미러) 도메인 공개 API.
 * 다른 도메인은 이 파일을 통해서만 hr을 참조한다. 내부 파일 직접 import 금지.
 */
export { hrRoutes } from './router.js'
export {
  getEmployeeByCode,
  getEmployeesByCodes,
  getLastSyncedAt,
  isRetired,
  missingA10Config,
  searchEmployees,
  syncEmployees,
} from './service.js'
export { isSearchableTerm } from './search-terms.js'
export type { Employee, SyncResult } from './service.js'
