import { describe, expect, it, vi } from 'vitest'
import { makeMockRepo, asRepo, type MockRepo } from './mockRepo'
import {
  applyForWeek,
  cancelForWeek,
  reportOnTheWay,
  resolveOfferForWeek,
} from '@/server/services/memberReservationService'
import type { cancelReservation } from '@/server/services/cancellationService'
import type { resolveOffer } from '@/server/services/offerService'
import type { markOnTheWay } from '@/server/services/onTheWayService'

const NOW = new Date('2026-07-09T00:00:00Z')   // Thu before Sunday 2026-07-12 (Taipei)
const USER = 'user-1'
const VEHICLE = '00000000-0000-4000-8000-000000000001'
const EVENT = { id: 'event-1', sunday_date: '2026-07-12', status: 'open' }

const reservationRow = (status: string, extra: Record<string, unknown> = {}) => ({
  id: 'res-1', status, effective_priority: 3, license_plate: 'ABC-1234', applied_at: NOW,
  attended_at: null, release_deadline_at: null, offer_expires_at: null, p2_on_the_way: false,
  ...extra,
})

function run(over: Partial<MockRepo> = {}) {
  const repo = makeMockRepo({ getMemberEvent: vi.fn(async () => EVENT), ...over })
  return { repo, r: asRepo(repo) }
}

describe('applyForWeek', () => {
  it('computes the §4 priority from server-side eligibility and passes it to the RPC', async () => {
    const { repo, r } = run({
      getMemberEligibility: vi.fn(async () => ({ p2_eligible: true, p2_reason: 'mobility_long', p2_valid_from: null, p2_valid_until: null })),
    })
    expect(await applyForWeek({ userId: USER, vehicleId: VEHICLE, requestedP2: false }, r, NOW)).toEqual({ ok: true })
    expect(repo.applyReservation).toHaveBeenCalledWith({
      eventId: 'event-1',
      userId: USER,
      vehicleId: VEHICLE,
      requestedP2: false,
      effectivePriority: 2,        // auto-P2, no declaration needed
      nowIso: NOW.toISOString(),
    })
  })

  it('a plain member lands at P3; a declared companion at P2', async () => {
    const { repo, r } = run({
      getMemberEligibility: vi.fn(async () => ({ p2_eligible: true, p2_reason: 'child_companion', p2_valid_from: null, p2_valid_until: null })),
    })
    await applyForWeek({ userId: USER, vehicleId: VEHICLE, requestedP2: true }, r, NOW)
    expect(repo.applyReservation.mock.calls[0][0].effectivePriority).toBe(2)
    await applyForWeek({ userId: USER, vehicleId: VEHICLE, requestedP2: false }, r, NOW)
    expect(repo.applyReservation.mock.calls[1][0].effectivePriority).toBe(3)
  })

  it('full-time staff are steered to P1 (no public application, RPC untouched)', async () => {
    const { repo, r } = run({ getUserRole: vi.fn(async () => 'full_time_staff') })
    expect(await applyForWeek({ userId: USER, vehicleId: VEHICLE, requestedP2: false }, r, NOW))
      .toEqual({ ok: false, reason: 'staff_use_p1' })
    expect(repo.applyReservation).not.toHaveBeenCalled()
  })

  it('no upcoming week → no_open_week', async () => {
    const { r } = run({ getMemberEvent: vi.fn(async () => null) })
    expect(await applyForWeek({ userId: USER, vehicleId: VEHICLE, requestedP2: false }, r, NOW))
      .toEqual({ ok: false, reason: 'no_open_week' })
  })

  it('malformed vehicle id → invalid_request before any read', async () => {
    const { repo, r } = run()
    for (const bad of [undefined, 42, 'not-a-uuid', '']) {
      expect(await applyForWeek({ userId: USER, vehicleId: bad, requestedP2: false }, r, NOW))
        .toEqual({ ok: false, reason: 'invalid_request' })
    }
    expect(repo.getMemberEvent).not.toHaveBeenCalled()
  })

  it('RPC business rejections pass through typed', async () => {
    const { r } = run({ applyReservation: vi.fn(async () => ({ applied: 0, reason: 'already_applied' })) })
    expect(await applyForWeek({ userId: USER, vehicleId: VEHICLE, requestedP2: false }, r, NOW))
      .toEqual({ ok: false, reason: 'already_applied' })
  })
})

describe('cancelForWeek', () => {
  const cancelFn = (summary: { cancelled: boolean; cancelStatus: 'cancelled_by_user' | 'cancelled_late' }) =>
    vi.fn(async () => ({
      ...summary, substituteOffered: false, substituteReservationId: null, confirmationEnqueued: true,
    })) as unknown as typeof cancelReservation

  it('cancels the member\'s own live row via the shared cancellation service', async () => {
    const { r } = run({ getMemberWeekReservation: vi.fn(async () => reservationRow('pending')) })
    const fn = cancelFn({ cancelled: true, cancelStatus: 'cancelled_by_user' })
    expect(await cancelForWeek({ userId: USER }, r, NOW, fn)).toEqual({ ok: true, cancelStatus: 'cancelled_by_user' })
    expect(fn).toHaveBeenCalledWith({ reservationId: 'res-1', now: NOW }, r)
  })

  it('approved → cancelled_late result surfaces', async () => {
    const { r } = run({ getMemberWeekReservation: vi.fn(async () => reservationRow('approved')) })
    const fn = cancelFn({ cancelled: true, cancelStatus: 'cancelled_late' })
    expect(await cancelForWeek({ userId: USER }, r, NOW, fn)).toEqual({ ok: true, cancelStatus: 'cancelled_late' })
  })

  it('temp_approved → offer_in_progress (offer flow owns it, service untouched)', async () => {
    const { r } = run({ getMemberWeekReservation: vi.fn(async () => reservationRow('temp_approved')) })
    const fn = cancelFn({ cancelled: true, cancelStatus: 'cancelled_by_user' })
    expect(await cancelForWeek({ userId: USER }, r, NOW, fn)).toEqual({ ok: false, reason: 'offer_in_progress' })
    expect(fn).not.toHaveBeenCalled()
  })

  it.each([
    [null, 'nothing_to_cancel'],
    [reservationRow('cancelled_by_user'), 'nothing_to_cancel'],
    [reservationRow('attended'), 'cannot_cancel'],
    [reservationRow('released_late'), 'cannot_cancel'],
  ] as const)('row %o → %s', async (row, reason) => {
    const { r } = run({ getMemberWeekReservation: vi.fn(async () => row) })
    const fn = cancelFn({ cancelled: true, cancelStatus: 'cancelled_by_user' })
    expect(await cancelForWeek({ userId: USER }, r, NOW, fn)).toEqual({ ok: false, reason })
    expect(fn).not.toHaveBeenCalled()
  })

  it('no open week → nothing_to_cancel', async () => {
    const { r } = run({ getMemberEvent: vi.fn(async () => null) })
    expect(await cancelForWeek({ userId: USER }, r, NOW)).toEqual({ ok: false, reason: 'nothing_to_cancel' })
  })
})

describe('resolveOfferForWeek', () => {
  const offerRow = (expiresAt: Date | null) =>
    reservationRow('temp_approved', { offer_expires_at: expiresAt })
  const resolveFn = (outcome: 'confirmed' | 'declined', resolved = true, expiredBlocked = false) =>
    vi.fn(async () => ({
      outcome, resolved, expiredBlocked, substituteOffered: false, substituteReservationId: null,
    })) as unknown as typeof resolveOffer

  it('confirms the member\'s own live offer through the shared offer service (expiry enforced)', async () => {
    const { r } = run({
      getMemberWeekReservation: vi.fn(async () => offerRow(new Date('2026-07-09T02:00:00Z'))),
    })
    const fn = resolveFn('confirmed')
    expect(await resolveOfferForWeek({ userId: USER, action: 'confirm' }, r, NOW, fn))
      .toEqual({ ok: true, outcome: 'confirmed' })
    expect(fn).toHaveBeenCalledWith(
      { reservationId: 'res-1', action: 'confirm', now: NOW, enforceExpiry: true }, r)
  })

  it('an expired offer is refused typed BEFORE the service (the sweep owns the row)', async () => {
    const { r } = run({
      getMemberWeekReservation: vi.fn(async () => offerRow(new Date('2026-07-08T23:59:00Z'))),
    })
    const fn = resolveFn('confirmed')
    expect(await resolveOfferForWeek({ userId: USER, action: 'confirm' }, r, NOW, fn))
      .toEqual({ ok: false, reason: 'offer_expired' })
    expect(fn).not.toHaveBeenCalled()
  })

  it('boundary: now EXACTLY at offer_expires_at counts as expired (>= — matches the UI)', async () => {
    const { r } = run({
      getMemberWeekReservation: vi.fn(async () => offerRow(new Date(NOW.getTime()))),
    })
    const fn = resolveFn('confirmed')
    expect(await resolveOfferForWeek({ userId: USER, action: 'confirm' }, r, NOW, fn))
      .toEqual({ ok: false, reason: 'offer_expired' })
    expect(fn).not.toHaveBeenCalled()
  })

  it('the atomic write refusing a lapsed offer (expiredBlocked) also maps to offer_expired', async () => {
    // Pre-check passes (no expiry on the row we read) but the guarded UPDATE
    // sees the truth — e.g. the clock crossed the deadline mid-request.
    const { r } = run({ getMemberWeekReservation: vi.fn(async () => offerRow(null)) })
    expect(await resolveOfferForWeek({ userId: USER, action: 'confirm' }, r, NOW, resolveFn('confirmed', false, true)))
      .toEqual({ ok: false, reason: 'offer_expired' })
  })

  it.each([
    [null],
    [reservationRow('approved')],
    [reservationRow('waiting')],
  ])('no live offer (row %o) → no_active_offer', async row => {
    const { r } = run({ getMemberWeekReservation: vi.fn(async () => row) })
    const fn = resolveFn('declined')
    expect(await resolveOfferForWeek({ userId: USER, action: 'decline' }, r, NOW, fn))
      .toEqual({ ok: false, reason: 'no_active_offer' })
    expect(fn).not.toHaveBeenCalled()
  })

  it('a raced resolution (resolved=false) maps to no_active_offer', async () => {
    const { r } = run({
      getMemberWeekReservation: vi.fn(async () => offerRow(new Date('2026-07-09T02:00:00Z'))),
    })
    expect(await resolveOfferForWeek({ userId: USER, action: 'decline' }, r, NOW, resolveFn('declined', false)))
      .toEqual({ ok: false, reason: 'no_active_offer' })
  })
})

describe('reportOnTheWay', () => {
  const markFn = (updated: boolean) =>
    vi.fn(async () => ({ updated })) as unknown as typeof markOnTheWay

  it('passes the member\'s own approved row to the shared on-the-way service', async () => {
    const { r } = run({
      getMemberWeekReservation: vi.fn(async () =>
        reservationRow('approved', { effective_priority: 2, release_deadline_at: new Date('2026-07-12T02:45:00Z') })),
    })
    const fn = markFn(true)
    expect(await reportOnTheWay({ userId: USER }, r, NOW, fn)).toEqual({ ok: true })
    expect(fn).toHaveBeenCalledWith({ reservationId: 'res-1', now: NOW }, r)
  })

  it('non-approved rows and service refusals map to not_eligible', async () => {
    const { r } = run({ getMemberWeekReservation: vi.fn(async () => reservationRow('pending')) })
    const fn = markFn(true)
    expect(await reportOnTheWay({ userId: USER }, r, NOW, fn)).toEqual({ ok: false, reason: 'not_eligible' })
    expect(fn).not.toHaveBeenCalled()

    // Approved but the service's authoritative guard says no (P3 / past deadline / already on the way).
    const { r: r2 } = run({ getMemberWeekReservation: vi.fn(async () => reservationRow('approved')) })
    expect(await reportOnTheWay({ userId: USER }, r2, NOW, markFn(false)))
      .toEqual({ ok: false, reason: 'not_eligible' })
  })
})
