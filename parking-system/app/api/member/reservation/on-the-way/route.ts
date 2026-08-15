import { getMemberSession, memberUnauthorized } from '@/server/http/memberAuth'
import { reportOnTheWay } from '@/server/services/memberReservationService'

// P2 member reports「正在路上」(Phase 7 Slice 4): extends this week's own approved
// reservation from the 10:45 deadline to the 10:55 grace. No body — the row is
// server-resolved from the session.
const NO_STORE = { 'cache-control': 'no-store' }

export async function POST(): Promise<Response> {
  const session = await getMemberSession()
  if (!session) return memberUnauthorized()

  const result = await reportOnTheWay({ userId: session.userId })
  if (result.ok) return Response.json({ ok: true }, { headers: NO_STORE })
  return Response.json({ ok: false, reason: result.reason }, { headers: NO_STORE })
}
