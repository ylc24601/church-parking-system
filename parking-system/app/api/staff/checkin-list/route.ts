import { getStaffSession, staffUnauthorized } from '@/server/http/staffAuth'
import { createParkingRepository } from '@/server/repositories/parkingRepository'

// Staff on-site check-in list. Reads ONLY staff_checkin_view (privacy-projected:
// no penalty / p2_reason / phone / raw priority). The event is bound by the PIN
// session — never a client-supplied id — so a session can only read its own event.
export async function GET(): Promise<Response> {
  const session = await getStaffSession()
  if (!session) return staffUnauthorized()

  try {
    const repo = createParkingRepository()
    const event = await repo.getWeeklyEvent(session.eventId)
    const rows = await repo.getStaffCheckInList(session.eventId)
    return Response.json({ ok: true, event, rows })
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
