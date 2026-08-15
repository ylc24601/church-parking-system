import { buildReleaseDeadlines, buildSundayMidnight } from '@/lib/allocation/release'
import { triggerSubstitution } from '@/lib/allocation/substitute'
import {
  createParkingRepository,
  type OutboxRow,
  type ParkingRepository,
  type SubstitutePayload,
} from '@/server/repositories/parkingRepository'
import { withNotificationContext } from './notification/context'
import { buildSubstitutePayloadAndOutbox, offerNextSpot } from './substitution'

export interface ExpireOffersSummary {
  expired: number
  offered: number
}

// Cron sweep: expire genuinely-timed-out offers (offer_expires_at <= now AND strictly
// before Sunday midnight — midnight-capped offers belong to the auto-approve sweep) and
// roll each freed spot to the next candidate, never re-offering the just-expired row.
export async function expireOffers(
  params: { eventId: string; now?: Date },
  repo: ParkingRepository = createParkingRepository(),
): Promise<ExpireOffersSummary> {
  const { eventId, now = new Date() } = params
  const event = await repo.getWeeklyEvent(eventId)
  const deadlines = buildReleaseDeadlines(event.sunday_date)
  const sundayMidnight = buildSundayMidnight(event.sunday_date)

  const expired = await repo.getExpiredOffers(eventId, now.toISOString(), sundayMidnight.toISOString())

  let expiredCount = 0
  let offeredCount = 0
  for (const offer of expired) {
    const excluded = new Set<string>([offer.id])
    const waiting = await repo.getWaitingForSubstitution(eventId)
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
      eventId,
      offerId: offer.id,
      outcome: 'expired',
      nowIso: now.toISOString(),
      approved: null,
      next,
      outbox: nextOutbox,
    })

    if (res.resolved === 0) continue // already resolved / not due — skip
    expiredCount++
    if (sub && res.next_applied > 0) {
      offeredCount++
    } else if (sub && res.next_applied === 0) {
      const offeredId = await offerNextSpot(
        repo, eventId, now, sundayMidnight, deadlines, excluded, event.sunday_date,
      )
      if (offeredId) offeredCount++
    }
  }

  return { expired: expiredCount, offered: offeredCount }
}
