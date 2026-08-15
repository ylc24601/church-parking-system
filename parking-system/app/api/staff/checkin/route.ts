import { getStaffSession, staffUnauthorized } from '@/server/http/staffAuth'
import { requireWritableEvent } from '@/server/http/staffEventGuard'
import { createParkingRepository } from '@/server/repositories/parkingRepository'
import { checkIn } from '@/server/services/attendanceService'

// Staff one-tap check-in / late back-fill. Reuses attendanceService.checkIn:
// approved → attended (on time) or attended_after_release (past deadline);
// released_late → attended_after_release. Idempotent (already-attended → attended:false).
//
// Bound to the PIN session's event: a session for event A cannot check in event B's
// reservation (checkIn throws 'wrong_event' → 409). Returns a STAFF-SAFE DTO: only
// { attended, status }. `penaltyUpdated` and any penalty/pastoral detail are NOT exposed.
export async function POST(request: Request): Promise<Response> {
  const session = await getStaffSession()
  if (!session) return staffUnauthorized()

  let body: unknown = null
  try {
    body = await request.json()
  } catch {
    body = null
  }
  const reservationId = (body as { reservationId?: string } | null)?.reservationId
  if (!reservationId) {
    return Response.json({ ok: false, error: 'reservationId is required' }, { status: 400 })
  }

  try {
    const repo = createParkingRepository()
    const blocked = await requireWritableEvent(repo, session.eventId)
    if (blocked) return blocked

    const summary = await checkIn({ reservationId, eventId: session.eventId }, repo)
    return Response.json({ ok: true, attended: summary.attended, status: summary.status })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message === 'wrong_event') {
      return Response.json({ ok: false, error: 'wrong_event' }, { status: 409 })
    }
    if (message.includes('not found')) {
      return Response.json({ ok: false, error: 'not_found' }, { status: 404 })
    }
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
}
