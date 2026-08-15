import { adminUnauthorized, getAdminSession } from '@/server/http/adminAuth'
import { adminInternalError, guardAdminPost } from '@/server/http/adminRequestGuard'
import { adminActor, newRequestId } from '@/server/services/auditContext'
import {
  MEMBER_MAINTENANCE_STATUS,
  updateMemberIdentity,
} from '@/server/services/memberMaintenanceService'

// Change a member's name and/or phone (Tier 0-2 / 0038).
//
// The member is addressed by userId. There is no "look up by old phone" variant and there
// must not be: re-importing a member whose phone changed used to create a SECOND users.id
// holding none of their bindings, history or eligibility — that is the bug this slice
// exists to remove, and it starts with treating the phone as an attribute, not a key.
//
// A phone change also rejects that member's outstanding LINE binding claims. The count
// comes back in the response because the operator has to tell the member to re-submit —
// it is a consequence of their action, not a statistic.
const NO_STORE = { 'cache-control': 'no-store' }

const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function badRequest(): Response {
  return Response.json({ ok: false, reason: 'invalid_request' }, { status: 400, headers: NO_STORE })
}

export async function POST(request: Request): Promise<Response> {
  const guard = await guardAdminPost(request)
  if (!guard.ok) return guard.response
  const session = await getAdminSession()
  if (!session) return adminUnauthorized()

  const { userId, displayName, phone } = (guard.body ?? {}) as {
    userId?: unknown
    displayName?: unknown
    phone?: unknown
  }
  if (typeof userId !== 'string' || !UUID_FORMAT.test(userId)) return badRequest()
  // Shape only — the name/phone RULES live in the RPC (one authority, see the create route).
  if (typeof displayName !== 'string' || typeof phone !== 'string') return badRequest()

  let result
  try {
    result = await updateMemberIdentity({
      userId,
      displayName,
      phone,
      actor: adminActor(session),
      requestId: newRequestId(),
    })
  } catch (e) {
    console.error('admin member identity error')
    void e
    return adminInternalError()
  }

  if (result.ok) {
    return Response.json(
      { ok: true, changed: result.changed, bindingsInvalidated: result.bindingsInvalidated },
      { headers: NO_STORE },
    )
  }
  return Response.json(
    { ok: false, reason: result.reason },
    { status: MEMBER_MAINTENANCE_STATUS[result.reason], headers: NO_STORE },
  )
}
