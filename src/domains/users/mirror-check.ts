import { z } from 'zod'

import type { Employee } from '../hr/index.js'

/**
 * 계정과 직원 미러를 대조하는 순수 함수 모음.
 *
 * A10이 단일 원천이지만 계정은 Keycloak이 소유하므로, 동기화가 계정을 자동으로 덮어쓰지
 * 않는다(hr/CLAUDE.md). 대신 어긋난 곳을 계산해 화면에 보여주고 관리자가 반영을 누른다.
 */

/** 계정 대조에 필요한 최소 표현. Keycloak 표현 전체를 끌고 다닐 이유가 없다. */
export type MirrorMismatch = {
  field: 'firstName' | 'email'
  /** 지금 계정에 들어 있는 값 */
  account: string | null
  /** 미러가 가진 값 */
  mirror: string
}

const emailSchema = z.email()

/**
 * 미러의 급여이메일을 계정 이메일로 쓸 수 있는지 가른다.
 *
 * A10에 이메일 형식이 아닌 값이 들어 있는 사원이 실제로 있다(예: `test`). 그대로 넘기면
 * Keycloak이 400 `error-invalid-email`로 거절해 계정 생성 자체가 막힌다. 형식이 아니면
 * 이메일 없이 만들고, 버린 값을 화면에 알리려고 `rejected`로 함께 돌려준다.
 */
export function pickMirrorEmail(payrollEmail: string | null | undefined): {
  email: string | null
  rejected: string | null
} {
  const value = (payrollEmail ?? '').trim()
  if (!value) return { email: null, rejected: null }
  if (!emailSchema.safeParse(value).success) return { email: null, rejected: value }
  return { email: value, rejected: null }
}

/**
 * 계정 값이 미러와 어긋난 곳.
 *
 * - 미러에 이메일이 없거나 형식이 아니면 이메일은 대조하지 않는다. 그 경우 계정에 이미
 *   들어 있는 이메일을 "틀렸다"고 볼 근거가 없다(실측상 101명 중 100명이 급여이메일 없음).
 * - 성명은 미러가 항상 값을 가지므로 그대로 대조한다.
 */
export function checkAgainstMirror(input: {
  account: { firstName?: string | null; email?: string | null }
  employee: Pick<Employee, 'koreanName' | 'payrollEmail'> | null
}): MirrorMismatch[] {
  const { employee } = input
  if (!employee) return []

  const mismatches: MirrorMismatch[] = []
  const firstName = input.account.firstName || null
  if (firstName !== employee.koreanName) {
    mismatches.push({ field: 'firstName', account: firstName, mirror: employee.koreanName })
  }

  const mirrorEmail = pickMirrorEmail(employee.payrollEmail).email
  const email = input.account.email || null
  if (mirrorEmail && email !== mirrorEmail) {
    mismatches.push({ field: 'email', account: email, mirror: mirrorEmail })
  }

  return mismatches
}
