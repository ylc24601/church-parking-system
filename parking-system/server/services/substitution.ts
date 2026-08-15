import { computeReleaseDeadline, type ReleaseDeadlines } from '@/lib/allocation/release'
import { triggerSubstitution } from '@/lib/allocation/substitute'
import type { SubstituteResult } from '@/lib/types'
import type {
  OutboxRow,
  ParkingRepository,
  SubstitutePayload,
} from '@/server/repositories/parkingRepository'
import { withNotificationContext } from './notification/context'

const MAX_OFFER_ATTEMPTS = 50

// Map a triggerSubstitution result into the RPC payload + outbox rows.
// - temp_approved offer: last_offer_at = now (the per-offer dedupe discriminator).
// - direct approved (after midnight): stamp approved_at = now and release_deadline_at.
export function buildSubstitutePayloadAndOutbox(
  sub: SubstituteResult,
  now: Date,
  deadlines: ReleaseDeadlines,
): { payload: SubstitutePayload; outbox: OutboxRow[] } {
  const r = sub.reservation
  const nowIso = now.toISOString()
  const isApproved = r.status === 'approved'

  const payload: SubstitutePayload = {
    id: r.id,
    status: isApproved ? 'approved' : 'temp_approved',
    offer_expires_at: r.offer_expires_at ? r.offer_expires_at.toISOString() : null,
    last_offer_at: isApproved ? null : nowIso,
    approved_at: isApproved ? nowIso : null,
    release_deadline_at: isApproved ? computeReleaseDeadline(r, deadlines).toISOString() : null,
  }

  const outbox: OutboxRow[] = sub.outbox.map(e => ({
    dedupe_key: dedupeKey(e.template_key, e.reservation_id, nowIso),
    template_key: e.template_key,
    user_id: e.user_id,
    reservation_id: e.reservation_id,
    payload: e.payload,
  }))

  return { payload, outbox }
}

function dedupeKey(template: string, reservationId: string | null, nowIso: string): string {
  if (template === 'offer_2hr_confirm') return `offer:${reservationId}:${nowIso}`
  if (template === 'reservation_approved') return `approved:${reservationId}:${nowIso}`
  return `${template}:${reservationId}`
}

// Offer a freed spot to the next eligible waiting candidate, retrying down the list
// when a chosen candidate is taken by a concurrent op. `excluded` MUST already contain
// any just-resolved offer id (it reverts to `waiting` and must not be re-offered) plus
// every candidate already attempted. Returns the offered reservation id, or null.
// `sundayDate` is only used to stamp the offer notification (the week it is for); every caller
// already derived `deadlines`/`sundayMidnight` from the same event, so it costs no extra read.
export async function offerNextSpot(
  repo: ParkingRepository,
  eventId: string,
  now: Date,
  sundayMidnight: Date,
  deadlines: ReleaseDeadlines,
  excluded: Set<string>,
  sundayDate: string,
): Promise<string | null> {
  for (let i = 0; i < MAX_OFFER_ATTEMPTS; i++) {
    const waiting = await repo.getWaitingForSubstitution(eventId)
    const candidates = waiting.filter(w => !excluded.has(w.id))
    const sub = triggerSubstitution(candidates, now, sundayMidnight)
    if (!sub) return null

    excluded.add(sub.reservation.id)
    const { payload, outbox: rawOutbox } = buildSubstitutePayloadAndOutbox(sub, now, deadlines)
    const outbox = await withNotificationContext(rawOutbox, { sundayDate, repo })
    const res = await repo.applyOffer(eventId, payload, outbox)
    if (res.offered > 0) return sub.reservation.id
    // lost the race for this candidate → loop; it's now excluded
  }
  return null
}
