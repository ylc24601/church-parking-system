import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

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

describe.skipIf(!RUN)('cancellation + substitution — local DB integration', () => {
  let sb: Sb
  let repo: import('@/server/repositories/parkingRepository').ParkingRepository
  let svc: {
    cancelReservation: typeof import('@/server/services/cancellationService').cancelReservation
    resolveOffer: typeof import('@/server/services/offerService').resolveOffer
    expireOffers: typeof import('@/server/services/offerExpiryService').expireOffers
  }
  let buildReleaseDeadlines: typeof import('@/lib/allocation/release').buildReleaseDeadlines

  const SUNDAY1 = '2099-01-04', SUNDAY2 = '2099-01-11'
  const event1 = randomUUID(), event2 = randomUUID()
  const rA = randomUUID(), w2 = randomUUID(), w3 = randomUUID()   // event1
  const rB = randomUUID(), wB = randomUUID()                      // event2

  const NOW1 = new Date('2099-01-03T13:00:00Z')  // pre Sunday-1 midnight (16:00Z)
  const NOW2 = new Date('2099-01-03T13:10:00Z')
  const NOW_AFTER_MIDNIGHT2 = new Date('2099-01-11T16:01:00Z')

  async function cascadeDelete(eid: string) {
    await sb.from('notification_outbox').delete().eq('weekly_event_id', eid)
    await sb.from('reservations').delete().eq('weekly_event_id', eid)
    await sb.from('weekly_events').delete().eq('id', eid)
  }

  beforeAll(async () => {
    const { getServiceClient } = await import('@/lib/supabase/server')
    const { createParkingRepository } = await import('@/server/repositories/parkingRepository')
    svc = {
      cancelReservation: (await import('@/server/services/cancellationService')).cancelReservation,
      resolveOffer: (await import('@/server/services/offerService')).resolveOffer,
      expireOffers: (await import('@/server/services/offerExpiryService')).expireOffers,
    }
    buildReleaseDeadlines = (await import('@/lib/allocation/release')).buildReleaseDeadlines
    sb = getServiceClient()
    repo = createParkingRepository(sb)

    for (const d of [SUNDAY1, SUNDAY2]) {
      const { data } = await sb.from('weekly_events').select('id').eq('sunday_date', d)
      for (const row of data ?? []) await cascadeDelete(row.id as string)
    }

    await sb.from('weekly_events').insert([
      { id: event1, sunday_date: SUNDAY1, total_capacity: 23, blocked_spaces: 0, admin_reserved: 0 },
      { id: event2, sunday_date: SUNDAY2, total_capacity: 23, blocked_spaces: 0, admin_reserved: 0 },
    ]).throwOnError()

    const dl1 = buildReleaseDeadlines(SUNDAY1).p3.toISOString()
    await sb.from('reservations').insert([
      // event1: 1 approved + 2 waiting
      { id: rA, weekly_event_id: event1, user_id: M1, vehicle_id: V1, effective_priority: 3, status: 'approved', allocation_order: 1, release_deadline_at: dl1 },
      { id: w2, weekly_event_id: event1, user_id: M3, vehicle_id: V3, effective_priority: 3, status: 'waiting', allocation_order: 2 },
      { id: w3, weekly_event_id: event1, user_id: M4, vehicle_id: V4, effective_priority: 3, status: 'waiting', allocation_order: 3 },
      // event2: 1 approved + 1 waiting (for the after-midnight direct-approve path)
      { id: rB, weekly_event_id: event2, user_id: M1, vehicle_id: V1, effective_priority: 3, status: 'approved', allocation_order: 1, release_deadline_at: buildReleaseDeadlines(SUNDAY2).p3.toISOString() },
      { id: wB, weekly_event_id: event2, user_id: M3, vehicle_id: V3, effective_priority: 3, status: 'waiting', allocation_order: 2 },
    ]).throwOnError()
  })

  afterAll(async () => {
    if (!sb) return
    await cascadeDelete(event1)
    await cascadeDelete(event2)
  })

  const get = async (id: string) =>
    (await sb.from('reservations').select('*').eq('id', id).single()).data!

  it('full lifecycle: cancel → offer → decline → expire → confirm, idempotent', async () => {
    const p3 = buildReleaseDeadlines(SUNDAY1).p3

    // 1) cancel the approved spot → waiting#1 (w2, lowest order) gets a temp offer
    const c = await svc.cancelReservation({ reservationId: rA, now: NOW1 }, repo)
    expect(c.cancelStatus).toBe('cancelled_late')
    expect(c.substituteReservationId).toBe(w2)
    expect((await get(rA)).status).toBe('cancelled_late')
    expect((await get(rA)).cancelled_at).not.toBeNull()
    const w2offer = await get(w2)
    expect(w2offer.status).toBe('temp_approved')
    expect(w2offer.offer_expires_at).not.toBeNull()
    expect(w2offer.last_offer_at).not.toBeNull()
    expect((await get(w3)).status).toBe('waiting') // untouched
    const ob1 = await sb.from('notification_outbox').select('dedupe_key').eq('weekly_event_id', event1)
    expect(ob1.data!.some(o => o.dedupe_key === `offer:${w2}:${NOW1.toISOString()}`)).toBe(true)

    // 2) decline w2 → back to waiting (declined), allocation_order unchanged; w3 offered
    const d = await svc.resolveOffer({ reservationId: w2, action: 'decline', now: NOW2 }, repo)
    expect(d.substituteReservationId).toBe(w3)
    const w2declined = await get(w2)
    expect(w2declined.status).toBe('waiting')
    expect(w2declined.offer_status).toBe('declined')
    expect(w2declined.allocation_order).toBe(2) // preserved
    expect((await get(w3)).status).toBe('temp_approved')

    // 3) force w3's offer into the past and run the expire sweep → w3 expired; next offered (w2)
    await sb.from('reservations').update({ offer_expires_at: '2099-01-03T10:00:00Z' }).eq('id', w3).throwOnError()
    const e = await svc.expireOffers({ eventId: event1, now: new Date('2099-01-03T11:00:00Z') }, repo)
    expect(e.expired).toBe(1)
    const w3expired = await get(w3)
    expect(w3expired.status).toBe('waiting')
    expect(w3expired.offer_status).toBe('expired')
    expect((await get(w2)).status).toBe('temp_approved') // re-offered

    // 4) confirm w2 → approved with release_deadline_at; CHECK (approved ⇒ deadline) holds
    const cf = await svc.resolveOffer({ reservationId: w2, action: 'confirm', now: new Date('2099-01-03T11:05:00Z') }, repo)
    expect(cf.resolved).toBe(true)
    const w2approved = await get(w2)
    expect(w2approved.status).toBe('approved')
    expect(w2approved.offer_expires_at).toBeNull()
    expect(new Date(w2approved.release_deadline_at as string).getTime()).toBe(p3.getTime())

    // 5) idempotent: re-cancel the already-cancelled rA → no-op
    const again = await svc.cancelReservation({ reservationId: rA, now: NOW1 }, repo)
    expect(again.cancelled).toBe(false)
  })

  it('after midnight: cancelling an approved spot directly approves the next candidate', async () => {
    const c = await svc.cancelReservation({ reservationId: rB, now: NOW_AFTER_MIDNIGHT2 }, repo)
    expect(c.substituteReservationId).toBe(wB)
    const promoted = await get(wB)
    expect(promoted.status).toBe('approved')
    expect(promoted.release_deadline_at).not.toBeNull()
    expect(new Date(promoted.release_deadline_at as string).getTime())
      .toBe(buildReleaseDeadlines(SUNDAY2).p3.getTime())
  })
})
