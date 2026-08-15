import { getStaffSession, staffUnauthorized } from '@/server/http/staffAuth'
import { requireWritableEvent } from '@/server/http/staffEventGuard'
import { createParkingRepository } from '@/server/repositories/parkingRepository'
import { requestMoveCar } from '@/server/services/moveCarService'

// Staff「請車主移車」— enqueue a LINE OA push asking a specific car's owner to move it.
// Bound to the PIN session's event (a session for event A can't notify event B's owner →
// 409). Owner resolution happens server-side; the response is a STAFF-SAFE DTO of flags only
// — never line_id / user_id / plate / message text. Enqueue-only: the dispatcher delivers.
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

    const result = await requestMoveCar({ reservationId, eventId: session.eventId }, repo)
    if (!result.queued) {
      return Response.json({ ok: false, error: result.reason }, { status: 422 })
    }
    return Response.json({ ok: true, queued: true })
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
