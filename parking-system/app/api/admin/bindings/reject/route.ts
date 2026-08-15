import { adminUnauthorized, getAdminSession } from '@/server/http/adminAuth'
import { adminInternalError, guardAdminPost } from '@/server/http/adminRequestGuard'
import { rejectBinding } from '@/server/services/bindingAdminService'

// Reject a pending claim with an operator reason. The reason is stored VERBATIM as
// audit (UI warns: no names / phones / codes / LINE ids) and is bounded to 200 code
// points here, in the service, and by the 0025 DB constraint.
const NO_STORE = { 'cache-control': 'no-store' }

const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_REASON_CODEPOINTS = 200

export async function POST(request: Request): Promise<Response> {
  const guard = await guardAdminPost(request)
  if (!guard.ok) return guard.response
  const session = await getAdminSession()
  if (!session) return adminUnauthorized()

  const { pendingId, reason } = (guard.body ?? {}) as { pendingId?: unknown; reason?: unknown }
  if (typeof pendingId !== 'string' || !UUID_FORMAT.test(pendingId)) {
    return Response.json({ ok: false, reason: 'invalid_request' }, { status: 400, headers: NO_STORE })
  }
  const trimmed = typeof reason === 'string' ? reason.trim() : ''
  if (trimmed.length === 0 || [...trimmed].length > MAX_REASON_CODEPOINTS) {
    return Response.json({ ok: false, reason: 'invalid_request' }, { status: 400, headers: NO_STORE })
  }

  let result
  try {
    result = await rejectBinding({ pendingId, reason: trimmed, adminId: session.adminId })
  } catch (e) {
    console.error('admin binding reject error', e)
    return adminInternalError()
  }

  if (result.rejected === 1) {
    return Response.json({ ok: true, reason: 'rejected' }, { headers: NO_STORE })
  }
  const status = result.reason === 'pending_not_found' ? 404 : 409 // pending_not_pending
  return Response.json({ ok: false, reason: result.reason }, { status, headers: NO_STORE })
}
