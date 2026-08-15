import { getMemberSession, memberUnauthorized } from '@/server/http/memberAuth'
import { resolveOfferForWeek } from '@/server/services/memberReservationService'

// Member responds to their substitution offer (Phase 7 Slice 4). Session-gated; the
// offer row is the member's own for this week (server-resolved — no id in the body).
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
  const action = (body as { action?: unknown } | null)?.action
  if (action !== 'confirm' && action !== 'decline') {
    return Response.json({ ok: false, reason: 'invalid_request' }, { status: 400, headers: NO_STORE })
  }

  const result = await resolveOfferForWeek({ userId: session.userId, action })
  if (result.ok) return Response.json({ ok: true, outcome: result.outcome }, { headers: NO_STORE })
  return Response.json({ ok: false, reason: result.reason }, { headers: NO_STORE })
}
