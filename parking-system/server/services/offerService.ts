import {
  buildReleaseDeadlines,
  buildSundayMidnight,
  computeReleaseDeadline,
} from '@/lib/allocation/release'
import { triggerSubstitution } from '@/lib/allocation/substitute'
import {
  createParkingRepository,
  type OutboxRow,
  type ParkingRepository,
  type SubstitutePayload,
} from '@/server/repositories/parkingRepository'
import { withNotificationContext } from './notification/context'
import { buildSubstitutePayloadAndOutbox, offerNextSpot } from './substitution'

export interface ResolveOfferSummary {
  outcome: 'confirmed' | 'declined'
  resolved: boolean
  // enforceExpiry only: the atomic write refused a lapsed offer (resolved=false).
  expiredBlocked: boolean
  substituteOffered: boolean
  substituteReservationId: string | null
}

// Confirm or decline a live (temp_approved) offer.
// - confirm → approved (stamps release_deadline_at).
// - decline → back to waiting (offer_status='declined'), and the freed spot is offered
//   to the NEXT candidate — never the just-declined row (kept in the exclusion set).
// - enforceExpiry (member path): the RPC's guarded UPDATE also requires
//   offer_expires_at > now — expiry check and state write share one statement /
//   one row lock. Ops callers omit it: Sunday-midnight auto-approve legitimately
//   confirms offers whose midnight-capped window has just lapsed.
export async function resolveOffer(
  params: { reservationId: string; action: 'confirm' | 'decline'; now?: Date; enforceExpiry?: boolean },
  repo: ParkingRepository = createParkingRepository(),
): Promise<ResolveOfferSummary> {
  const { reservationId, action, now = new Date(), enforceExpiry = false } = params
  const r = await repo.getReservation(reservationId)
  if (!r) throw new Error(`reservation ${reservationId} not found`)
  if (r.status !== 'temp_approved') {
    throw new Error(`offer not active for ${reservationId} (status '${r.status}')`)
  }

  const event = await repo.getWeeklyEvent(r.weekly_event_id)
  const deadlines = buildReleaseDeadlines(event.sunday_date)
  const sundayMidnight = buildSundayMidnight(event.sunday_date)

  if (action === 'confirm') {
    const releaseDeadline = computeReleaseDeadline(r, deadlines)
    const outbox: OutboxRow[] = await withNotificationContext(
      [
        {
          dedupe_key: `confirmed:${r.id}`,
          template_key: 'reservation_approved',
          user_id: r.user_id,
          reservation_id: r.id,
          payload: {},
        },
      ],
      { sundayDate: event.sunday_date, repo },
    )
    const res = await repo.applyOfferResolution({
      eventId: r.weekly_event_id,
      offerId: r.id,
      outcome: 'confirmed',
      nowIso: now.toISOString(),
      approved: { approved_at: now.toISOString(), release_deadline_at: releaseDeadline.toISOString() },
      next: null,
      outbox,
      expiryGuard: enforceExpiry,
    })
    return {
      outcome: 'confirmed',
      resolved: res.resolved > 0,
      expiredBlocked: res.expired_blocked,
      substituteOffered: false,
      substituteReservationId: null,
    }
  }

  // decline → exclude the just-declined row from any re-offer
  const excluded = new Set<string>([r.id])
  const waiting = await repo.getWaitingForSubstitution(r.weekly_event_id)
  const sub = triggerSubstitution(waiting.filter(w => !excluded.has(w.id)), now, sundayMidnight)

  let next: SubstitutePayload | null = null
  let nextOutbox: OutboxRow[] = []
  if (sub) {
    excluded.add(sub.reservation.id)
    const built = buildSubstitutePayloadAndOutbox(sub, now, deadlines)
    next = built.payload
    nextOutbox = await withNotificationContext(built.outbox, { sundayDate: event.sunday_date, repo })
  }

  const res = await repo.applyOfferResolution({
    eventId: r.weekly_event_id,
    offerId: r.id,
    outcome: 'declined',
    nowIso: now.toISOString(),
    approved: null,
    next,
    outbox: nextOutbox,
    expiryGuard: enforceExpiry,
  })

  if (res.resolved === 0) {
    return {
      outcome: 'declined',
      resolved: false,
      expiredBlocked: res.expired_blocked,
      substituteOffered: false,
      substituteReservationId: null,
    }
  }

  let offeredId: string | null = sub && res.next_applied > 0 ? sub.reservation.id : null
  if (sub && res.next_applied === 0) {
    // race: chosen next was taken; the decline already committed → offer-only retry
    offeredId = await offerNextSpot(
      repo, r.weekly_event_id, now, sundayMidnight, deadlines, excluded, event.sunday_date,
    )
  }
  return {
    outcome: 'declined',
    resolved: true,
    expiredBlocked: false,
    substituteOffered: !!offeredId,
    substituteReservationId: offeredId,
  }
}
