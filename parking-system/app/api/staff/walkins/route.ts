import { getStaffSession, staffUnauthorized } from '@/server/http/staffAuth'
import { requireWritableEvent } from '@/server/http/staffEventGuard'
import { createParkingRepository } from '@/server/repositories/parkingRepository'
import { registerWalkIn } from '@/server/services/walkInService'

// Staff walk-in registration. Binds to the PIN session's event. Returns a
// STAFF-SAFE DTO: only the StaffCheckInRow whitelist — never the raw reservation row.
export async function POST(request: Request): Promise<Response> {
  const session = await getStaffSession()
  if (!session) return staffUnauthorized()

  let body: unknown = null
  try {
    body = await request.json()
  } catch {
    body = null
  }
  const b = body as { license_plate?: string; walk_in_name?: string } | null
  const plate = b?.license_plate?.trim()
  if (!plate) {
    return Response.json({ ok: false, error: 'license_plate is required' }, { status: 400 })
  }

  try {
    const repo = createParkingRepository()
    const blocked = await requireWritableEvent(repo, session.eventId)
    if (blocked) return blocked

    const result = await registerWalkIn(
      { eventId: session.eventId, plate, name: b?.walk_in_name },
      repo,
    )
    if (!result.created) {
      return Response.json({ ok: false, error: 'duplicate' }, { status: 409 })
    }
    return Response.json({ ok: true, row: result.row })
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
