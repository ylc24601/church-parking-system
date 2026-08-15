import { releaseExpired } from '@/lib/allocation/release'
import {
  createParkingRepository,
  type OutboxRow,
  type ParkingRepository,
} from '@/server/repositories/parkingRepository'
import { getSundayDateForNotification, withNotificationContext } from './notification/context'

export interface ReleaseSummary {
  released: number
  broadcastEnqueued: number
  ownerNoticesEnqueued: number
}

// Sunday release sweep. Each approved reservation past its own release_deadline_at
// (P3=10:30, P2=10:30, P2 on-the-way=10:50) becomes released_late; when anything is
// released, every still-waiting user is broadcast the freed capacity AND each member
// whose own seat was released gets one informational notice. Idempotent: a re-run
// releases 0 rows (status guard) and enqueues nothing.
//
// `notifyReleasedOwners` (default true) can be turned off by the settlement pre-sweep:
// a row released at settlement time is immediately settled to no_show, and that pastoral
// path deliberately stays silent — so the owner notice is suppressed there.
export async function runRelease(
  params: { eventId: string; now?: Date; notifyReleasedOwners?: boolean },
  repo: ParkingRepository = createParkingRepository(),
): Promise<ReleaseSummary> {
  const { eventId, now = new Date(), notifyReleasedOwners = true } = params
  const nowIso = now.toISOString()

  const reservations = await repo.getReservationsForRelease(eventId)
  const result = releaseExpired(reservations, now)

  // The release itself needs no event — the deadline is already stamped on each row. So the only
  // reason to read one is the date in the message, and that must never be able to stop a release:
  // getSundayDateForNotification returns null on failure and the copy falls back to「本週」.
  // Skipped when nothing was released: every sweep after the first has no notice to decorate.
  const sundayDate =
    result.outbox.length > 0 ? await getSundayDateForNotification(eventId, repo) : null

  // Broadcast (one per waiting user). The dedupe key carries a per-sweep discriminator so
  // each release tier re-broadcasts, while a re-run at the same instant collides →
  // ON CONFLICT DO NOTHING (idempotent).
  const broadcast: OutboxRow[] = await withNotificationContext(
    result.outbox
      .filter(o => o.template_key === 'broadcast_release')
      .map(o => ({
        dedupe_key: `broadcast:${o.reservation_id}:${nowIso}`,
        template_key: o.template_key,
        user_id: o.user_id,
        reservation_id: o.reservation_id,
        payload: o.payload,
      })),
    { sundayDate, repo },
  )

  // Owner notices (one per member whose seat was released). Dedupe key has NO time bucket:
  // a reservation is released_late exactly once, so this guarantees at-most-one notice ever.
  // Suppressed entirely for the settlement pre-sweep (pastoral path stays silent).
  const ownerNotices: OutboxRow[] = await withNotificationContext(
    (notifyReleasedOwners ? result.outbox : [])
      .filter(o => o.template_key === 'reservation_released')
      .map(o => ({
        dedupe_key: `released_owner:${o.reservation_id}`,
        template_key: o.template_key,
        user_id: o.user_id,
        reservation_id: o.reservation_id,
        payload: o.payload,
      })),
    { sundayDate, repo },
  )

  const res = await repo.applyRelease(eventId, nowIso, broadcast, ownerNotices)
  return {
    released: res.released,
    broadcastEnqueued: res.outbox_enqueued,
    ownerNoticesEnqueued: res.owner_notices_enqueued,
  }
}
