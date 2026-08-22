#!/usr/bin/env node
/**
 * Keycloak realm import 파일을 .env로부터 생성한다.
 *
 * Keycloak 26은 realm import JSON 안의 ${...} 를 치환해주지 않는다.
 * 확인된 동작: `${env.FOO}` 를 그대로 URI로 검증해서
 * "Invalid client portal: A redirect URI is not a valid URI" 로 기동에 실패한다.
 * 그래서 컨테이너에 넘기기 전에 여기서 치환한다.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

if (existsSync('.env')) process.loadEnvFile('.env')

const templatePath = fileURLToPath(
  new URL('../docker/keycloak/realm-mega.template.json', import.meta.url),
)
const outputPath = fileURLToPath(new URL('../docker/keycloak/realm-mega.json', import.meta.url))

const appBaseUrl = (process.env.APP_BASE_URL ?? 'http://localhost:30400').replace(/\/+$/, '')

let parsedUrl
try {
  parsedUrl = new URL(appBaseUrl)
} catch {
  console.error(`APP_BASE_URL이 올바른 URL이 아니다: ${appBaseUrl}`)
  process.exit(1)
}

/**
 * back-channel logout은 Keycloak 컨테이너가 포털로 직접 보내는 서버-서버 요청이라
 * 브라우저용 주소(localhost)로는 닿지 않는다.
 * 로컬 개발에서는 host.docker.internal, 포털도 컨테이너로 띄우면 서비스명을 쓴다.
 */
const port = parsedUrl.port || (parsedUrl.protocol === 'https:' ? '443' : '80')
const backchannelBaseUrl = (
  process.env.KEYCLOAK_BACKCHANNEL_BASE_URL ?? `http://host.docker.internal:${port}`
).replace(/\/+$/, '')

const vars = {
  APP_BASE_URL: appBaseUrl,
  BACKCHANNEL_BASE_URL: backchannelBaseUrl,
  OIDC_CLIENT_SECRET: process.env.OIDC_CLIENT_SECRET ?? 'portal-dev-secret-change-me',
}

const rendered = readFileSync(templatePath, 'utf8').replace(/\$\{(\w+)\}/g, (_match, key) => {
  const value = vars[key]
  if (value === undefined) {
    console.error(`템플릿의 \${${key}} 를 채울 값이 없다. scripts/render-realm.mjs를 확인하라.`)
    process.exit(1)
  }
  // JSON 문자열 안에 들어가므로 이스케이프가 필요한 문자를 처리한다.
  return JSON.stringify(value).slice(1, -1)
})

// 잘못 렌더링된 파일을 Keycloak에 넘기면 crash loop가 된다. 여기서 먼저 걸러낸다.
try {
  JSON.parse(rendered)
} catch (error) {
  console.error(`렌더링 결과가 올바른 JSON이 아니다: ${error.message}`)
  process.exit(1)
}

writeFileSync(outputPath, rendered)

console.log(`realm 생성 완료: docker/keycloak/realm-mega.json`)
console.log(`  redirect_uri        ${appBaseUrl}/api/auth/callback`)
console.log(`  backchannel logout  ${backchannelBaseUrl}/api/auth/backchannel-logout`)
