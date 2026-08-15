import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Phase 8 Slice 8 — resolve_pastoral_alert: atomic status flip + audit fields + optional
// consecutive_no_show reset; the widened constraints (note length, resolution shape) and
// the admin list read. Gated: `RUN_DB_TESTS=1` + local Supabase (prereq: `npm run db:reset`).
try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may already be exported */
}
const RUN = process.env.RUN_DB_TESTS === '1'

type Sb = import('@supabase/supabase-js').SupabaseClient

const NOW = new Date('2099-07-06T02:00:00Z')
// Fresh Sunday, no collision with other integration files (01-xx/02-01/03-xx/04-01/05-03).
const SUNDAY = '2099-07-05'
const T = randomUUID().slice(0, 8)

describe.skipIf(!RUN)('pastoral alert resolution (Phase 8 Slice 8) — local DB integration', () => {
  let sb: Sb
  let repo: import('@/server/repositories/parkingRepository').ParkingRepository
  const eventId = randomUUID()
  const adminId = randomUUID()
  const createdUsers: string[] = []

  const mkUser = async (name: string): Promise<string> => {
    const id = randomUUID()
    await sb.from('users').insert({ id, display_name: name }).throwOnError()
    createdUsers.push(id)
    return id
  }
  const mkPenalties = async (userId: string, consecutive: number, score = 1) => {
    await sb.from('user_penalties')
      .insert({ user_id: userId, penalty_score: score, consecutive_no_show: consecutive })
      .throwOnError()
  }
  const mkAlert = async (userId: string, triggerCount = 4): Promise<string> => {
    const id = randomUUID()
    await sb.from('pastoral_care_alerts')
      .insert({ id, user_id: userId, weekly_event_id: eventId, reason: 'consecutive_no_show', trigger_count: triggerCount })
      .throwOnError()
    return id
  }
  const alertRow = async (id: string) =>
    (await sb.from('pastoral_care_alerts').select('*').eq('id', id).single()).data!
  const penaltiesRow = async (userId: string) =>
    (await sb.from('user_penalties').select('*').eq('user_id', userId).maybeSingle()).data
  const resolve = (alertId: string, over: { note?: string | null; resetCounter?: boolean } = {}) =>
    repo.resolvePastoralAlert({
      alertId, adminId, note: over.note ?? null, resetCounter: over.resetCounter ?? false, nowIso: NOW.toISOString(),
    })

  beforeAll(async () => {
    sb = (await import('@/lib/supabase/server')).getServiceClient()
    repo = (await import('@/server/repositories/parkingRepository')).createParkingRepository(sb)
    await sb.from('weekly_events')
      .insert({ id: eventId, sunday_date: SUNDAY, total_capacity: 23, blocked_spaces: 0, admin_reserved: 0 })
      .throwOnError()
    await sb.from('admin_accounts')
      .insert({ id: adminId, username: `pastoral-${T}`, password_hash: 'scrypt$00$00' })
      .throwOnError()
  })

  afterAll(async () => {
    if (!RUN) return
    for (const uid of createdUsers) {
      await sb.from('pastoral_care_alerts').delete().eq('user_id', uid)
      await sb.from('user_penalties').delete().eq('user_id', uid)
      await sb.from('users').delete().eq('id', uid)
    }
    await sb.from('weekly_events').delete().eq('id', eventId)
    await sb.from('admin_accounts').delete().eq('id', adminId)
  })

  it('resolve WITHOUT reset: audit fields written, counter untouched; re-resolve → already_resolved', async () => {
    const user = await mkUser(`測試甲-${T}`)
    await mkPenalties(user, 4, 2)
    const alert = await mkAlert(user)

    expect(await resolve(alert, { note: '  已由牧長聯繫  ' })).toEqual({ resolved: 1, reason: 'resolved', counter_reset: false })
    const row = await alertRow(alert)
    expect(row.status).toBe('resolved')
    expect(row.resolved_at).not.toBeNull()
    expect(row.resolved_by_admin_id).toBe(adminId)
    expect(row.note).toBe('已由牧長聯繫') // trimmed
    expect(row.counter_reset).toBe(false)
    const pen = await penaltiesRow(user)
    expect(pen!.consecutive_no_show).toBe(4)
    expect(pen!.penalty_score).toBe(2)

    // idempotence: second resolve is a typed no-op, audit fields unchanged
    expect(await resolve(alert, { note: '第二次' })).toEqual({ resolved: 0, reason: 'already_resolved' })
    expect((await alertRow(alert)).note).toBe('已由牧長聯繫')
  })

  it('resolve WITH reset: counter → 0 in the same transaction, penalty_score untouched', async () => {
    const user = await mkUser(`測試乙-${T}`)
    await mkPenalties(user, 5, 3)
    const alert = await mkAlert(user, 5)

    expect(await resolve(alert, { resetCounter: true })).toEqual({ resolved: 1, reason: 'resolved', counter_reset: true })
    expect((await alertRow(alert)).counter_reset).toBe(true)
    const pen = await penaltiesRow(user)
    expect(pen!.consecutive_no_show).toBe(0)
    expect(pen!.penalty_score).toBe(3)
  })

  it('no user_penalties row: reset is a no-op success, and the admin list still returns the alert', async () => {
    const user = await mkUser(`測試丙-${T}`)
    const alert = await mkAlert(user) // deliberately NO penalties row

    const listed = await repo.listPastoralAlerts('open', 200)
    const mine = listed.find(r => r.id === alert)
    expect(mine).toBeTruthy()
    expect(mine!.display_name).toBe(`測試丙-${T}`)
    expect(mine!.sunday_date).toBe(SUNDAY)

    expect(await resolve(alert, { resetCounter: true })).toEqual({ resolved: 1, reason: 'resolved', counter_reset: true })
    expect(await penaltiesRow(user)).toBeNull()
  })

  it('resolved list carries the resolving admin username (left join)', async () => {
    const user = await mkUser(`測試丁-${T}`)
    const alert = await mkAlert(user)
    await resolve(alert, { note: '已電話關心' })

    const resolved = await repo.listPastoralAlerts('resolved', 200)
    const mine = resolved.find(r => r.id === alert)
    expect(mine!.resolved_by_username).toBe(`pastoral-${T}`)
    expect(mine!.note).toBe('已電話關心')
  })

  it('two admins racing to resolve the same alert → exactly one wins', async () => {
    const user = await mkUser(`測試戊-${T}`)
    const alert = await mkAlert(user)

    const [a, b] = await Promise.all([resolve(alert), resolve(alert)])
    const outcomes = [a.reason, b.reason].sort()
    expect(outcomes).toEqual(['already_resolved', 'resolved'])
    expect(a.resolved + b.resolved).toBe(1)
  })

  it('resolve(reset) racing a settlement counter-increment: no lost update, penalty_score stable', async () => {
    const user = await mkUser(`測試己-${T}`)
    await mkPenalties(user, 4, 1)
    const alert = await mkAlert(user)

    // Simulate the settlement side as its own single-statement counter bump.
    const settleBump = sb.from('user_penalties')
      .update({ consecutive_no_show: 5 }).eq('user_id', user).then(r => { if (r.error) throw r.error })
    const [res] = await Promise.all([resolve(alert, { resetCounter: true }), settleBump])
    expect(res.reason).toBe('resolved')
    expect((await alertRow(alert)).status).toBe('resolved')
    const pen = await penaltiesRow(user)
    // Both writers are single UPDATE statements — the counter is one of the two written
    // values (ordering-dependent), never a torn/lost intermediate.
    expect([0, 5]).toContain(pen!.consecutive_no_show)
    expect(pen!.penalty_score).toBe(1)
  })

  it('after resolution the partial-unique slot frees up: the same user can get a NEW open alert', async () => {
    const user = await mkUser(`測試庚-${T}`)
    const first = await mkAlert(user)
    await resolve(first)
    const second = await mkAlert(user) // would violate pastoral_care_alerts_one_open if not freed
    expect((await alertRow(second)).status).toBe('open')
  })

  it('DB constraints: 201-char note rejected; half-resolved shapes rejected', async () => {
    const user = await mkUser(`測試辛-${T}`)
    const alert = await mkAlert(user)

    const longNote = await sb.from('pastoral_care_alerts').update({ note: '安'.repeat(201) }).eq('id', alert)
    expect(longNote.error?.message).toMatch(/note_len_ck/)

    // open row must carry no resolution data
    const openReset = await sb.from('pastoral_care_alerts').update({ counter_reset: true }).eq('id', alert)
    expect(openReset.error?.message).toMatch(/resolution_shape_ck/)
    // resolved row must have resolved_at
    const halfResolved = await sb.from('pastoral_care_alerts').update({ status: 'resolved' }).eq('id', alert)
    expect(halfResolved.error?.message).toMatch(/resolution_shape_ck/)
  })

  it('RPC guards: short note handled by trim rule; null parameters all raise', async () => {
    const user = await mkUser(`測試壬-${T}`)
    const alert = await mkAlert(user)

    const nullAlert = await sb.rpc('resolve_pastoral_alert', {
      p_alert_id: null, p_admin_id: adminId, p_note: null, p_reset_counter: false, p_now: NOW.toISOString(),
    })
    expect(nullAlert.error?.message).toMatch(/p_alert_id/)
    const nullAdmin = await sb.rpc('resolve_pastoral_alert', {
      p_alert_id: alert, p_admin_id: null, p_note: null, p_reset_counter: false, p_now: NOW.toISOString(),
    })
    expect(nullAdmin.error?.message).toMatch(/p_admin_id/)
    const nullReset = await sb.rpc('resolve_pastoral_alert', {
      p_alert_id: alert, p_admin_id: adminId, p_note: null, p_reset_counter: null, p_now: NOW.toISOString(),
    })
    expect(nullReset.error?.message).toMatch(/p_reset_counter/)
    const nullNow = await sb.rpc('resolve_pastoral_alert', {
      p_alert_id: alert, p_admin_id: adminId, p_note: null, p_reset_counter: false, p_now: null,
    })
    expect(nullNow.error?.message).toMatch(/p_now/)
    const longNote = await sb.rpc('resolve_pastoral_alert', {
      p_alert_id: alert, p_admin_id: adminId, p_note: '安'.repeat(201), p_reset_counter: false, p_now: NOW.toISOString(),
    })
    expect(longNote.error?.message).toMatch(/p_note/)

    // unknown alert id → typed not_found (not an exception)
    expect(await resolve(randomUUID())).toEqual({ resolved: 0, reason: 'not_found' })
  })
})
