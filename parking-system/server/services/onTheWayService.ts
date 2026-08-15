import { buildReleaseDeadlines, computeReleaseDeadline } from '@/lib/allocation/release'
import { createParkingRepository, type ParkingRepository } from '@/server/repositories/parkingRepository'

export interface OnTheWaySummary {
  updated: boolean
}

// P2 replies「正在路上」: extend the release deadline from 10:30 to the 10:50 grace.
// Only valid while the spot is still held — an unattended, approved P2 whose current
// deadline has NOT yet passed (now <= release_deadline_at). A click at 10:31 (after a
// delayed 10:30 release would have applied) is a no-op, not a retroactive extension.
export async function markOnTheWay(
  params: { reservationId: string; now?: Date },
  repo: ParkingRepository = createParkingRepository(),
): Promise<OnTheWaySummary> {
  const { reservationId, now = new Date() } = params
  const r = await repo.getReservation(reservationId)
  if (!r) throw new Error(`reservation ${reservationId} not found`)

  // TS pre-check mirrors the SQL guard (the DB guard is authoritative against races).
  const eligible =
    r.status === 'approved' &&
    r.effective_priority === 2 &&
    r.attended_at === null &&
    r.p2_on_the_way === false &&
    r.release_deadline_at !== null &&
    now <= r.release_deadline_at
  if (!eligible) return { updated: false }

  const event = await repo.getWeeklyEvent(r.weekly_event_id)
  const deadlines = buildReleaseDeadlines(event.sunday_date)
  const graceDeadline = computeReleaseDeadline({ effective_priority: 2, p2_on_the_way: true }, deadlines)

  const rows = await repo.setOnTheWay(r.id, now.toISOString(), graceDeadline.toISOString())
  return { updated: rows > 0 }
}
