import { createHmac } from 'node:crypto'

/**
 * A10 호출의 순수 계산부. a10.ts에서 떼어낸 이유는 테스트다 —
 * a10.ts는 shared/env.ts를 import하는 순간 환경변수 검증이 돌아가므로(.env 없으면 프로세스 종료)
 * 테스트에서 그대로 부를 수 없다. 이 저장소의 다른 도메인(visibility.ts, role-diff.ts)과 같은
 * "순수 함수만 떼어 테스트" 관례를 따른다.
 */

/**
 * wehago-sign HMAC. value = accessToken + transactionId + timestamp + urlPath
 * (구분자 없이 단순 연결, 순서 엄수) → sha256 → base64.
 * 연결 순서가 틀리면 인증이 통째로 깨지므로 EIS a10.auth.ts와 한 글자도 다르지 않게 둔다.
 */
export function wehagoSign(
  hashKey: string,
  accessToken: string,
  transactionId: string,
  timestamp: string,
  urlPath: string,
): string {
  const value = accessToken + transactionId + timestamp + urlPath
  return createHmac('sha256', hashKey).update(value, 'utf8').digest('base64')
}

/**
 * 페이지 인덱스 → 사원등록조회의 pagingStart/pagingEnd(시작~종료 인덱스).
 * offset/limit이 아니라 인덱스 쌍이라 계산을 틀리기 쉬워 떼어놓고 테스트한다.
 */
export function pagingRange(
  pageIndex: number,
  pageSize: number,
): { pagingStart: number; pagingEnd: number } {
  const pagingStart = pageIndex * pageSize
  return { pagingStart, pagingEnd: pagingStart + pageSize }
}
