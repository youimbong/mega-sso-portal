import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto'

/**
 * client secret 해시. 의존성을 늘리지 않고 KDF를 쓰려고 node:crypto scrypt를 쓴다.
 * sha256 단독은 오프라인 대입에 약하다.
 */
const N = 16384
const R = 8
const P = 1
const KEY_LEN = 32

/**
 * 동기 scryptSync를 쓰지 않는다 — 한 번에 20ms 넘게 걸리는 계산이라 이벤트 루프를 통째로 막는다.
 * 인증 없이 때릴 수 있는 /oidc/token 이 이 경로를 타므로, 초당 수십 요청만으로 포털 전체가 멈춘다.
 * 콜백형 scrypt는 libuv 스레드풀에서 돌아 루프를 막지 않는다.
 */
function derive(
  secret: string,
  salt: Buffer,
  keyLen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(secret, salt, keyLen, options, (err, key) => (err ? reject(err) : resolve(key)))
  })
}

export function generateClientSecret(): string {
  return randomBytes(32).toString('base64url')
}

/** 형식: `scrypt$N$r$p$salt$hash` (salt·hash는 base64url). */
export async function hashClientSecret(secret: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = await derive(secret, salt, KEY_LEN, { N, r: R, p: P })
  return ['scrypt', N, R, P, salt.toString('base64url'), hash.toString('base64url')].join('$')
}

/**
 * 형식이 깨진 stored는 예외 대신 false를 돌려준다 —
 * 등록 데이터가 손상돼도 로그인만 실패하고 500이 나지 않게 한다.
 */
export async function verifyClientSecret(secret: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false

  const n = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  // 손상된 행의 터무니없는 비용 값으로 프로세스가 멈추지 않게 상한을 둔다.
  if (!isCost(n, 2 ** 20) || !isCost(r, 32) || !isCost(p, 16)) return false

  const salt = Buffer.from(parts[4]!, 'base64url')
  const expected = Buffer.from(parts[5]!, 'base64url')
  if (salt.length === 0 || expected.length === 0) return false

  let actual: Buffer
  try {
    actual = await derive(secret, salt, expected.length, { N: n, r, p })
  } catch {
    return false
  }

  // 길이가 다르면 timingSafeEqual이 throw한다. 여기선 길이가 항상 같지만 방어로 둔다.
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}

function isCost(value: number, max: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= max
}
