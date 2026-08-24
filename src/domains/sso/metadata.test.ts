import { describe, expect, it } from 'vitest'

import { discoveryDocument, issuerOf, normalizeBaseUrl } from './metadata.js'

describe('discoveryDocument', () => {
  const doc = discoveryDocument('http://localhost:30400')

  it('issuer는 포털 주소 + /oidc 다', () => {
    expect(doc.issuer).toBe('http://localhost:30400/oidc')
  })

  it('APP_BASE_URL 끝의 슬래시를 떼어내 issuer가 두 겹이 되지 않게 한다', () => {
    expect(normalizeBaseUrl('http://localhost:30400/')).toBe('http://localhost:30400')
    expect(issuerOf('http://localhost:30400//')).toBe('http://localhost:30400/oidc')
  })

  it('모든 endpoint가 issuer로 시작하고 끝에 슬래시가 없다', () => {
    const endpoints = Object.entries(doc)
      .filter(([key]) => key.endsWith('_endpoint') || key === 'jwks_uri')
      .map(([, value]) => value as string)

    expect(endpoints.length).toBe(5)
    for (const url of endpoints) {
      expect(url.startsWith('http://localhost:30400/oidc/')).toBe(true)
      expect(url.endsWith('/')).toBe(false)
      // issuer 경로가 두 번 들어가는 조립 실수를 잡는다.
      expect(url.split('/oidc').length - 1).toBe(1)
    }
  })

  it('지원하지 않는 흐름을 광고하지 않는다', () => {
    expect(doc.grant_types_supported).toEqual(['authorization_code'])
    expect(doc.code_challenge_methods_supported).toEqual(['S256'])
    expect(doc.frontchannel_logout_supported).toBe(false)
  })
})
