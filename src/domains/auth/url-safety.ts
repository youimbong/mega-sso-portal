/**
 * 로그인 후 돌아갈 경로를 정규화한다.
 * 자기 사이트의 절대경로만 허용해 외부 도메인으로의 open redirect를 막는다.
 * `//evil.com` 은 브라우저가 protocol-relative URL로 해석하므로 반드시 걸러야 한다.
 */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string') return '/'
  if (!value.startsWith('/')) return '/'
  if (value.startsWith('//')) return '/'
  // `/\evil.com` 을 일부 브라우저가 `//evil.com` 처럼 다룬다.
  if (value.startsWith('/\\')) return '/'
  return value
}
