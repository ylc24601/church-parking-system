import {
  STAFF_CHECKIN_STATUSES,
  createParkingRepository,
  type ParkingRepository,
} from '@/server/repositories/parkingRepository'

// Phase 4 Slice B — Staff asks a specific car's owner to move it. Resolves the owner
// server-side (never exposing line_id/user_id to Staff) and ENQUEUES a move_car_request
// outbox row; the Slice A dispatcher delivers it over the church LINE OA.
//
// Not notifiable → a walk-in (no member owner), a member without a bound line_id, or a
// non-actionable status. Enqueue-only: near-real-time delivery depends on the scheduled
// dispatcher (a later ops slice); until then `npm run job:dispatch` drains the outbox.

export type MoveCarResult = { queued: true } | { queued: false; reason: 'not_notifiable' }

export async function requestMoveCar(
  params: { reservationId: string; eventId: string; now?: Date },
  repo: ParkingRepository = createParkingRepository(),
): Promise<MoveCarResult> {
  const { reservationId, eventId, now = new Date() } = params

  const target = await repo.getMoveCarTarget(reservationId)
  if (!target) throw new Error(`reservation ${reservationId} not found`)

  // Bind to the caller's PIN-session event: a session for event A must not notify event B's
  // reservation owner (mirrors attendanceService.checkIn's guard).
  if (target.weekly_event_id !== eventId) throw new Error('wrong_event')

  // Only rows the Staff list actually shows are actionable; and only members with a line_id.
  const actionable = (STAFF_CHECKIN_STATUSES as readonly string[]).includes(target.status)
  if (!actionable || !target.user_id || !target.notifiable) {
    return { queued: false, reason: 'not_notifiable' }
  }

  // Same-minute bucket: accidental double-taps collapse to one outbox row (ON CONFLICT DO
  // NOTHING), a genuine re-request a minute later enqueues a fresh notification.
  const minute = now.toISOString().slice(0, 16) // YYYY-MM-DDTHH:MM
  await repo.enqueueOutbox(eventId, [
    {
      dedupe_key: `move_car:${reservationId}:${minute}`,
      template_key: 'move_car_request',
      user_id: target.user_id,
      reservation_id: reservationId,
      payload: { license_plate: target.license_plate },
    },
  ])
  // A dedupe collapse (enqueueOutbox reports 0 inserted) is an idempotent SUCCESS.
  return { queued: true }
}
