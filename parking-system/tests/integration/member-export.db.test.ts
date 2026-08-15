import { randomInt, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Wave 3 3d (#5B-a) — roster export DB behaviour against local Supabase:
//   · log_member_roster_export (0037): active-superadmin reauth FOR SHARE + audit success;
//     clerk / disabled → typed forbidden and NO audit row (denied paths aren't audited).
//   · listMembersForExportPage: keyset completeness over tied created_at, and the
//     created_at < createdBefore cutoff excluding rows inserted mid-export.
// Gated: `RUN_DB_TESTS=1` + reachable local Supabase (prereq: `npm run db:reset`).
try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may already be exported */
}
const RUN = process.env.RUN_DB_TESTS === '1'

type Sb = import('@supabase/supabase-js').SupabaseClient

const U = randomUUID().slice(0, 8)
const PASSWORD = 'Export-Test-Pw-1!'
const phoneFor = (() => {
  const base = 70000000 + randomInt(900000)
  let n = 0
  return () => `09${base + n++}`
})()

describe.skipIf(!RUN)('member roster export (#5B-a) — local DB integration', () => {
  let sb: Sb
  let repo: import('@/server/repositories/parkingRepository').ParkingRepository
  let createAdminAccount: typeof import('@/server/services/adminAuthService').createAdminAccount
  const createdAdmins: string[] = []
  const createdUsers: string[] = []

  const mkAdmin = async (suffix: string, role: 'superadmin' | 'clerk' = 'superadmin') => {
    await createAdminAccount({ username: `${U}-${suffix}`, password: PASSWORD }, repo)
    const acct = (await sb.from('admin_accounts').select('id').eq('username', `${U}-${suffix}`).single()).data as { id: string }
    if (role !== 'superadmin') await sb.from('admin_accounts').update({ role }).eq('id', acct.id).throwOnError()
    createdAdmins.push(acct.id)
    return acct.id
  }

  const mkUser = async (createdAt: string, name: string) => {
    const id = randomUUID()
    await sb.from('users').insert({ id, display_name: name, phone_number: phoneFor(), created_at: createdAt }).throwOnError()
    createdUsers.push(id)
    return id
  }

  const auditByRequest = async (requestId: string) =>
    (await sb.from('audit_logs').select('*').eq('request_id', requestId)).data as Array<Record<string, unknown>>

  beforeAll(async () => {
    sb = (await import('@/lib/supabase/server')).getServiceClient()
    repo = (await import('@/server/repositories/parkingRepository')).createParkingRepository(sb)
    ;({ createAdminAccount } = await import('@/server/services/adminAuthService'))
  })

  afterAll(async () => {
    for (const id of createdUsers) await sb.from('vehicles').delete().eq('user_id', id)
    for (const id of createdUsers) await sb.from('users').delete().eq('id', id)
    for (const id of createdAdmins) {
      await sb.from('admin_sessions').delete().eq('admin_id', id)
      await sb.from('admin_accounts').delete().eq('id', id)
    }
    // audit_logs is append-only — success rows written below cannot (and should not) be removed.
  })

  it('active superadmin → ok + one audit row (member_roster.export / member_roster / row_count / role snapshot)', async () => {
    const adminId = await mkAdmin('sa-ok')
    const requestId = randomUUID()
    const res = await repo.logMemberRosterExport({ actingAdminId: adminId, actingSessionId: randomUUID(), requestId, rowCount: 7 })
    expect(res.ok).toBe(true)
    const rows = await auditByRequest(requestId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      action: 'member_roster.export',
      entity_type: 'member_roster',
      entity_id: null,
      result: 'success',
      actor_type: 'admin',
      actor_id: adminId,
      actor_role_snapshot: 'superadmin',
      metadata_redacted: { row_count: 7 },
    })
  })

  it('clerk → forbidden_role and NO audit row', async () => {
    const adminId = await mkAdmin('clerk', 'clerk')
    const requestId = randomUUID()
    const res = await repo.logMemberRosterExport({ actingAdminId: adminId, actingSessionId: randomUUID(), requestId, rowCount: 3 })
    expect(res).toMatchObject({ ok: false, reason: 'forbidden_role' })
    expect(await auditByRequest(requestId)).toHaveLength(0)
  })

  it('disabled superadmin → acting_admin_disabled and NO audit row', async () => {
    const adminId = await mkAdmin('disabled')
    await sb.from('admin_accounts').update({ disabled_at: new Date().toISOString() }).eq('id', adminId).throwOnError()
    const requestId = randomUUID()
    const res = await repo.logMemberRosterExport({ actingAdminId: adminId, actingSessionId: randomUUID(), requestId, rowCount: 3 })
    expect(res).toMatchObject({ ok: false, reason: 'acting_admin_disabled' })
    expect(await auditByRequest(requestId)).toHaveLength(0)
  })

  it('keyset pages the roster completely with tied created_at — no dup, no skip', async () => {
    // Two users share a created_at (as a bulk import would); id breaks the tie.
    const tied = '2099-03-01T00:00:00.123456+00:00'
    const a = await mkUser(tied, `EXP-${U}-A`)
    const b = await mkUser(tied, `EXP-${U}-B`)
    const c = await mkUser('2099-03-02T00:00:00+00:00', `EXP-${U}-C`)
    const mine = new Set<string>([a, b, c])
    const createdBefore = '2099-06-01T00:00:00Z'

    const seen: string[] = []
    let afterCreatedAt: string | null = null
    let afterId: string | null = null
    for (;;) {
      const page = await repo.listMembersForExportPage({ createdBefore, afterCreatedAt, afterId, limit: 2 })
      const mineOnly = page.filter(r => mine.has(r.id))
      seen.push(...mineOnly.map(r => r.id))
      if (page.length < 2) break
      afterCreatedAt = page[page.length - 1].created_at
      afterId = page[page.length - 1].id
    }
    // All three, exactly once each (a tied pair + a later one) — the property offset paging can't promise.
    expect(seen.filter(id => mine.has(id)).sort()).toEqual([a, b, c].sort())
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('cutoff excludes a member created at/after createdBefore (a mid-export insert cannot appear)', async () => {
    const createdBefore = '2099-04-01T00:00:00Z'
    const before = await mkUser('2099-03-15T00:00:00+00:00', `EXPCUT-${U}-before`)
    const after = await mkUser('2099-05-01T00:00:00+00:00', `EXPCUT-${U}-after`) // simulates an insert during the export

    const seen: string[] = []
    let afterCreatedAt: string | null = null
    let afterId: string | null = null
    for (;;) {
      const page = await repo.listMembersForExportPage({ createdBefore, afterCreatedAt, afterId, limit: 100 })
      seen.push(...page.map(r => r.id))
      if (page.length < 100) break
      afterCreatedAt = page[page.length - 1].created_at
      afterId = page[page.length - 1].id
    }
    expect(seen).toContain(before)
    expect(seen).not.toContain(after)
  })

  it('active-plate lookup chunks past 100 ids — no plate dropped at the 100-boundary', async () => {
    const N = 101
    // created_at 2000 so ONLY these match the cutoff (seed is 2026, other tests are 2099);
    // all tied so they land in one keyset page (< limit 200) and the plate lookup gets all 101.
    const createdBefore = '2000-02-01T00:00:00Z'
    const users: Array<{ id: string; license_plate: string }> = []
    for (let i = 0; i < N; i++) {
      const id = randomUUID() as string
      createdUsers.push(id)
      users.push({ id, license_plate: `CHK${U}${String(i).padStart(3, '0')}` })
    }
    await sb.from('users').insert(
      users.map(u => ({ id: u.id, display_name: `CHK-${U}`, phone_number: phoneFor(), created_at: '2000-01-01T00:00:00+00:00' })),
    ).throwOnError()
    await sb.from('vehicles').insert(
      users.map(u => ({ user_id: u.id, license_plate: u.license_plate, is_active: true })), // license_plate_normalized is generated
    ).throwOnError()

    const page = await repo.listMembersForExportPage({ createdBefore, afterCreatedAt: null, afterId: null, limit: 200 })
    const idset = new Set<string>(users.map(u => u.id))
    const mine = page.filter(p => idset.has(p.id))
    expect(mine).toHaveLength(N) // all 101, before the 2026 seed
    expect(mine.every(p => p.plates.length === 1)).toBe(true) // each keeps its plate across the 100-chunk boundary
  })
})
