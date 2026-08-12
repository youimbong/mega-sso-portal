import { createHmac } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { pagingRange, wehagoSign } from './a10-sign.js'

describe('wehagoSign', () => {
  it('accessToken + transactionId + timestamp + urlPath 순서로 이어붙인다', () => {
    // 연결 순서가 어긋나면 A10 인증이 통째로 깨진다. 순서를 값으로 못박는다.
    const expected = createHmac('sha256', 'k')
      .update('a' + 't' + 'ts' + '/apiproxy/api16S05')
      .digest('base64')

    expect(wehagoSign('k', 'a', 't', 'ts', '/apiproxy/api16S05')).toBe(expected)
  })

  it('입력 하나만 달라져도 값이 달라진다', () => {
    const base = wehagoSign('k', 'a', 't', 'ts', '/apiproxy/api16S05')
    expect(wehagoSign('k2', 'a', 't', 'ts', '/apiproxy/api16S05')).not.toBe(base)
    expect(wehagoSign('k', 'a', 't', 'ts2', '/apiproxy/api16S05')).not.toBe(base)
    // 순서를 바꾼 조합(accessToken과 transactionId를 맞바꿈)도 같은 값이 나오면 안 된다.
    expect(wehagoSign('k', 't', 'a', 'ts', '/apiproxy/api16S05')).not.toBe(base)
  })
})

describe('pagingRange', () => {
  it('첫 페이지는 0부터 pageSize까지다', () => {
    expect(pagingRange(0, 1000)).toEqual({ pagingStart: 0, pagingEnd: 1000 })
  })

  it('다음 페이지는 앞 페이지의 끝에서 이어진다', () => {
    expect(pagingRange(1, 1000)).toEqual({ pagingStart: 1000, pagingEnd: 2000 })
    expect(pagingRange(2, 1000)).toEqual({ pagingStart: 2000, pagingEnd: 3000 })
  })
})
