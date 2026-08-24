import { describe, expect, it } from 'vitest'

import { generateClientSecret, hashClientSecret, verifyClientSecret } from './secret.js'

describe('client secret 해시', () => {
  it('같은 secret이라도 salt가 달라 해시 문자열이 매번 다르다', async () => {
    const a = await hashClientSecret('s3cret')
    const b = await hashClientSecret('s3cret')
    expect(a).not.toBe(b)
    expect(a.startsWith('scrypt$16384$8$1$')).toBe(true)
  })

  it('원래 secret은 검증을 통과한다', async () => {
    const secret = generateClientSecret()
    expect(await verifyClientSecret(secret, await hashClientSecret(secret))).toBe(true)
  })

  it('한 글자만 달라도 통과하지 않는다', async () => {
    const stored = await hashClientSecret('s3cret')
    expect(await verifyClientSecret('s3cres', stored)).toBe(false)
    expect(await verifyClientSecret('', stored)).toBe(false)
  })

  it('형식이 깨진 저장값은 예외 없이 false다', async () => {
    expect(await verifyClientSecret('s3cret', '')).toBe(false)
    expect(await verifyClientSecret('s3cret', 'plaintext')).toBe(false)
    expect(await verifyClientSecret('s3cret', 'scrypt$16384$8$1$onlyfive')).toBe(false)
    expect(await verifyClientSecret('s3cret', 'bcrypt$16384$8$1$aaaa$bbbb')).toBe(false)
    expect(await verifyClientSecret('s3cret', 'scrypt$0$8$1$aaaa$bbbb')).toBe(false)
    expect(await verifyClientSecret('s3cret', 'scrypt$99999999$8$1$aaaa$bbbb')).toBe(false)
  })

  it('해시 길이가 달라도 timingSafeEqual이 throw하지 않는다', async () => {
    // parts[5]가 짧으면 그 길이로 다시 파생하므로 길이는 맞지만 값이 다르다.
    expect(await verifyClientSecret('s3cret', 'scrypt$16384$8$1$c2FsdA$YWJj')).toBe(false)
  })

  it('generateClientSecret은 URL에 넣어도 안전한 문자만 쓴다', () => {
    expect(generateClientSecret()).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('검증 중에도 이벤트 루프가 돌아간다(동기 scrypt면 타이머가 밀린다)', async () => {
    // 인증 없이 때릴 수 있는 /oidc/token 이 이 경로를 타므로 루프를 막으면 포털 전체가 멈춘다.
    const stored = await hashClientSecret('s3cret')

    let ticks = 0
    const timer = setInterval(() => ticks++, 1)
    // 한 번에 20ms 넘게 걸리는 계산을 여러 번 겹쳐 돌린다.
    await Promise.all(Array.from({ length: 8 }, () => verifyClientSecret('nope', stored)))
    clearInterval(timer)

    expect(ticks).toBeGreaterThan(0)
  })
})
