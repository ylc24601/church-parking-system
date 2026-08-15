import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { computeCapacity } from '@/lib/allocation/allocate'

// Wave 2B-1 (#14A) — set_weekly_capacity (migration 0031) against the real DB, because
// every guarantee it makes is a DB guarantee: a row lock, a transactional guard, and an
// audit row that must commit with (or roll back with) the change it records.
// Gated: `RUN_DB_TESTS=1` + reachable local Supabase (prereq: `npm run db:reset`).
try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may already be exported */
}
const RUN = process.env.RUN_DB_TESTS === '1'

type Sb = import('@supabase/supabase-js').SupabaseClient

// ⚠️ This file OWNS Sunday 2099-08-23 — no other suite may use it.
// Events audited by set_weekly_capacity can never be deleted (audit_logs.weekly_event_id
// FKs weekly_events and audit rows are append-only), so teardown can only FINALIZE them.
// The row outlives the run, and any suite that INSERTs the same sunday_date afterwards
// dies on weekly_events_sunday_date_key. This file originally claimed to "own" 2099-08-02
// while move-car.db.test.ts already had it — the claim was written, not checked, and the
// collision only surfaced when file order put move-car second.
const SUNDAY = '2099-08-23'
// A REAL admin_accounts row, not a made-up uuid: since 0035 the audit writer resolves
// the actor's role in-transaction and RAISES for an admin id it cannot find, so a
// fictional actor now takes the whole capacity write down with it (which is the point —
// an audit row claiming an admin acted, where no such admin exists, is not a record).
let ADMIN = ''
const SESSION = '22222222-2222-4222-8222-222222222222'

describe.skipIf(!RUN)('weekly capacity admin (#14A) — local DB integration', () => {
  let sb: Sb
  let repo: import('@/server/repositories/parkingRepository').ParkingRepository
  let eventId: string

  const event = async () =>
    (await sb.from('weekly_events').select('*').eq('id', eventId).single()).data!
  const auditFor = async (requestId: string) =>
    (await sb.from('audit_logs').select('*').eq('request_id', requestId)).data!

  const setCapacity = (args: {
    total: number; blocked: number; version: number; sunday?: string; requestId?: string
  }) =>
    repo.setWeeklyCapacity({
      eventId,
      sunday: args.sunday ?? SUNDAY,
      totalCapacity: args.total,
      blockedSpaces: args.blocked,
      expectedVersion: args.version,
      actingAdminId: ADMIN,
      actingSessionId: SESSION,
      requestId: args.requestId ?? randomUUID(),
    })

  const resetEvent = async () => {
    await sb.from('reservations').delete().eq('weekly_event_id', eventId)
    await sb.from('job_runs').delete().eq('weekly_event_id', eventId)
    await sb.from('weekly_events')
      .update({ total_capacity: 23, blocked_spaces: 3, status: 'open' })
      .eq('id', eventId)
  }

  beforeAll(async () => {
    sb = (await import('@/lib/supabase/server')).getServiceClient()
    repo = (await import('@/server/repositories/parkingRepository')).createParkingRepository(sb)

    const { data: admin } = await sb.from('admin_accounts')
      .insert({
        username: `cap-admin-${randomUUID().slice(0, 8)}`,
        password_hash: 'scrypt$notarealhash',
      })
      .select('id')
      .single()
    ADMIN = (admin as { id: string }).id

    // Reuse this file's Sunday if it already exists rather than insert-or-die.
    //
    // Once this suite runs, its event is PERMANENT: audit_logs.weekly_event_id carries a
    // real FK (0030), and audit rows are append-only — the app cannot delete them — so an
    // audited weekly_events row can never be deleted again. That is consistent with
    // 0030's stated assumption ("weekly_events is never deleted; no delete path exists"),
    // but it means a delete-then-insert fixture would poison every later run against the
    // unique sunday_date.
    const existing = (await sb.from('weekly_events').select('id').eq('sunday_date', SUNDAY).maybeSingle()).data
    if (existing) {
      eventId = existing.id as string
    } else {
      const { data, error } = await sb.from('weekly_events')
        .insert({ sunday_date: SUNDAY, total_capacity: 23, blocked_spaces: 3, admin_reserved: 0 })
        .select('id').single()
      if (error) throw new Error(`capacity fixture setup failed: ${error.message}`)
      eventId = data!.id as string
    }
    await resetEvent()
  })

  afterAll(async () => {
    if (!RUN) return
    // The event row itself CANNOT be deleted: its audit rows reference it (0030's FK) and
    // are append-only. So it is finalized instead — getActiveEvent is "latest
    // non-finalized by sunday_date DESC", and a lingering OPEN event dated 2099 would
    // silently become the active event for every suite that runs after this one. The row
    // and its audit rows both vanish on the next db:reset.
    await sb.from('reservations').delete().eq('weekly_event_id', eventId)
    await sb.from('job_runs').delete().eq('weekly_event_id', eventId)
    await sb.from('weekly_staff_allocations').delete().eq('weekly_event_id', eventId)
    await sb.from('weekly_events').update({ status: 'finalized' }).eq('id', eventId)
    // audit_logs has no FK to admin_accounts by design, so the actor row can go even
    // though the rows it wrote cannot.
    if (ADMIN) await sb.from('admin_accounts').delete().eq('id', ADMIN)
  })

  // ── the two formulas must agree ──────────────────────────────────────────────

  // 0004:5-7 decided the arithmetic lives in the pure computeCapacity and the view
  // supplies inputs only. #14A's guard has to run INSIDE the transaction, so it cannot
  // call TypeScript — the formula now exists twice, deliberately. THIS TEST IS THE
  // ENTIRE MITIGATION: one fixture table drives both, so neither side can drift, and
  // neither can quietly miss a case the other covers.
  // Every fixture is driven through the REAL RPC (whose effective_capacity is the SQL
  // formula's own output) and through computeCapacity, and the two must match. staff
  // counts are capped at 2 because they must be physical weekly_staff_allocations rows
  // — a number invented in JS would make this compare JS to JS and prove nothing.
  const FIXTURES: Array<{ name: string; total: number; blocked: number; staff: number }> = [
    { name: 'all zero', total: 0, blocked: 0, staff: 0 },
    { name: 'blocked only', total: 23, blocked: 5, staff: 0 },
    { name: 'staff only', total: 23, blocked: 0, staff: 2 },
    { name: 'deductions exactly equal total (effective 0)', total: 10, blocked: 8, staff: 2 },
    { name: 'large numbers', total: 900, blocked: 123, staff: 2 },
    { name: 'minimum viable', total: 1, blocked: 0, staff: 0 },
  ]

  const setStaff = async (n: number) => {
    await sb.from('weekly_staff_allocations').delete().eq('weekly_event_id', eventId)
    if (n === 0) return
    const users = (await sb.from('users').select('id').limit(n)).data!
    await sb.from('weekly_staff_allocations')
      .insert(users.map(u => ({ weekly_event_id: eventId, user_id: u.id, status: 'reserved' })))
      .throwOnError()
  }

  it.each(FIXTURES)('formula parity: the RPC and computeCapacity agree — $name', async f => {
    await resetEvent()
    await setStaff(f.staff)
    // Land on the fixture's shape first (the RPC refuses a no-op, and we need a known
    // version), then ask the RPC to recompute it.
    await sb.from('weekly_events')
      .update({ total_capacity: f.total, blocked_spaces: 0 }).eq('id', eventId)
    const v = (await event()).capacity_version as number

    const res = await setCapacity({ total: f.total, blocked: f.blocked, version: v })
    expect(res.ok).toBe(true)

    // admin_reserved is always 0 post-0031 (CHECK-pinned), so the DB can no longer
    // produce a row with a live admin_reserved term — parity for that term is asserted
    // against the pure function alone, just below.
    const fromTs = computeCapacity(
      { total_capacity: f.total, blocked_spaces: f.blocked, admin_reserved: 0 },
      f.staff,
    )
    expect(res.effective_capacity).toBe(fromTs)
    await setStaff(0)
  })

  it('computeCapacity still honours the admin_reserved term the DB can no longer hold', async () => {
    // 0031 pins admin_reserved to 0, but the term stays in the pure formula (retiring it
    // touches 0004's view, the signature and three test files — its own slice). Until
    // then it must keep working, or the fold's arithmetic-preservation claim is unprovable.
    expect(computeCapacity({ total_capacity: 23, blocked_spaces: 1, admin_reserved: 2 }, 2)).toBe(18)
    // …and the fold's whole premise: moving admin_reserved into blocked changes nothing.
    expect(computeCapacity({ total_capacity: 23, blocked_spaces: 3, admin_reserved: 0 }, 2)).toBe(18)
  })

  it('computeCapacity throws where the RPC refuses — both reject a negative result', async () => {
    // The pure function's contract on negative input (allocate.ts:37) and the RPC's
    // negative_capacity guard must describe the same boundary.
    expect(() =>
      computeCapacity({ total_capacity: 5, blocked_spaces: 99, admin_reserved: 0 }, 0),
    ).toThrow()

    await resetEvent()
    const v = (await event()).capacity_version as number
    const res = await setCapacity({ total: 5, blocked: 99, version: v })
    expect(res).toMatchObject({ ok: false, reason: 'negative_capacity' })
  })

  // ── the guard ────────────────────────────────────────────────────────────────

  it('a successful change bumps the version and records from→to', async () => {
    await resetEvent()
    const before = await event()
    const requestId = randomUUID()

    const res = await setCapacity({
      total: 23, blocked: 5, version: before.capacity_version as number, requestId,
    })
    expect(res).toMatchObject({ ok: true, noop: false, effective_capacity: 18 })

    const after = await event()
    expect(after.blocked_spaces).toBe(5)
    expect(after.capacity_version).toBe((before.capacity_version as number) + 1)

    const rows = await auditFor(requestId)
    expect(rows).toHaveLength(1)
    expect(rows[0].result).toBe('success')
    // effective_capacity_from/to are BOTH stored so the viewer never recomputes the
    // formula — presentation must not become a third place it lives.
    expect(rows[0].metadata_redacted).toMatchObject({
      total_capacity_from: 23, total_capacity_to: 23,
      blocked_spaces_from: 3, blocked_spaces_to: 5,
      effective_capacity_from: 20, effective_capacity_to: 18,
    })
  })

  it('resubmitting unchanged values writes nothing at all', async () => {
    await resetEvent()
    const before = await event()
    const requestId = randomUUID()

    const res = await setCapacity({
      total: before.total_capacity as number,
      blocked: before.blocked_spaces as number,
      version: before.capacity_version as number,
      requestId,
    })
    expect(res).toMatchObject({ ok: true, noop: true })

    // Unlike admin_account.disable — whose "no-op" still revokes sessions and therefore
    // still earns a row — this one is genuinely inert (0030:368).
    expect(await auditFor(requestId)).toEqual([])
    expect((await event()).capacity_version).toBe(before.capacity_version)
  })

  it('a stale version is refused, the row is untouched, and the conflict is still recorded', async () => {
    await resetEvent()
    const before = await event()
    await setCapacity({ total: 23, blocked: 4, version: before.capacity_version as number })

    const requestId = randomUUID()
    const res = await setCapacity({
      total: 23, blocked: 9, version: before.capacity_version as number, requestId,
    })
    expect(res).toMatchObject({ ok: false, reason: 'conflict' })
    expect((await event()).blocked_spaces).toBe(4)   // the other admin's change survives

    // The conflict row COMMITS — had the RPC raised instead of returning typed, the
    // rollback would have erased the only evidence of the lost update.
    const rows = await auditFor(requestId)
    expect(rows).toHaveLength(1)
    expect(rows[0].result).toBe('conflict')
    expect(rows[0].metadata_redacted).toMatchObject({
      reason: 'version_conflict',
      expected_version: before.capacity_version,   // not a literal: the version survives runs
      actual_version: (before.capacity_version as number) + 1,
    })
  })

  it('temp_approved holds a seat: cutting below promised is refused', async () => {
    await resetEvent()
    // Join rather than assume: not every seeded user owns a vehicle, and reservations
    // carry a composite FK (vehicle_id, user_id).
    const owners = (await sb.from('vehicles').select('id, user_id').limit(2)).data!
    expect(owners).toHaveLength(2)
    await sb.from('reservations').insert([
      { weekly_event_id: eventId, user_id: owners[0].user_id, vehicle_id: owners[0].id,
        status: 'approved', effective_priority: 3, release_deadline_at: '2099-08-02T02:30:00Z' },
      { weekly_event_id: eventId, user_id: owners[1].user_id, vehicle_id: owners[1].id,
        status: 'temp_approved', effective_priority: 3 },
    ]).throwOnError()

    const v = (await event()).capacity_version as number
    const requestId = randomUUID()
    // 23 − 22 blocked − 0 − 0 staff = 1 effective, but 2 seats are promised.
    const res = await setCapacity({ total: 23, blocked: 22, version: v, requestId })

    expect(res).toMatchObject({ ok: false, reason: 'capacity_below_promised', promised_count: 2 })
    // Counting only 'approved' would have said 1 and ALLOWED this — then the live offer
    // confirming (temp_approved → approved, no capacity check) would oversubscribe.
    const approvedOnly = await sb.from('reservations').select('id', { count: 'exact', head: true })
      .eq('weekly_event_id', eventId).eq('status', 'approved')
    expect(approvedOnly.count).toBe(1)

    expect((await event()).blocked_spaces).toBe(3)   // unchanged
    const rows = await auditFor(requestId)
    expect(rows[0].result).toBe('denied')
    // Numbers only — a denied row must never name who holds the seats.
    expect(JSON.stringify(rows[0].metadata_redacted)).not.toContain(owners[0].user_id)

    // The other half of the same rule, asserted on the same fixture rather than in a
    // separate test that would silently depend on this one's leftovers: the boundary is
    // >=, so effective exactly equal to promised is allowed.
    const v2 = (await event()).capacity_version as number
    const ok = await setCapacity({ total: 23, blocked: 21, version: v2 })
    expect(ok).toMatchObject({ ok: true, effective_capacity: 2, promised_count: 2 })
  })

  it('refuses while a friday allocation is running — it is about to create seats we cannot count yet', async () => {
    await resetEvent()
    await sb.from('job_runs')
      .insert({ weekly_event_id: eventId, job_type: 'friday_allocation', status: 'running' })
      .throwOnError()

    const v = (await event()).capacity_version as number
    const res = await setCapacity({ total: 23, blocked: 4, version: v })
    expect(res).toMatchObject({ ok: false, reason: 'allocation_in_progress' })
    await sb.from('job_runs').delete().eq('weekly_event_id', eventId)
  })

  it.each([
    ['finalized', 'finalized'],
    ['closed (nothing writes it today, but it must still fail closed)', 'closed'],
  ])('an event with status %s is not editable', async (_label, status) => {
    await resetEvent()
    await sb.from('weekly_events').update({ status }).eq('id', eventId)
    const v = (await event()).capacity_version as number
    const res = await setCapacity({ total: 23, blocked: 4, version: v })
    // An ALLOWLIST, so a status nobody thought about does not become silently editable.
    expect(res).toMatchObject({ ok: false, reason: 'event_not_editable' })
    await sb.from('weekly_events').update({ status: 'open' }).eq('id', eventId)
  })

  it('a mismatched sunday is refused and is NOT audited — it is a stale request, not governance', async () => {
    await resetEvent()
    const v = (await event()).capacity_version as number
    const requestId = randomUUID()
    const res = await setCapacity({ total: 23, blocked: 4, version: v, sunday: '2099-01-03', requestId })
    expect(res).toMatchObject({ ok: false, reason: 'sunday_mismatch' })
    expect(await auditFor(requestId)).toEqual([])
  })
})
