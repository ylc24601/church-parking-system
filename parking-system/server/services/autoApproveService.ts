import {
  buildReleaseDeadlines,
  buildSundayMidnight,
  computeReleaseDeadline,
} from '@/lib/allocation/release'
import { createParkingRepository, type ParkingRepository } from '@/server/repositories/parkingRepository'
import { withNotificationContext } from './notification/context'

export interface AutoApproveSummary {
  approved: number
}

// Sunday 00:00 sweep: any temp_approved offer still lingering at/after midnight (its
// confirm window was capped at midnight) is auto-upgraded to approved, stamping
// release_deadline_at. No-op before midnight. Idempotent via the temp_approved guard
// inside apply_offer_resolution('confirmed').
export async function autoApproveTemp(
  params: { eventId: string; now?: Date },
  repo: ParkingRepository = createParkingRepository(),
): Promise<AutoApproveSummary> {
  const { eventId, now = new Date() } = params
  const event = await repo.getWeeklyEvent(eventId)
  const sundayMidnight = buildSundayMidnight(event.sunday_date)
  if (now < sundayMidnight) return { approved: 0 }

  const deadlines = buildReleaseDeadlines(event.sunday_date)
  const temp = await repo.getTempApproved(eventId)

  // Enrich the whole sweep's notices in ONE pass before the per-row RPCs: doing it inside the
  // loop would issue a plate lookup per reservation.
  const notices = await withNotificationContext(
    temp.map(r => ({
      dedupe_key: `auto_approved:${r.id}`,
      template_key: 'offer_auto_approved' as const,
      user_id: r.user_id,
      reservation_id: r.id,
      payload: {},
    })),
    { sundayDate: event.sunday_date, repo },
  )
  const noticeFor = new Map(notices.map(n => [n.reservation_id, n]))

  let approved = 0
  for (const r of temp) {
    const releaseDeadline = computeReleaseDeadline(r, deadlines)
    const res = await repo.applyOfferResolution({
      eventId,
      offerId: r.id,
      outcome: 'confirmed',
      nowIso: now.toISOString(),
      approved: { approved_at: now.toISOString(), release_deadline_at: releaseDeadline.toISOString() },
      next: null,
      outbox: [noticeFor.get(r.id)!],
    })
    if (res.resolved > 0) approved++
  }

  return { approved }
}
