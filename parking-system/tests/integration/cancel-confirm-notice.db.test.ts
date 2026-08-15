import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Phase 4 Slice E — cancelling a reservation confirms it to the MEMBER WHO CANCELLED.
// Gated: `RUN_DB_TESTS=1` + reachable local Supabase (prereq: `npm run db:reset`).
try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may already be exported */
}
const RUN = process.env.RUN_DB_TESTS === '1'

type Sb = import('@supabase/supabase-js').SupabaseClient

// Seeded member/vehicle pairs (supabase/seed.sql).
const M1 = 'a0000000-0000-0000-0000-000000000001', V1 = 'b0000000-0000-0000-0000-000000000001'
const M3 = 'a0000000-0000-0000-0000-000000000003', V3 = 'b0000000-0000-0000-0000-000000000003'
const M4 = 'a0000000-0000-0000-0000-000000000004', V4 = 'b0000000-0000-0000-0000-000000000004'

describe.skipIf(!RUN)('cancel-confirmation notice — local DB integration', () => {
  let sb: Sb
  let repo: import('@/server/repositories/parkingRepository').ParkingRepository
  let cancelReservation: typeof import('@/server/services/cancellationService').cancelReservation

  const SUNDAY = '2099-01-18'
  const event = randomUUID()
  const rApproved = randomUUID(), wSub = randomUUID(), rWaitingSelf = randomUUID()

  // Sunday-midnight (Taipei) = 2099-01-17T16:00Z; use a pre-midnight instant so the approved cancel
  // offers a 2-hour temp_approved to the waiting candidate.
  const NOW = new Date('2099-01-17T13:00:00Z')
  const NOW_LATER = new Date('2099-01-17T13:30:00Z')

  async function cascadeDelete(eid: string) {
    await sb.from('notification_outbox').delete().eq('weekly_event_id', eid)
    await sb.from('reservations').delete().eq('weekly_event_id', eid)
    await sb.from('weekly_events').delete().eq('id', eid)
  }
  const outbox = async () =>
    ((await sb.from('notification_outbox')
      .select('dedupe_key, template_key, user_id, reservation_id, payload_json')
      .eq('weekly_event_id', event)).data ?? [])
  const get = async (id: string) =>
    (await sb.from('reservations').select('*').eq('id', id).single()).data!

  beforeAll(async () => {
    const { getServiceClient } = await import('@/lib/supabase/server')
    const { createParkingRepository } = await import('@/server/repositories/parkingRepository')
    const { buildReleaseDeadlines } = await import('@/lib/allocation/release')
    cancelReservation = (await import('@/server/services/cancellationService')).cancelReservation
    sb = getServiceClient()
    repo = createParkingRepository(sb)

    const { data: leftovers } = await sb.from('weekly_events').select('id').eq('sunday_date', SUNDAY)
    for (const row of leftovers ?? []) await cascadeDelete(row.id as string)

    await sb.from('weekly_events').insert({
      id: event, sunday_date: SUNDAY, total_capacity: 23, blocked_spaces: 0, admin_reserved: 0,
    }).throwOnError()

    const dl = buildReleaseDeadlines(SUNDAY).p3.toISOString()
    await sb.from('reservations').insert([
      { id: rApproved, weekly_event_id: event, user_id: M1, vehicle_id: V1, effective_priority: 3, status: 'approved', allocation_order: 1, release_deadline_at: dl },
      { id: wSub, weekly_event_id: event, user_id: M3, vehicle_id: V3, effective_priority: 3, status: 'waiting', allocation_order: 2 },
      { id: rWaitingSelf, weekly_event_id: event, user_id: M4, vehicle_id: V4, effective_priority: 3, status: 'waiting', allocation_order: 3 },
    ]).throwOnError()
  })

  afterAll(async () => {
    if (sb) await cascadeDelete(event)
  })

  it('cancelling an approved seat: confirms to the canceller AND offers to the substitute', async () => {
    const res = await cancelReservation({ reservationId: rApproved, now: NOW }, repo)
    expect(res.cancelStatus).toBe('cancelled_late')
    expect(res.confirmationEnqueued).toBe(true)
    expect(res.substituteReservationId).toBe(wSub)
    expect((await get(rApproved)).status).toBe('cancelled_late')

    const rows = await outbox()
    // the cancelling member's confirmation — reservation_id/user is the CANCELLER, keyed once
    const notice = rows.find(r => r.template_key === 'reservation_cancelled')!
    expect(notice.reservation_id).toBe(rApproved)
    expect(notice.user_id).toBe(M1)
    expect(notice.dedupe_key).toBe(`cancel_notice:${rApproved}`)
    // cancel_status is authoritative from the transitioned row (RPC), not TS payload
    expect(notice.payload_json).toEqual({ cancel_status: 'cancelled_late' })
    // the substitute offer is still enqueued and distinct (goes to the promoted waiting member)
    expect(rows.some(r => r.dedupe_key === `offer:${wSub}:${NOW.toISOString()}` && r.reservation_id === wSub)).toBe(true)
  })

  it('cancelling a waiting row: cancelled_by_user confirmation only, no substitute offer', async () => {
    const res = await cancelReservation({ reservationId: rWaitingSelf, now: NOW }, repo)
    expect(res.cancelStatus).toBe('cancelled_by_user')
    expect(res.confirmationEnqueued).toBe(true)
    expect(res.substituteOffered).toBe(false)

    const notice = (await outbox()).find(r => r.dedupe_key === `cancel_notice:${rWaitingSelf}`)!
    expect(notice.template_key).toBe('reservation_cancelled')
    expect(notice.user_id).toBe(M4)
    expect(notice.payload_json).toEqual({ cancel_status: 'cancelled_by_user' })
  })

  it('confirmation payload is aggregate-safe: only cancel_status, no per-member fields', async () => {
    const notices = (await outbox()).filter(r => r.template_key === 'reservation_cancelled')
    expect(notices.length).toBeGreaterThanOrEqual(2)
    for (const n of notices) {
      const payload = n.payload_json as Record<string, unknown>
      expect(Object.keys(payload)).toEqual(['cancel_status'])
      const json = JSON.stringify(payload)
      for (const k of ['license_plate', 'plate', 'name', 'phone', 'penalty', 'line_id', 'user_id']) {
        expect(json).not.toContain(k)
      }
    }
  })

  it('is idempotent: re-cancelling enqueues no duplicate confirmation', async () => {
    const before = (await outbox()).filter(r => r.template_key === 'reservation_cancelled').length
    const again = await cancelReservation({ reservationId: rWaitingSelf, now: NOW_LATER }, repo)
    expect(again.cancelled).toBe(false)              // already cancelled → no-op (no RPC)
    expect(again.confirmationEnqueued).toBe(false)
    const after = (await outbox()).filter(r => r.template_key === 'reservation_cancelled').length
    expect(after).toBe(before)
  })
})
