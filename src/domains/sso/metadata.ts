/**
 * OP discovery 문서. 값은 전부 APP_BASE_URL 파생이다 —
 * request.hostname/protocol로 만들면 리버스 프록시 뒤에서 내부 주소가 새어 나간다
 * (auth 도메인이 이미 확립한 관례).
 */

/** 끝의 슬래시를 떼어낸 포털 주소. issuer 문자열 비교가 걸리는 지점이라 한 곳에서만 만든다. */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

/**
 * issuer. 하위 앱은 반드시 trailing slash 없이 `${포털}/oidc`를 discovery에 넘겨야 한다 —
 * openid-client가 응답의 issuer와 넘긴 URL의 href를 문자열로 비교한다.
 */
export function issuerOf(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/oidc`
}

export function discoveryDocument(baseUrl: string): Record<string, unknown> {
  const issuer = issuerOf(baseUrl)

  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    userinfo_endpoint: `${issuer}/userinfo`,
    jwks_uri: `${issuer}/jwks`,
    end_session_endpoint: `${issuer}/logout`,
    scopes_supported: ['openid', 'profile', 'email', 'roles'],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    // refresh_token·implicit은 지원하지 않는다. 하위 앱이 애초에 시도하지 않도록 명시한다.
    grant_types_supported: ['authorization_code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    code_challenge_methods_supported: ['S256'],
    claims_supported: [
      'sub',
      'iss',
      'aud',
      'exp',
      'iat',
      'sid',
      'nonce',
      'name',
      'preferred_username',
      'email',
      'email_verified',
      'roles',
      'employee_code',
    ],
    backchannel_logout_supported: true,
    backchannel_logout_session_supported: true,
    frontchannel_logout_supported: false,
    require_pkce: true,
  }
}
