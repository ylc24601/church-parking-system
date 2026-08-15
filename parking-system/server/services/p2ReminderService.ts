import {
  createParkingRepository,
  type OutboxRow,
  type ParkingRepository,
} from '@/server/repositories/parkingRepository'
import { withNotificationContext } from './notification/context'

export interface P2ReminderSummary {
  enqueued: number
}

// 10:20 cron: remind approved P2 members who have not yet arrived to come (or reply
// 「正在路上」). Targets exclude anyone already on the way (p2_on_the_way=true) and the
// already-arrived (attended_at not null). Dedupe key is per reservation per event, so the
// sweep is safely repeatable (one reminder per P2 per Sunday).
export async function sendArrivalReminders(
  params: { eventId: string; now?: Date },
  repo: ParkingRepository = createParkingRepository(),
): Promise<P2ReminderSummary> {
  const { eventId } = params
  const event = await repo.getWeeklyEvent(eventId)
  const targets = await repo.getP2ArrivalReminderTargets(eventId)

  // sunday_date now comes from withNotificationContext (which also adds the plate), not from a
  // hand-written payload. The dedupe key still uses event.sunday_date directly — one reminder per
  // P2 per Sunday — and is deliberately untouched, so this change re-sends nothing.
  const rows: OutboxRow[] = await withNotificationContext(
    targets.map(t => ({
      dedupe_key: `p2_reminder:${t.id}:${event.sunday_date}`,
      template_key: 'p2_arrival_reminder' as const,
      user_id: t.user_id,
      reservation_id: t.id,
      payload: {},
    })),
    { sundayDate: event.sunday_date, repo },
  )

  const enqueued = await repo.enqueueOutbox(eventId, rows)
  return { enqueued }
}
