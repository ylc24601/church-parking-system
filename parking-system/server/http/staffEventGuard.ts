import type { ParkingRepository } from '@/server/repositories/parkingRepository'

// Phase 3 v2 — finalize guard. A finalized weekly_event is a terminal, read-only
// week: no further Staff writes (check-in / walk-in / settle). Returns a 409
// Response to short-circuit the route, or null when the event is still writable.
// Read routes (checkin-list / print) intentionally do NOT call this.
export async function requireWritableEvent(
  repo: ParkingRepository,
  eventId: string,
): Promise<Response | null> {
  const event = await repo.getWeeklyEvent(eventId)
  if (event.status === 'finalized') {
    return Response.json({ ok: false, error: 'event_finalized' }, { status: 409 })
  }
  return null
}
