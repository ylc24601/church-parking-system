import type {
  AutoApproveResult,
  NotificationOutboxEntry,
  Reservation,
  SubstituteResult,
} from '@/lib/types'
import { OFFER_CONFIRM_WINDOW_MS } from './rules'

// Triggered when an approved or temp_approved reservation is cancelled.
//
// - now < sundayMidnight  →  temp_approved with 2-hour confirm window
//                            (offer_expires_at = MIN(now + 2h, sundayMidnight))
// - now >= sundayMidnight →  direct approved (instant-approval regime)
//
// Returns null if no one is on the waiting list.
export function triggerSubstitution(
  waitingList: Reservation[],  // must already be sorted by waiting rank
  now: Date,
  sundayMidnight: Date,
): SubstituteResult | null {
  const next = waitingList.find(r => r.status === 'waiting')
  if (!next) return null

  const outbox: NotificationOutboxEntry[] = []

  if (now >= sundayMidnight) {
    outbox.push({
      user_id: next.user_id,
      reservation_id: next.id,
      template_key: 'reservation_approved',
      payload: { direct: true },
    })
    return {
      reservation: { ...next, status: 'approved', offer_expires_at: null },
      outbox,
    }
  }

  const windowEnd = new Date(now.getTime() + OFFER_CONFIRM_WINDOW_MS)
  const offerExpiresAt = windowEnd < sundayMidnight ? windowEnd : sundayMidnight

  outbox.push({
    user_id: next.user_id,
    reservation_id: next.id,
    template_key: 'offer_2hr_confirm',
    payload: { expires_at: offerExpiresAt.toISOString() },
  })

  return {
    reservation: { ...next, status: 'temp_approved', offer_expires_at: offerExpiresAt },
    outbox,
  }
}

// An offer (temp_approved) failed — the 2-hour window expired or the candidate
// declined. The reservation reverts to `waiting`, records the outcome in
// `offer_status`, and clears `offer_expires_at`. `allocation_order` is preserved
// untouched so the candidate keeps their original waiting rank for the next round.
//
// No-op if the reservation is not currently a live offer (`temp_approved`).
export function failOffer(
  reservation: Reservation,
  outcome: 'expired' | 'declined',
): Reservation {
  if (reservation.status !== 'temp_approved') return reservation
  return {
    ...reservation,
    status: 'waiting',
    offer_status: outcome,
    offer_expires_at: null,
  }
}

// Sunday 00:00 sweep: auto-upgrade any lingering temp_approved → approved.
// This handles the Sat 23:xx edge case where the 2-hour window straddles midnight.
export function autoApproveTempApproved(
  reservations: Reservation[],
  now: Date,
  sundayMidnight: Date,
): AutoApproveResult {
  if (now < sundayMidnight) {
    return { reservations, outbox: [] }
  }

  const outbox: NotificationOutboxEntry[] = []
  const updated = reservations.map(r => {
    if (r.status !== 'temp_approved') return r

    outbox.push({
      user_id: r.user_id,
      reservation_id: r.id,
      template_key: 'offer_auto_approved',
      payload: {},
    })
    return { ...r, status: 'approved' as const, offer_expires_at: null }
  })

  return { reservations: updated, outbox }
}
