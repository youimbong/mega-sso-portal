#!/usr/bin/env node
/**
 * 이미 떠 있는 Keycloak의 portal 클라이언트를 realm 템플릿 렌더 결과에 맞춘다.
 *
 * `--import-realm`은 realm이 이미 있으면 건너뛴다(docker/compose.yml 주석의 실측).
 * 그래서 APP_BASE_URL을 바꾸고 render-realm.mjs를 다시 돌려도 실행 중인 Keycloak에는
 * 아무것도 반영되지 않는다. realm을 지우고 다시 임포트하면 반영되지만 콘솔·포털에서
 * 만든 계정이 전부 사라지므로, 여기서는 Admin REST API로 해당 클라이언트만 PUT한다.
 *
 * 맞추는 대상은 배포 주소가 바뀔 때 같이 바뀌는 값뿐이다:
 *   redirectUris / webOrigins / attributes(post.logout.redirect.uris, backchannel.logout.*, pkce)
 * 사용자·역할·User Profile은 건드리지 않는다.
 *
 *   node scripts/sync-realm-client.mjs [--dry-run]
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

if (existsSync('.env')) process.loadEnvFile('.env')

const dryRun = process.argv.includes('--dry-run')

const realmPath = fileURLToPath(new URL('../docker/keycloak/realm-mega.json', import.meta.url))
if (!existsSync(realmPath)) {
  console.error('docker/keycloak/realm-mega.json 이 없다. 먼저 node scripts/render-realm.mjs 를 돌려라.')
  process.exit(1)
}
const realm = JSON.parse(readFileSync(realmPath, 'utf8'))
const desired = realm.clients?.find((c) => c.clientId === 'portal')
if (!desired) {
  console.error('realm 템플릿에 clientId=portal 클라이언트가 없다.')
  process.exit(1)
}

// 관리 API 주소는 OIDC_ISSUER(.../realms/<realm>)에서 뽑는다. 새 환경변수를 만들지 않는다.
const issuer = process.env.OIDC_ISSUER
if (!issuer) {
  console.error('OIDC_ISSUER 가 없다. .env를 확인하라.')
  process.exit(1)
}
const issuerUrl = new URL(issuer)
const realmName = issuerUrl.pathname.replace(/^\/realms\//, '').replace(/\/+$/, '')
const kcBase = issuerUrl.origin
const adminBase = `${kcBase}/admin/realms/${realmName}`

const adminUser = process.env.KEYCLOAK_ADMIN ?? 'admin'
const adminPassword = process.env.KEYCLOAK_ADMIN_PASSWORD ?? 'admin'

async function adminToken() {
  const res = await fetch(`${kcBase}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: 'admin-cli',
      grant_type: 'password',
      username: adminUser,
      password: adminPassword,
    }),
  })
  if (!res.ok) {
    // 본문에 자격증명이 실리지 않으므로 상태코드만 남긴다.
    console.error(`Keycloak 관리자 토큰을 받지 못했다: ${res.status}`)
    process.exit(1)
  }
  return (await res.json()).access_token
}

const token = await adminToken()
const auth = { authorization: `Bearer ${token}` }

const found = await fetch(`${adminBase}/clients?clientId=${encodeURIComponent(desired.clientId)}`, {
  headers: auth,
}).then((r) => r.json())
const current = found[0]
if (!current) {
  console.error(`realm '${realmName}' 에 clientId=${desired.clientId} 클라이언트가 없다. realm 임포트부터 확인하라.`)
  process.exit(1)
}

// 템플릿에 없는 attribute(Keycloak이 스스로 채운 realm_client 등)는 지우지 않고 위에 덮어쓴다.
const next = {
  ...current,
  redirectUris: desired.redirectUris,
  webOrigins: desired.webOrigins,
  attributes: { ...current.attributes, ...desired.attributes },
}

const changed = ['redirectUris', 'webOrigins', 'attributes'].filter(
  (k) => JSON.stringify(current[k]) !== JSON.stringify(next[k]),
)
if (changed.length === 0) {
  console.log(`${desired.clientId}: 이미 템플릿과 같다. 바꿀 것이 없다.`)
} else {
  console.log(`${desired.clientId}: ${changed.join(', ')} 를 맞춘다.`)
  for (const key of changed) {
    console.log(`  before ${key} ${JSON.stringify(current[key])}`)
    console.log(`  after  ${key} ${JSON.stringify(next[key])}`)
  }
  if (dryRun) {
    console.log('--dry-run 이므로 적용하지 않았다.')
  } else {
    const res = await fetch(`${adminBase}/clients/${current.id}`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify(next),
    })
    if (!res.ok) {
      console.error(`클라이언트 갱신 실패: ${res.status} ${await res.text()}`)
      process.exit(1)
    }
    console.log('적용 완료.')
  }
}

// protocol mapper는 여기서 고치지 않는다 — 토큰 claim 계약이라 조용히 바꿀 값이 아니다.
// 다만 임포트 건너뛰기 때문에 템플릿에만 있고 실물에 없는 mapper가 생길 수 있어 알려준다.
const liveMappers = new Set((current.protocolMappers ?? []).map((m) => m.name))
const missing = (desired.protocolMappers ?? []).map((m) => m.name).filter((n) => !liveMappers.has(n))
if (missing.length > 0) {
  console.warn(`경고: 템플릿에만 있는 protocol mapper 가 있다 — ${missing.join(', ')}. 관리 콘솔에서 직접 추가하라.`)
}
