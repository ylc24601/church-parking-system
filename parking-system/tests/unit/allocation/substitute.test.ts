import { describe, expect, it } from 'vitest'
import { autoApproveTempApproved, failOffer, triggerSubstitution } from '@/lib/allocation/substitute'
import { OFFER_CONFIRM_WINDOW_MS } from '@/lib/allocation/rules'
import { makeReservation, makeWalkIn, T } from './helpers'

// ── triggerSubstitution ────────────────────────────────────────────────────

describe('triggerSubstitution', () => {
  it('returns null when waiting list is empty', () => {
    expect(triggerSubstitution([], T.SAT_22, T.SUN_00)).toBeNull()
  })

  it('skips non-waiting entries and picks the first waiting one', () => {
    const notWaiting = makeReservation({ status: 'cancelled_by_user' })
    const waiting    = makeReservation({ status: 'waiting' })
    const result = triggerSubstitution([notWaiting, waiting], T.SAT_22, T.SUN_00)
    expect(result?.reservation.id).toBe(waiting.id)
  })

  // ── Before Sunday midnight → temp_approved ────────────────────────────────

  it('creates temp_approved before Sunday midnight', () => {
    const waiting = makeReservation({ status: 'waiting' })
    const result  = triggerSubstitution([waiting], T.SAT_22, T.SUN_00)
    expect(result?.reservation.status).toBe('temp_approved')
  })

  it('offer_expires_at = now + confirm window when cancellation is well before midnight', () => {
    const waiting = makeReservation({ status: 'waiting' })
    const result  = triggerSubstitution([waiting], T.SAT_22, T.SUN_00)
    const expected = new Date(T.SAT_22.getTime() + OFFER_CONFIRM_WINDOW_MS)
    expect(result?.reservation.offer_expires_at?.getTime()).toBe(expected.getTime())
  })

  it('offer_expires_at = Sunday midnight when Sat 23:45 cancellation', () => {
    // Sat 23:45 Taipei → only 15-minute window before Sunday 00:00
    const waiting = makeReservation({ status: 'waiting' })
    const result  = triggerSubstitution([waiting], T.SAT_2345, T.SUN_00)
    // MIN(23:45 + 2h, 00:00) = 00:00
    expect(result?.reservation.offer_expires_at?.getTime()).toBe(T.SUN_00.getTime())
  })

  it('emits offer_2hr_confirm outbox entry', () => {
    const waiting = makeReservation({ status: 'waiting' })
    const result  = triggerSubstitution([waiting], T.SAT_22, T.SUN_00)
    expect(result?.outbox[0].template_key).toBe('offer_2hr_confirm')
  })

  // ── After Sunday midnight → direct approved ───────────────────────────────

  it('creates direct approved after Sunday midnight', () => {
    const waiting = makeReservation({ status: 'waiting' })
    const result  = triggerSubstitution([waiting], T.SUN_0001, T.SUN_00)
    expect(result?.reservation.status).toBe('approved')
  })

  it('offer_expires_at is null for direct approved', () => {
    const waiting = makeReservation({ status: 'waiting' })
    const result  = triggerSubstitution([waiting], T.SUN_0001, T.SUN_00)
    expect(result?.reservation.offer_expires_at).toBeNull()
  })

  it('emits reservation_approved outbox for direct approval', () => {
    const waiting = makeReservation({ status: 'waiting' })
    const result  = triggerSubstitution([waiting], T.SUN_0001, T.SUN_00)
    expect(result?.outbox[0].template_key).toBe('reservation_approved')
  })

  // ── Idempotency ───────────────────────────────────────────────────────────

  it('is idempotent: second call on already-promoted list returns null', () => {
    const waiting = makeReservation({ status: 'waiting' })
    const first   = triggerSubstitution([waiting], T.SAT_22, T.SUN_00)
    // After first call the reservation is temp_approved, not waiting
    const second  = triggerSubstitution([first!.reservation], T.SAT_22, T.SUN_00)
    expect(second).toBeNull()
  })
})

// ── autoApproveTempApproved ────────────────────────────────────────────────

describe('autoApproveTempApproved', () => {
  it('does nothing before Sunday midnight', () => {
    const temp = makeReservation({ status: 'temp_approved' })
    const { reservations } = autoApproveTempApproved([temp], T.SAT_22, T.SUN_00)
    expect(reservations[0].status).toBe('temp_approved')
  })

  it('upgrades temp_approved → approved at or after Sunday midnight', () => {
    const temp = makeReservation({ status: 'temp_approved' })
    const { reservations } = autoApproveTempApproved([temp], T.SUN_0001, T.SUN_00)
    expect(reservations[0].status).toBe('approved')
  })

  it('clears offer_expires_at after auto-approval', () => {
    const temp = makeReservation({ status: 'temp_approved', offer_expires_at: T.SUN_00 })
    const { reservations } = autoApproveTempApproved([temp], T.SUN_0001, T.SUN_00)
    expect(reservations[0].offer_expires_at).toBeNull()
  })

  it('emits offer_auto_approved outbox entry', () => {
    const temp = makeReservation({ status: 'temp_approved' })
    const { outbox } = autoApproveTempApproved([temp], T.SUN_0001, T.SUN_00)
    expect(outbox[0].template_key).toBe('offer_auto_approved')
  })

  it('does not touch non-temp_approved reservations', () => {
    const approved = makeReservation({ status: 'approved' })
    const waiting  = makeReservation({ status: 'waiting' })
    const temp     = makeReservation({ status: 'temp_approved' })
    const { reservations } = autoApproveTempApproved([approved, waiting, temp], T.SUN_0001, T.SUN_00)
    expect(reservations.find(r => r.id === approved.id)?.status).toBe('approved')
    expect(reservations.find(r => r.id === waiting.id)?.status).toBe('waiting')
  })

  it('handles multiple temp_approved in one sweep', () => {
    const temps = [makeReservation({ status: 'temp_approved' }), makeReservation({ status: 'temp_approved' })]
    const { reservations, outbox } = autoApproveTempApproved(temps, T.SUN_0001, T.SUN_00)
    expect(reservations.every(r => r.status === 'approved')).toBe(true)
    expect(outbox).toHaveLength(2)
  })

  // ── Walk-in not affected ──────────────────────────────────────────────────

  it('walk_in reservations are not touched', () => {
    const walkIn = makeWalkIn()
    const { reservations } = autoApproveTempApproved([walkIn], T.SUN_0001, T.SUN_00)
    expect(reservations[0].status).toBe('walk_in')
  })
})

// ── failOffer (expired / declined) ─────────────────────────────────────────

describe('failOffer', () => {
  it('expired: status reverts to waiting, offer_status=expired', () => {
    const temp = makeReservation({ status: 'temp_approved', offer_expires_at: T.SAT_22 })
    const result = failOffer(temp, 'expired')
    expect(result.status).toBe('waiting')
    expect(result.offer_status).toBe('expired')
  })

  it('declined: status reverts to waiting, offer_status=declined', () => {
    const temp = makeReservation({ status: 'temp_approved', offer_expires_at: T.SAT_22 })
    const result = failOffer(temp, 'declined')
    expect(result.status).toBe('waiting')
    expect(result.offer_status).toBe('declined')
  })

  it('clears offer_expires_at on failure', () => {
    const temp = makeReservation({ status: 'temp_approved', offer_expires_at: T.SAT_22 })
    expect(failOffer(temp, 'expired').offer_expires_at).toBeNull()
  })

  it('preserves allocation_order on expiry (rank not recomputed)', () => {
    const temp = makeReservation({ status: 'temp_approved', allocation_order: 7 })
    expect(failOffer(temp, 'expired').allocation_order).toBe(7)
  })

  it('preserves allocation_order on decline (rank not recomputed)', () => {
    const temp = makeReservation({ status: 'temp_approved', allocation_order: 7 })
    expect(failOffer(temp, 'declined').allocation_order).toBe(7)
  })

  it('is a no-op when the reservation is not a live offer', () => {
    const approved = makeReservation({ status: 'approved' })
    expect(failOffer(approved, 'declined')).toEqual(approved)
  })
})
