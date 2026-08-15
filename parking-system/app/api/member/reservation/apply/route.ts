import { getMemberSession, memberUnauthorized } from '@/server/http/memberAuth'
import { applyForWeek } from '@/server/services/memberReservationService'

// Member apply for this week's parking (Phase 7 Slice 3). Session-gated; the event
// and the applicant come from the server (session + Taipei-today resolver), so the
// body carries only { vehicleId, requestedP2 }.
const NO_STORE = { 'cache-control': 'no-store' }

export async function POST(request: Request): Promise<Response> {
  const session = await getMemberSession()
  if (!session) return memberUnauthorized()

  let body: unknown = null
  try {
    body = await request.json()
  } catch {
    body = null
  }
  const input = (body ?? {}) as { vehicleId?: unknown; requestedP2?: unknown }

  const result = await applyForWeek({
    userId: session.userId,
    vehicleId: input.vehicleId,
    requestedP2: input.requestedP2,
  })

  if (result.ok) return Response.json({ ok: true }, { headers: NO_STORE })
  // Business states are expected member outcomes → 200 with the typed reason
  // (mirrors the login/claim routes); only a malformed request is a 400.
  const status = result.reason === 'invalid_request' ? 400 : 200
  return Response.json({ ok: false, reason: result.reason }, { status, headers: NO_STORE })
}
