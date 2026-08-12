import { randomUUID } from 'node:crypto'

import { env } from '../../shared/env.js'
import { pagingRange, wehagoSign } from './a10-sign.js'

/**
 * A10 사원등록조회(api16S05) 호출부. hr 도메인 안에서만 쓴다 — index.ts로 내보내지 않는다.
 *
 * EIS의 domain/a10(인증 헤더 6종, envelope 언랩, 페이지 순회)을 포털이 실제로 쓰는 만큼만
 * 옮겨왔다. 포털은 이 endpoint 하나만 읽기로 호출하므로 endpoint 카탈로그·재시도 큐·
 * 호출 게이트는 만들지 않는다.
 */

/** 호출 타임아웃. 포털에서 조정할 이유가 없어 env가 아니라 상수로 둔다(EIS도 yaml 상수 10초). */
const A10_TIMEOUT_MS = 10_000

/** 한 페이지 조회 건수. EIS의 사원 동기화와 같은 값을 쓴다. */
const PAGE_SIZE = 1_000

/**
 * 무한루프 방지 겸 pagingEnd 상한. EIS의 A10 계약(a10.api-contract.ts:136)이 pagingEnd를
 * 10,000으로 제한하므로 1,000건 × 10페이지를 넘기지 않는다. 사원이 이보다 많아지면
 * A10 쪽 상한을 먼저 확인해야 한다 — 그냥 늘리면 그 페이지 호출이 거부된다.
 */
const MAX_PAGES = 10

const ENDPOINT_CODE = 'api16S05'
const ENDPOINT_PATH = `/apiproxy/${ENDPOINT_CODE}`

/** A10 사원등록조회(api16S05) 응답 레코드 중 포털이 실제로 읽는 필드만. */
export type A10EmployeeRecord = {
  coCd?: string
  divCd?: string
  divNm?: string
  deptCd?: string
  deptNm?: string
  empCd?: string
  korNm?: string
  htypNm?: string
  enrlFg?: string
  rtrDt?: string
  emalAdd?: string // extraColumns:['emalAdd'] 를 요청해야 온다
}

type A10Credentials = {
  baseUrl: string
  accessToken: string
  hashKey: string
  callerName: string
  groupSeq: string
  coCd: string
  divCd?: string
}

/**
 * A10_* 환경변수를 모아 확인한다. env 스키마에서 전부 optional이므로(자격증명 없이도 포털은
 * 뜬다) 실제로 호출하는 이 지점에서 fail-fast 한다.
 */
function requireCredentials(): A10Credentials {
  const missing: string[] = []
  if (!env.A10_API_BASE_URL) missing.push('A10_API_BASE_URL')
  if (!env.A10_ACCESS_TOKEN) missing.push('A10_ACCESS_TOKEN')
  if (!env.A10_HASH_KEY) missing.push('A10_HASH_KEY')
  if (!env.A10_CALLER_NAME) missing.push('A10_CALLER_NAME')
  if (!env.A10_GROUP_SEQ) missing.push('A10_GROUP_SEQ')
  if (!env.A10_CO_CD) missing.push('A10_CO_CD')

  if (missing.length > 0) {
    throw new Error(`A10 자격증명이 없다: ${missing.join(', ')}`)
  }

  return {
    baseUrl: env.A10_API_BASE_URL!,
    accessToken: env.A10_ACCESS_TOKEN!,
    hashKey: env.A10_HASH_KEY!,
    callerName: env.A10_CALLER_NAME!,
    groupSeq: env.A10_GROUP_SEQ!,
    coCd: env.A10_CO_CD!,
    divCd: env.A10_DIV_CD,
  }
}

/** 요청 1건의 인증 헤더 6종. transaction-id·timestamp는 요청마다 새로 만든다. */
function buildAuthHeaders(credentials: A10Credentials): Record<string, string> {
  const transactionId = randomUUID().replace(/-/g, '')
  const timestamp = String(Math.floor(Date.now() / 1000))
  return {
    callerName: credentials.callerName,
    Authorization: `Bearer ${credentials.accessToken}`,
    'transaction-id': transactionId,
    timestamp,
    groupSeq: credentials.groupSeq,
    'wehago-sign': wehagoSign(
      credentials.hashKey,
      credentials.accessToken,
      transactionId,
      timestamp,
      ENDPOINT_PATH,
    ),
  }
}

/** 한 페이지 POST → envelope 언랩 → 레코드 배열. */
async function fetchPage(
  credentials: A10Credentials,
  paging: { pagingStart: number; pagingEnd: number },
): Promise<A10EmployeeRecord[]> {
  const url = `${credentials.baseUrl.replace(/\/+$/, '')}${ENDPOINT_PATH}`
  const payload = {
    header: { groupSeq: credentials.groupSeq, tId: '', pId: '' },
    body: {
      coCd: credentials.coCd,
      // 사업장코드를 비워두면 전 사업장을 받는다. 빈 문자열을 보내면 A10이 조건으로 해석한다.
      ...(credentials.divCd ? { divCd: credentials.divCd } : {}),
      // 재직구분(enrlFg) 필터를 걸지 않는다 — 퇴직자도 미러에 남겨 상태를 그대로 비춘다.
      extraColumns: ['emalAdd'],
      ...paging,
    },
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...buildAuthHeaders(credentials) },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(A10_TIMEOUT_MS),
  })

  const bodyText = await response.text()
  if (!response.ok) {
    throw new Error(`A10 사원등록조회 HTTP ${response.status}`)
  }

  let parsed: { resultCode?: unknown; resultMsg?: unknown; resultData?: unknown }
  try {
    parsed = JSON.parse(bodyText) as typeof parsed
  } catch {
    throw new Error('A10 응답을 JSON으로 읽지 못했다')
  }

  // EIS와 같게 숫자 0을 성공으로 본다. 다른 값이면 resultCode를 그대로 메시지에 실어
  // 첫 실호출에서 실제 타입(0 인지 "0" 인지)이 드러나게 한다.
  if (parsed.resultCode !== 0) {
    const message = typeof parsed.resultMsg === 'string' ? parsed.resultMsg : '(메시지 없음)'
    throw new Error(`A10 사원등록조회 실패 (resultCode=${String(parsed.resultCode)}): ${message}`)
  }

  // 배열이 아닌 것을 빈 배열로 삼키면 "A10에서 0건을 받아 0건을 반영했다"가 성공 문구로 뜬다.
  // 봉투 모양이 예상과 다르면 조용히 성공한 척하지 말고 실제 타입을 실어 실패시킨다.
  if (!Array.isArray(parsed.resultData)) {
    throw new Error(`A10 사원등록조회 응답의 resultData가 배열이 아니다 (${typeof parsed.resultData})`)
  }
  return parsed.resultData as A10EmployeeRecord[]
}

/** 페이징을 끝까지 돌며 전건을 모은다. pagingStart/pagingEnd(시작~종료 인덱스)에 주의. */
export async function fetchAllEmployees(): Promise<A10EmployeeRecord[]> {
  const credentials = requireCredentials()
  const all: A10EmployeeRecord[] = []

  for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
    const rows = await fetchPage(credentials, pagingRange(pageIndex, PAGE_SIZE))
    all.push(...rows)
    // 한 페이지를 다 못 채웠으면 마지막 페이지다(0건 포함).
    if (rows.length < PAGE_SIZE) return all
  }

  return all
}
