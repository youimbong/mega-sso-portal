import { asc, eq } from 'drizzle-orm'

import { db } from './db/index.js'
import { appRoles, apps, type App } from './db/schema.js'
import { canSee } from './visibility.js'

export type AppWithRoles = App & { roles: string[] }

/** 카탈로그는 수십 건 규모다. 조인 대신 두 번 읽고 메모리에서 합친다. */
export async function listAllApps(): Promise<AppWithRoles[]> {
  const [rows, roleRows] = await Promise.all([
    db.select().from(apps).orderBy(asc(apps.sortOrder), asc(apps.name)),
    db.select().from(appRoles),
  ])

  const byApp = new Map<string, string[]>()
  for (const r of roleRows) {
    const list = byApp.get(r.appId)
    if (list) list.push(r.role)
    else byApp.set(r.appId, [r.role])
  }

  return rows.map((app) => ({ ...app, roles: (byApp.get(app.id) ?? []).sort() }))
}

/**
 * 포털 홈에 보여줄 앱.
 * 앱에 지정된 역할이 없으면 로그인한 모두에게, 있으면 그 중 하나라도 가진 사람에게만 보인다.
 */
export async function listVisibleApps(userRoles: string[]): Promise<AppWithRoles[]> {
  const all = await listAllApps()
  return all.filter((app) => app.enabled && canSee(app.roles, userRoles))
}

export async function findVisibleApp(
  slug: string,
  userRoles: string[],
): Promise<AppWithRoles | null> {
  const [row] = await db.select().from(apps).where(eq(apps.slug, slug)).limit(1)
  if (!row || !row.enabled) return null

  const roles = (await db.select().from(appRoles).where(eq(appRoles.appId, row.id))).map(
    (r) => r.role,
  )
  const app: AppWithRoles = { ...row, roles }

  return canSee(app.roles, userRoles) ? app : null
}

export async function createApp(input: {
  slug: string
  name: string
  description: string | null
  targetUrl: string
  mode: 'link' | 'iframe'
  sortOrder: number
  roles: string[]
}): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(apps)
      .values({
        slug: input.slug,
        name: input.name,
        description: input.description,
        targetUrl: input.targetUrl,
        mode: input.mode,
        sortOrder: input.sortOrder,
      })
      .returning({ id: apps.id })

    if (row && input.roles.length > 0) {
      await tx.insert(appRoles).values(input.roles.map((role) => ({ appId: row.id, role })))
    }
  })
}

export async function deleteApp(id: string): Promise<void> {
  await db.delete(apps).where(eq(apps.id, id))
}

export async function toggleApp(id: string): Promise<void> {
  const [row] = await db.select({ enabled: apps.enabled }).from(apps).where(eq(apps.id, id)).limit(1)
  if (!row) return

  await db
    .update(apps)
    .set({ enabled: !row.enabled, updatedAt: new Date() })
    .where(eq(apps.id, id))
}
