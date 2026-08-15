import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Phase 7 Slice 4 — member offer confirm/decline + P2 on-the-way, wrapping the real
// offer / on-the-way services (and their RPCs) against local Supabase.
// Gated: `RUN_DB_TESTS=1` + reachable local Supabase (prereq: `npm run db:reset`).
try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may already be exported */
}
const RUN = process.env.RUN_DB_TESTS === '1'

type Sb = import('@supabase/supabase-js').SupabaseClient

// This file owns Sunday 2099-07-12. Offer tests run on the Thursday before;
// on-the-way tests run Sunday 10:25 Taipei (02:25Z), before the 10:30 deadline (#42).
const SUNDAY = '2099-07-12'
const THURSDAY = new Date('2099-07-09T00:00:00Z')
const SUNDAY_1025 = new Date('2099-07-12T02:25:00Z')
const T = randomUUID().slice(0, 8)

describe.skipIf(!RUN)('member offer + on-the-way (Phase 7 Slice 4) — local DB integration', () => {
  let sb: Sb
  let repo: import('@/server/repositories/parkingRepository').ParkingRepository
  let svc: typeof import('@/server/services/memberReservationService')
  let offerSvc: typeof import('@/server/services/offerService')

  const eventId = randomUUID()
  const users: string[] = []
  let nextOrder = 1

  const mkMember = async () => {
    const id = randomUUID()
    const vehicleId = randomUUID()
    await sb.from('users').insert({ id, display_name: `Offer7D ${T} ${users.length}` }).throwOnError()
    users.push(id)
    await sb.from('vehicles')
      .insert({ id: vehicleId, user_id: id, license_plate: `O7D-${T.slice(0, 3)}${users.length}` })
      .throwOnError()
    return { id, vehicleId }
  }

  // Insert a reservation directly in the target state (the offer/allocation machinery
  // that normally produces these states is covered by its own integration tests).
  const mkReservation = async (
    userId: string, vehicleId: string, status: string, extra: Record<string, unknown> = {},
  ) => {
    const id = randomUUID()
    await sb.from('reservations').insert({
      id, weekly_event_id: eventId, user_id: userId, vehicle_id: vehicleId,
      effective_priority: 3, status, applied_at: '2099-07-06T00:00:00Z',
      allocation_order: nextOrder++, ...extra,
    }).throwOnError()
    return id
  }

  const row = async (id: string) =>
    (await sb.from('reservations').select('*').eq('id', id).single()).data!

  beforeAll(async () => {
    sb = (await import('@/lib/supabase/server')).getServiceClient()
    repo = (await import('@/server/repositories/parkingRepository')).createParkingRepository(sb)
    svc = await import('@/server/services/memberReservationService')
    offerSvc = await import('@/server/services/offerService')
    await sb.from('weekly_events')
      .insert({ id: eventId, sunday_date: SUNDAY, total_capacity: 23, status: 'open' })
      .throwOnError()
  })

  afterAll(async () => {
    if (!RUN) return
    await sb.from('notification_outbox').delete().eq('weekly_event_id', eventId)
    await sb.from('reservations').delete().eq('weekly_event_id', eventId)
    await sb.from('weekly_events').delete().eq('id', eventId)
    for (const id of users) {
      await sb.from('vehicles').delete().eq('user_id', id)
      await sb.from('users').delete().eq('id', id)
    }
  })

  it('confirm: temp_approved → approved with a stamped P3 deadline + approval notice enqueued', async () => {
    const m = await mkMember()
    const rid = await mkReservation(m.id, m.vehicleId, 'temp_approved', {
      offer_expires_at: '2099-07-09T02:00:00Z', last_offer_at: '2099-07-09T00:00:00Z',
    })

    expect(await svc.resolveOfferForWeek({ userId: m.id, action: 'confirm' }, repo, THURSDAY))
      .toEqual({ ok: true, outcome: 'confirmed' })
    const r = await row(rid)
    expect(r.status).toBe('approved')
    // P3 deadline = Sunday 10:30 Taipei = 02:30Z.
    expect(new Date(r.release_deadline_at as string).toISOString()).toBe('2099-07-12T02:30:00.000Z')

    const notice = (await sb.from('notification_outbox').select('template_key, dedupe_key')
      .eq('reservation_id', rid)).data!
    expect(notice).toContainEqual({ template_key: 'reservation_approved', dedupe_key: `confirmed:${rid}` })
  })

  it('decline: back to waiting (offer_status=declined) and the spot moves to the NEXT candidate', async () => {
    const decliner = await mkMember()
    const nextInLine = await mkMember()
    const rid = await mkReservation(decliner.id, decliner.vehicleId, 'temp_approved', {
      offer_expires_at: '2099-07-09T02:00:00Z',
    })
    const waitingId = await mkReservation(nextInLine.id, nextInLine.vehicleId, 'waiting')

    const res = await svc.resolveOfferForWeek({ userId: decliner.id, action: 'decline' }, repo, THURSDAY)
    expect(res).toEqual({ ok: true, outcome: 'declined' })

    const declined = await row(rid)
    expect(declined).toMatchObject({ status: 'waiting', offer_status: 'declined' })
    const next = await row(waitingId)
    expect(next.status).toBe('temp_approved')            // re-offered down the list
    expect(next.offer_expires_at).not.toBeNull()
  })

  it('expired offer: typed offer_expired, nothing written (the sweep owns the row)', async () => {
    const m = await mkMember()
    const rid = await mkReservation(m.id, m.vehicleId, 'temp_approved', {
      offer_expires_at: '2099-07-08T23:00:00Z',   // before THURSDAY
    })
    expect(await svc.resolveOfferForWeek({ userId: m.id, action: 'confirm' }, repo, THURSDAY))
      .toEqual({ ok: false, reason: 'offer_expired' })
    expect((await row(rid)).status).toBe('temp_approved')
  })

  it('no live offer (pending row) → no_active_offer', async () => {
    const m = await mkMember()
    await mkReservation(m.id, m.vehicleId, 'pending')
    expect(await svc.resolveOfferForWeek({ userId: m.id, action: 'confirm' }, repo, THURSDAY))
      .toEqual({ ok: false, reason: 'no_active_offer' })
  })

  it('boundary: now EXACTLY at offer_expires_at → offer_expired, nothing written', async () => {
    const m = await mkMember()
    const rid = await mkReservation(m.id, m.vehicleId, 'temp_approved', {
      offer_expires_at: THURSDAY.toISOString(),
    })
    expect(await svc.resolveOfferForWeek({ userId: m.id, action: 'confirm' }, repo, THURSDAY))
      .toEqual({ ok: false, reason: 'offer_expired' })
    expect((await row(rid)).status).toBe('temp_approved')
  })

  // The next two bypass the member service's TS pre-check on purpose: they prove the
  // expiry rule holds inside apply_offer_resolution itself (p_expiry_guard), i.e. a
  // request whose clock crossed the deadline between pre-check and write still loses.
  it('authoritative guard: an expired confirm is refused by the atomic write itself', async () => {
    const m = await mkMember()
    const rid = await mkReservation(m.id, m.vehicleId, 'temp_approved', {
      offer_expires_at: '2099-07-08T23:00:00Z',   // before THURSDAY
    })
    const summary = await offerSvc.resolveOffer(
      { reservationId: rid, action: 'confirm', now: THURSDAY, enforceExpiry: true }, repo)
    expect(summary).toMatchObject({ resolved: false, expiredBlocked: true })

    const r = await row(rid)
    expect(r.status).toBe('temp_approved')                    // untouched — the sweep owns it
    expect(r.offer_expires_at).not.toBeNull()
    const notices = (await sb.from('notification_outbox').select('id').eq('reservation_id', rid)).data!
    expect(notices).toHaveLength(0)                           // no reservation_approved enqueued
  })

  it('authoritative guard: an expired decline is refused too — no substitute offered', async () => {
    const decliner = await mkMember()
    const nextInLine = await mkMember()
    const rid = await mkReservation(decliner.id, decliner.vehicleId, 'temp_approved', {
      offer_expires_at: '2099-07-08T23:00:00Z',
    })
    const waitingId = await mkReservation(nextInLine.id, nextInLine.vehicleId, 'waiting')

    const summary = await offerSvc.resolveOffer(
      { reservationId: rid, action: 'decline', now: THURSDAY, enforceExpiry: true }, repo)
    expect(summary).toMatchObject({ resolved: false, expiredBlocked: true, substituteOffered: false })
    expect((await row(rid)).status).toBe('temp_approved')
    expect((await row(waitingId)).status).toBe('waiting')     // nobody re-offered
  })

  it('ops semantics preserved: WITHOUT the guard an expired offer still confirms (midnight auto-approve path)', async () => {
    const m = await mkMember()
    const rid = await mkReservation(m.id, m.vehicleId, 'temp_approved', {
      offer_expires_at: '2099-07-08T23:00:00Z',
    })
    const summary = await offerSvc.resolveOffer(
      { reservationId: rid, action: 'confirm', now: THURSDAY }, repo)
    expect(summary.resolved).toBe(true)
    expect((await row(rid)).status).toBe('approved')
  })

  it('on-the-way: approved P2 before 10:30 → p2_on_the_way + deadline extends to 10:50', async () => {
    const m = await mkMember()
    const rid = await mkReservation(m.id, m.vehicleId, 'approved', {
      effective_priority: 2, approved_at: '2099-07-10T10:00:00Z',
      release_deadline_at: '2099-07-12T02:30:00Z',
    })
    expect(await svc.reportOnTheWay({ userId: m.id }, repo, SUNDAY_1025)).toEqual({ ok: true })
    const r = await row(rid)
    expect(r.p2_on_the_way).toBe(true)
    expect(new Date(r.release_deadline_at as string).toISOString()).toBe('2099-07-12T02:50:00.000Z')

    // Idempotence: a second tap is not_eligible (already on the way), deadline unchanged.
    expect(await svc.reportOnTheWay({ userId: m.id }, repo, SUNDAY_1025))
      .toEqual({ ok: false, reason: 'not_eligible' })
  })

  it('on-the-way refusals: P3, and P2 past its deadline (no retroactive extension)', async () => {
    const p3 = await mkMember()
    const p3id = await mkReservation(p3.id, p3.vehicleId, 'approved', {
      approved_at: '2099-07-10T10:00:00Z', release_deadline_at: '2099-07-12T02:30:00Z',
    })
    expect(await svc.reportOnTheWay({ userId: p3.id }, repo, new Date('2099-07-12T02:00:00Z')))
      .toEqual({ ok: false, reason: 'not_eligible' })
    expect((await row(p3id)).p2_on_the_way).toBe(false)

    const late = await mkMember()
    const lateId = await mkReservation(late.id, late.vehicleId, 'approved', {
      effective_priority: 2, approved_at: '2099-07-10T10:00:00Z',
      release_deadline_at: '2099-07-12T02:30:00Z',
    })
    expect(await svc.reportOnTheWay({ userId: late.id }, repo, new Date('2099-07-12T02:31:00Z')))
      .toEqual({ ok: false, reason: 'not_eligible' })
    const lateRow = await row(lateId)
    expect(lateRow.p2_on_the_way).toBe(false)
    expect(new Date(lateRow.release_deadline_at as string).toISOString()).toBe('2099-07-12T02:30:00.000Z')
  })
})
