import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  hasRequiredRoles,
  isReservedClientId,
  matchExactUri,
  normalizeScope,
  parseBasicAuth,
  parseRoleList,
  parseUriList,
  redirectUriError,
  verifyPkceS256,
  withState,
} from './validate.js'

const REGISTERED = ['https://app.example.co.kr/callback', 'http://localhost:4000/cb?x=1']

describe('matchExactUri', () => {
  it('등록된 값과 완전히 같을 때만 통과한다', () => {
    expect(matchExactUri(REGISTERED, 'https://app.example.co.kr/callback')).toBe(true)
    expect(matchExactUri(REGISTERED, 'http://localhost:4000/cb?x=1')).toBe(true)
  })

  it('trailing slash·쿼리 추가·스킴 변경은 모두 다른 URI다', () => {
    expect(matchExactUri(REGISTERED, 'https://app.example.co.kr/callback/')).toBe(false)
    expect(matchExactUri(REGISTERED, 'https://app.example.co.kr/callback?a=1')).toBe(false)
    expect(matchExactUri(REGISTERED, 'http://app.example.co.kr/callback')).toBe(false)
    expect(matchExactUri(REGISTERED, 'https://APP.example.co.kr/callback')).toBe(false)
    expect(matchExactUri(REGISTERED, 'https://app.example.co.kr')).toBe(false)
  })

  it('값이 없으면 통과하지 않는다', () => {
    expect(matchExactUri(REGISTERED, undefined)).toBe(false)
    expect(matchExactUri([], 'https://app.example.co.kr/callback')).toBe(false)
  })
})

describe('withState', () => {
  it('state가 없으면 등록된 URI를 그대로 돌려준다', () => {
    expect(withState('https://app.example.co.kr/', undefined)).toBe('https://app.example.co.kr/')
  })

  it('state를 쿼리로 붙인다', () => {
    expect(withState('https://app.example.co.kr/', 'st1')).toBe(
      'https://app.example.co.kr/?state=st1',
    )
  })

  it('등록값에 이미 있던 쿼리는 남기고 state만 덮는다', () => {
    expect(withState('https://app.example.co.kr/?a=1&state=old', 'new')).toBe(
      'https://app.example.co.kr/?a=1&state=new',
    )
  })
})

describe('hasRequiredRoles', () => {
  it('필요 역할이 없으면 로그인한 모두를 통과시킨다', () => {
    expect(hasRequiredRoles([], [])).toBe(true)
    expect(hasRequiredRoles([], ['portal-user'])).toBe(true)
  })

  it('하나라도 겹치면 통과한다', () => {
    expect(hasRequiredRoles(['hr-team'], ['portal-user', 'hr-team'])).toBe(true)
  })

  it('겹치는 역할이 없으면 거부한다', () => {
    expect(hasRequiredRoles(['hr-team'], ['portal-user'])).toBe(false)
    expect(hasRequiredRoles(['hr-team'], [])).toBe(false)
  })
})

describe('normalizeScope', () => {
  it('공백으로 나누고 중복을 없애 정렬한다', () => {
    expect(normalizeScope('openid profile  openid email')).toEqual(['email', 'openid', 'profile'])
  })

  it('값이 없으면 빈 배열이다', () => {
    expect(normalizeScope(undefined)).toEqual([])
    expect(normalizeScope('   ')).toEqual([])
  })
})

describe('parseBasicAuth', () => {
  const encode = (id: string, secret: string) =>
    'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64')

  it('정상 헤더를 분해한다', () => {
    expect(parseBasicAuth(encode('shop', 'p@ss'))).toEqual({
      clientId: 'shop',
      clientSecret: 'p@ss',
    })
  })

  it('scheme 대소문자를 가리지 않는다', () => {
    expect(parseBasicAuth(encode('shop', 'x').replace('Basic', 'basic'))?.clientId).toBe('shop')
  })

  it('RFC 6749 2.3.1 대로 퍼센트 디코딩한다', () => {
    expect(parseBasicAuth(encode('sh%20op', 'a%2Bb'))).toEqual({
      clientId: 'sh op',
      clientSecret: 'a+b',
    })
  })

  it('콜론이 없거나 값이 비었거나 base64가 아니면 null이다', () => {
    expect(parseBasicAuth(undefined)).toBeNull()
    expect(parseBasicAuth('Bearer abc')).toBeNull()
    expect(parseBasicAuth('Basic ' + Buffer.from('nocolon').toString('base64'))).toBeNull()
    expect(parseBasicAuth('Basic ' + Buffer.from('shop:').toString('base64'))).toBeNull()
    expect(parseBasicAuth('Basic @@@not-base64@@@')).toBeNull()
    expect(parseBasicAuth('Basic ' + Buffer.from('%ZZ:secret').toString('base64'))).toBeNull()
  })
})

describe('verifyPkceS256', () => {
  const verifier = 'a'.repeat(43)
  const challenge = createHash('sha256').update(verifier).digest('base64url')

  it('짝이 맞으면 통과한다', () => {
    expect(verifyPkceS256(challenge, verifier)).toBe(true)
  })

  it('verifier가 한 글자만 달라도 실패한다', () => {
    expect(verifyPkceS256(challenge, 'b' + 'a'.repeat(42))).toBe(false)
  })

  it('verifier가 없거나 길이 제한(43~128)을 벗어나면 실패한다', () => {
    expect(verifyPkceS256(challenge, undefined)).toBe(false)
    expect(verifyPkceS256(challenge, 'a'.repeat(42))).toBe(false)
    expect(verifyPkceS256(challenge, 'a'.repeat(129))).toBe(false)
  })

  it('허용되지 않은 문자가 있으면 실패한다', () => {
    expect(verifyPkceS256(challenge, 'a'.repeat(42) + '/')).toBe(false)
  })
})

describe('isReservedClientId', () => {
  it('포털·Keycloak과 겹치는 이름을 막는다', () => {
    expect(isReservedClientId('portal')).toBe(true)
    expect(isReservedClientId('realm-management')).toBe(true)
    expect(isReservedClientId('shop-admin')).toBe(false)
  })
})

describe('입력 목록 파싱', () => {
  it('줄바꿈으로 URI를 나누고 중복·공백을 정리한다', () => {
    expect(parseUriList(' https://a/cb \r\n\n https://a/cb \nhttps://b/cb')).toEqual([
      'https://a/cb',
      'https://b/cb',
    ])
    expect(parseUriList(undefined)).toEqual([])
  })

  it('쉼표로 역할을 나눈다', () => {
    expect(parseRoleList(' hr-team, portal-user ,hr-team ')).toEqual(['hr-team', 'portal-user'])
    expect(parseRoleList('')).toEqual([])
  })
})

describe('redirectUriError', () => {
  const portal = 'http://localhost:30400'

  it('https 주소와 loopback http는 통과한다', () => {
    expect(redirectUriError('https://app.example.co.kr/cb', portal)).toBeNull()
    expect(redirectUriError('http://localhost:4000/cb', portal)).toBeNull()
    expect(redirectUriError('http://127.0.0.1:4000/cb', portal)).toBeNull()
    expect(redirectUriError('http://[::1]:4000/cb', portal)).toBeNull()
  })

  it('loopback이 아닌 http는 거부한다', () => {
    expect(redirectUriError('http://app.example.co.kr/cb', portal)).toContain('https')
    expect(redirectUriError('http://10.0.0.5:3000/cb', portal)).toContain('https')
  })

  it('절대 URL이 아니거나 다른 스킴이면 사유를 돌려준다', () => {
    expect(redirectUriError('/cb', portal)).toContain('절대 URL')
    expect(redirectUriError('myapp://cb', portal)).toContain('http')
  })

  it('fragment가 있으면 거부한다', () => {
    expect(redirectUriError('https://app.example.co.kr/cb#x', portal)).toContain('fragment')
  })

  it('포털 자신의 오리진은 거부한다', () => {
    expect(redirectUriError('http://localhost:30400/api/auth/callback', portal)).toContain('포털')
  })
})
