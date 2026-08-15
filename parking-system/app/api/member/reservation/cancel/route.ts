import { getMemberSession, memberUnauthorized } from '@/server/http/memberAuth'
import { cancelForWeek } from '@/server/services/memberReservationService'

// Member self-cancel for this week (Phase 7 Slice 3). No body: the server resolves
// the member's own reservation from the session — no id to tamper with. Wraps the
// shared cancellation service (approved → cancelled_late + substitution + the
// member's confirmation notice, all pre-existing).
const NO_STORE = { 'cache-control': 'no-store' }

export async function POST(): Promise<Response> {
  const session = await getMemberSession()
  if (!session) return memberUnauthorized()

  const result = await cancelForWeek({ userId: session.userId })
  if (result.ok) {
    return Response.json({ ok: true, cancelStatus: result.cancelStatus }, { headers: NO_STORE })
  }
  return Response.json({ ok: false, reason: result.reason }, { headers: NO_STORE })
}
