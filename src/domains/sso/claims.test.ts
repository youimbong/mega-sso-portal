import { describe, expect, it } from 'vitest'

import { buildIdTokenClaims, buildUserinfoClaims, type PortalIdentity } from './claims.js'

const identity: PortalIdentity = {
  sub: 'kc-sub-1',
  email: 'a@megastudy.net',
  name: '홍길동',
  username: 'hong.gd',
  roles: ['portal-user'],
  employeeCode: '20250001',
}

const base = { identity, clientId: 'shop', sid: 'sid-1', scope: ['openid'], nonce: null }

describe('buildIdTokenClaims', () => {
  it('openid만 있으면 sub/aud/sid만 담는다', () => {
    expect(buildIdTokenClaims(base)).toEqual({
      sub: 'kc-sub-1',
      aud: 'shop',
      sid: 'sid-1',
    })
  })

  it('profile scope에서 name과 preferred_username을 담는다', () => {
    const claims = buildIdTokenClaims({ ...base, scope: ['openid', 'profile'] })
    expect(claims.name).toBe('홍길동')
    expect(claims.preferred_username).toBe('hong.gd')
  })

  it('preferred_username은 성명이 아니라 Keycloak username이다', () => {
    // 동명이인 두 계정이 같은 값을 내보내면 하위 앱이 둘을 한 사람으로 합친다.
    const claims = buildIdTokenClaims({
      ...base,
      identity: { ...identity, name: '김민수', username: 'kim.ms2' },
      scope: ['openid', 'profile'],
    })
    expect(claims.preferred_username).toBe('kim.ms2')
  })

  it('username이 없는 옛 세션에는 preferred_username 키를 넣지 않는다', () => {
    const claims = buildIdTokenClaims({
      ...base,
      identity: { ...identity, username: null },
      scope: ['openid', 'profile'],
    })
    expect(claims.name).toBe('홍길동')
    expect('preferred_username' in claims).toBe(false)
  })

  it('email scope가 없으면 email 관련 키 자체가 없다', () => {
    const claims = buildIdTokenClaims(base)
    expect('email' in claims).toBe(false)
    expect('email_verified' in claims).toBe(false)
  })

  it('email scope가 있어도 값이 없으면 키를 넣지 않는다', () => {
    // A10 직원 대부분이 이메일이 없다. null을 실으면 하위 앱이 빈 값을 받는다.
    const claims = buildIdTokenClaims({
      ...base,
      identity: { ...identity, email: null },
      scope: ['openid', 'email'],
    })
    expect('email' in claims).toBe(false)
  })

  it('email scope와 값이 모두 있으면 email_verified는 false로 나간다', () => {
    const claims = buildIdTokenClaims({ ...base, scope: ['openid', 'email'] })
    expect(claims.email).toBe('a@megastudy.net')
    expect(claims.email_verified).toBe(false)
  })

  it('nonce가 null이면 키 자체가 없고, 있으면 그대로 실린다', () => {
    expect('nonce' in buildIdTokenClaims(base)).toBe(false)
    expect(buildIdTokenClaims({ ...base, nonce: 'n-1' }).nonce).toBe('n-1')
  })

  it('employee_code는 profile scope를 요청했을 때만 실린다', () => {
    expect('employee_code' in buildIdTokenClaims(base)).toBe(false)
    expect(buildIdTokenClaims({ ...base, scope: ['openid', 'profile'] }).employee_code).toBe(
      '20250001',
    )
  })

  it('사번이 없으면 profile scope라도 employee_code 키가 없다', () => {
    const claims = buildIdTokenClaims({
      ...base,
      identity: { ...identity, employeeCode: null },
      scope: ['openid', 'profile'],
    })
    expect('employee_code' in claims).toBe(false)
  })

  it('roles는 roles scope를 요청했을 때만 실리고, 그때는 항상 배열이다', () => {
    expect('roles' in buildIdTokenClaims(base)).toBe(false)
    expect(buildIdTokenClaims({ ...base, scope: ['openid', 'roles'] }).roles).toEqual([
      'portal-user',
    ])
    expect(
      buildIdTokenClaims({
        ...base,
        identity: { ...identity, roles: [] },
        scope: ['openid', 'roles'],
      }).roles,
    ).toEqual([])
  })
})

describe('buildUserinfoClaims', () => {
  it('sub는 항상 있고 aud/sid/nonce는 담지 않는다', () => {
    const claims = buildUserinfoClaims(identity, ['openid', 'profile', 'email', 'roles'])
    expect(claims.sub).toBe('kc-sub-1')
    expect('aud' in claims).toBe(false)
    expect('sid' in claims).toBe(false)
    expect(claims.name).toBe('홍길동')
    expect(claims.preferred_username).toBe('hong.gd')
    expect(claims.email).toBe('a@megastudy.net')
    expect(claims.roles).toEqual(['portal-user'])
  })

  it('scope가 openid뿐이면 sub 말고는 아무것도 주지 않는다', () => {
    expect(buildUserinfoClaims(identity, ['openid'])).toEqual({ sub: 'kc-sub-1' })
  })
})
