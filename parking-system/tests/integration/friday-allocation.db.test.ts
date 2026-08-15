import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Gated: only runs with `RUN_DB_TESTS=1` and a reachable local Supabase + env.
// Prereq: `npm run db:reset` (migrations + seed) with the local stack up.
try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may already be exported in the shell */
}

const RUN = process.env.RUN_DB_TESTS === '1'

// Lazy imports so the file is import-safe when skipped.
type Sb = import('@supabase/supabase-js').SupabaseClient

// Seeded member/vehicle pairs (supabase/seed.sql).
const M1 = 'a0000000-0000-0000-0000-000000000001'  // P2 (mobility_long)
const V1 = 'b0000000-0000-0000-0000-000000000001'
const M3 = 'a0000000-0000-0000-0000-000000000003'  // P3
const V3 = 'b0000000-0000-0000-0000-000000000003'
const M4 = 'a0000000-0000-0000-0000-000000000004'  // P3
const V4 = 'b0000000-0000-0000-0000-000000000004'
const M5 = 'a0000000-0000-0000-0000-000000000005'
const V5 = 'b0000000-0000-0000-0000-000000000005'

describe.skipIf(!RUN)('friday allocation — local DB integration', () => {
  let sb: Sb
  let repo: import('@/server/repositories/parkingRepository').ParkingRepository
  let runFridayAllocation: typeof import('@/server/services/fridayAllocationService').runFridayAllocation

  const SUNDAY = '2099-01-04'
  const SUNDAY2 = '2099-01-11'
  const eventId = randomUUID()
  const event2Id = randomUUID()
  const r1 = randomUUID()  // M1 P2
  const r3 = randomUUID()  // M3 P3
  const r4 = randomUUID()  // M4 P3
  const rNonPending = randomUUID()  // M5, already cancelled

  async function deleteEventCascade(sbc: Sb, eid: string) {
    await sbc.from('notification_outbox').delete().eq('weekly_event_id', eid)
    await sbc.from('job_runs').delete().eq('weekly_event_id', eid)
    await sbc.from('reservations').delete().eq('weekly_event_id', eid)
    await sbc.from('weekly_staff_allocations').delete().eq('weekly_event_id', eid)
    await sbc.from('weekly_events').delete().eq('id', eid)
  }

  beforeAll(async () => {
    const { getServiceClient } = await import('@/lib/supabase/server')
    const { createParkingRepository } = await import('@/server/repositories/parkingRepository')
    ;({ runFridayAllocation } = await import('@/server/services/fridayAllocationService'))
    sb = getServiceClient()
    repo = createParkingRepository(sb)

    // Clean any leftovers from a prior crashed run (by the fixed test Sundays).
    for (const d of [SUNDAY, SUNDAY2]) {
      const { data } = await sb.from('weekly_events').select('id').eq('sunday_date', d)
      for (const row of data ?? []) await deleteEventCascade(sb, row.id as string)
    }

    // Event 1: capacity 2 (23 - 21 blocked = 2; no guests, no staff).
    await sb.from('weekly_events').insert({
      id: eventId, sunday_date: SUNDAY, total_capacity: 23, blocked_spaces: 21, admin_reserved: 0, status: 'open',
    }).throwOnError()
    await sb.from('reservations').insert([
      { id: r1, weekly_event_id: eventId, user_id: M1, vehicle_id: V1, effective_priority: 2, status: 'pending', applied_at: '2026-06-15T01:00:00Z' },
      { id: r3, weekly_event_id: eventId, user_id: M3, vehicle_id: V3, effective_priority: 3, status: 'pending', applied_at: '2026-06-15T02:00:00Z' },
      { id: r4, weekly_event_id: eventId, user_id: M4, vehicle_id: V4, effective_priority: 3, status: 'pending', applied_at: '2026-06-15T03:00:00Z' },
    ]).throwOnError()

    // Event 2: a single NON-pending reservation, for the RPC guard probe.
    await sb.from('weekly_events').insert({
      id: event2Id, sunday_date: SUNDAY2, total_capacity: 23, blocked_spaces: 0, admin_reserved: 0, status: 'open',
    }).throwOnError()
    await sb.from('reservations').insert({
      id: rNonPending, weekly_event_id: event2Id, user_id: M5, vehicle_id: V5,
      effective_priority: 3, status: 'cancelled_by_user', applied_at: '2026-06-15T01:00:00Z',
    }).throwOnError()
  })

  afterAll(async () => {
    if (!sb) return
    await deleteEventCascade(sb, eventId)
    await deleteEventCascade(sb, event2Id)
  })

  it('approves up to capacity, stamps deadlines, enqueues outbox, and is idempotent', async () => {
    const { buildReleaseDeadlines } = await import('@/lib/allocation/release')
    const deadlines = buildReleaseDeadlines(SUNDAY)

    const summary = await runFridayAllocation({ eventId }, repo)
    expect(summary.jobStatus).toBe('success')
    expect(summary.plannedApproved).toBe(2)
    expect(summary.plannedWaiting).toBe(1)
    expect(summary.updated).toBe(3)

    const { data: rows } = await sb.from('reservations')
      .select('id,status,allocation_order,release_deadline_at,effective_priority,approved_at')
      .eq('weekly_event_id', eventId)
    const byId = new Map((rows ?? []).map(r => [r.id, r]))

    const approved = (rows ?? []).filter(r => r.status === 'approved')
    const waiting = (rows ?? []).filter(r => r.status === 'waiting')
    expect(approved).toHaveLength(2)
    expect(waiting).toHaveLength(1)

    // allocation_order contiguous + unique
    const orders = (rows ?? []).map(r => r.allocation_order).sort()
    expect(orders).toEqual([1, 2, 3])

    // approved always carry a deadline (CHECK can never be violated); waiting null
    expect(approved.every(r => r.release_deadline_at !== null)).toBe(true)
    expect(waiting.every(r => r.release_deadline_at === null)).toBe(true)

    // P2 (M1) approved → 10:30 (same as P3, #42); the approved P3 → 10:30
    const m1 = byId.get(r1)!
    expect(m1.status).toBe('approved')
    expect(new Date(m1.release_deadline_at as string).getTime()).toBe(deadlines.p2.getTime())
    const approvedP3 = approved.find(r => r.effective_priority === 3)!
    expect(new Date(approvedP3.release_deadline_at as string).getTime()).toBe(deadlines.p3.getTime())

    // outbox: one per reservation, dedupe keys present
    const { data: outbox } = await sb.from('notification_outbox')
      .select('dedupe_key,reservation_id,template_key,payload_json').eq('weekly_event_id', eventId)
    expect(outbox).toHaveLength(3)
    expect(new Set((outbox ?? []).map(o => o.dedupe_key)).size).toBe(3)

    // Wave 1d (#27) — the week and the car reach the PERSISTED payload. This is the only test
    // that exercises the real reservations→vehicles embed: the FK is composite
    // ((vehicle_id, user_id) → vehicles(id, user_id)), so only live PostgREST can prove it
    // resolves. Everything else in this slice runs against a mock repo.
    const plateByReservation: Record<string, string> = {
      [r1]: 'ABC-1234',   // M1 / V1
      [r3]: 'GHI-9012',   // M3 / V3
      [r4]: 'JKL-3456',   // M4 / V4
    }
    for (const o of outbox ?? []) {
      const payload = o.payload_json as Record<string, unknown>
      expect(payload.sunday_date).toBe(SUNDAY)
      expect(payload.license_plate).toBe(plateByReservation[o.reservation_id as string])
    }

    // …and the member actually reads them: prose date, their own plate, no ISO string.
    const { renderTemplate } = await import('@/server/services/notification/templates')
    const m1Notice = (outbox ?? []).find(o => o.reservation_id === r1)!
    const text = renderTemplate(m1Notice.template_key as string, m1Notice.payload_json as Record<string, unknown>)
    expect(text).toContain('1月4日 主日')
    expect(text).toContain('車牌：ABC-1234')
    expect(text).not.toContain(SUNDAY)

    // job_runs success
    const { data: job } = await sb.from('job_runs')
      .select('status').eq('weekly_event_id', eventId).eq('job_type', 'friday_allocation').single()
    expect(job?.status).toBe('success')

    // Idempotent second run → skipped, no duplicate outbox, ranks/approved_at stable
    const before = await sb.from('reservations')
      .select('id,allocation_order,approved_at').eq('weekly_event_id', eventId)
    const second = await runFridayAllocation({ eventId }, repo)
    expect(second.jobStatus).toBe('skipped')

    const { data: outbox2 } = await sb.from('notification_outbox')
      .select('id').eq('weekly_event_id', eventId)
    expect(outbox2).toHaveLength(3)

    const after = await sb.from('reservations')
      .select('id,allocation_order,approved_at').eq('weekly_event_id', eventId)
    expect(after.data).toEqual(before.data)
  })

  it('RPC does not update or enqueue outbox for rows that are no longer pending', async () => {
    const fakeOutbox = [{
      dedupe_key: `friday_allocation:${rNonPending}`,
      template_key: 'reservation_approved',
      user_id: M5, reservation_id: rNonPending, payload: {},
    }]
    const fakeUpdate = [{
      id: rNonPending, status: 'approved', allocation_order: 1,
      approved_at: new Date().toISOString(),
      release_deadline_at: new Date().toISOString(),
    }]

    const result = await repo.applyFridayAllocation(event2Id, 'friday_allocation', fakeUpdate, fakeOutbox)
    expect(result.skipped).toBe(false)
    expect(result.updated).toBe(0)
    expect(result.outbox_enqueued).toBe(0)

    // reservation untouched
    const { data: row } = await sb.from('reservations').select('status,allocation_order').eq('id', rNonPending).single()
    expect(row?.status).toBe('cancelled_by_user')
    expect(row?.allocation_order).toBeNull()

    // no outbox row written
    const { data: ob } = await sb.from('notification_outbox').select('id').eq('weekly_event_id', event2Id)
    expect(ob).toHaveLength(0)
  })
})
