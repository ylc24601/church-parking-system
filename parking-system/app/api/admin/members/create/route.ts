import { adminUnauthorized, getAdminSession } from '@/server/http/adminAuth'
import { adminInternalError, guardAdminPost } from '@/server/http/adminRequestGuard'
import { adminActor, newRequestId } from '@/server/services/auditContext'
import { createMember, MEMBER_MAINTENANCE_STATUS } from '@/server/services/memberMaintenanceService'

// Create ONE member by hand (Tier 0-2 / 0038). Until this slice the only way to add a
// member was a one-row CSV.
//
// NO capability check beyond "is an admin": a 幹事 can already bulk-import the entire
// roster and read every member's PII, so gating single-member creation behind
// superadmin would be theatre — see lib/adminRoles.ts on why "what everyone can do"
// gets no entry. The RPC still reads the acting account itself and refuses a disabled one.
//
// Validation here is SHAPE ONLY (is it a string? is the array an array of uuids?). What
// counts as a valid name or phone is decided by the RPC, deliberately: the CSV import
// answers the same question, and two copies of the rule would drift.
const NO_STORE = { 'cache-control': 'no-store' }

const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// A confirmation list longer than this is not a decision anybody made deliberately. The
// cap is generous — it exists to bound the array, not to constrain real use.
const MAX_CONFIRMED = 50

function badRequest(): Response {
  return Response.json({ ok: false, reason: 'invalid_request' }, { status: 400, headers: NO_STORE })
}

export async function POST(request: Request): Promise<Response> {
  const guard = await guardAdminPost(request)
  if (!guard.ok) return guard.response
  const session = await getAdminSession()
  if (!session) return adminUnauthorized()

  const { displayName, phone, confirmedCandidateIds } = (guard.body ?? {}) as {
    displayName?: unknown
    phone?: unknown
    confirmedCandidateIds?: unknown
  }
  if (typeof displayName !== 'string' || typeof phone !== 'string') return badRequest()

  // null/absent and [] mean different things (see the service): "not shown the homonyms
  // yet" vs. "shown them, and they are different people". Absent normalises to null;
  // an array must be an array of uuids, and stays an array even when empty.
  let confirmed: string[] | null = null
  if (confirmedCandidateIds !== undefined && confirmedCandidateIds !== null) {
    if (!Array.isArray(confirmedCandidateIds) || confirmedCandidateIds.length > MAX_CONFIRMED) {
      return badRequest()
    }
    if (!confirmedCandidateIds.every(v => typeof v === 'string' && UUID_FORMAT.test(v))) {
      return badRequest()
    }
    confirmed = confirmedCandidateIds as string[]
  }

  let result
  try {
    result = await createMember(
      {
        displayName,
        phone,
        confirmedCandidateIds: confirmed,
        actor: adminActor(session),
        requestId: newRequestId(),
      },
    )
  } catch (e) {
    // Never echo the error: the body carried a member's name and phone.
    console.error('admin member create error')
    void e
    return adminInternalError()
  }

  if (result.ok) {
    return Response.json({ ok: true, userId: result.userId }, { headers: NO_STORE })
  }
  // `candidates` rides along on the homonym reasons — the client re-renders the
  // confirmation step from THIS list, never from the one it was already showing.
  return Response.json(
    { ok: false, reason: result.reason, candidates: result.candidates },
    { status: MEMBER_MAINTENANCE_STATUS[result.reason], headers: NO_STORE },
  )
}
