import { adminUnauthorized, getAdminSession } from '@/server/http/adminAuth'
import { adminInternalError, guardAdminPost } from '@/server/http/adminRequestGuard'
import { applyApproveBinding } from '@/server/services/bindingAdminService'

// Apply an approval the admin just previewed. claimVersion is the preview's
// superseded_count revision — the RPC refuses (`pending_changed`) if the claim was
// re-submitted since, so nothing can be approved sight-unseen. The decider is the
// SESSION's admin id; any adminId-like field in the body is ignored.
const NO_STORE = { 'cache-control': 'no-store' }

const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Expected review outcomes render as guidance in the UI → 200 with the typed reason.
//
// 'phone_not_found' and 'unmatched_at_capture' are the SAME outcome under two names: 0038
// renamed it when approval stopped re-resolving claimed_phone and started reading the
// match frozen at capture. Both stay listed — the old name is what a not-yet-migrated DB
// returns, and dropping it would turn a normal review outcome into a 500 during the window
// between deploying this app and running the migration.
const REVIEW_OUTCOMES = new Set([
  'code_not_found', 'code_expired', 'code_consumed',
  'phone_not_found', 'unmatched_at_capture', 'member_already_bound', 'line_id_taken',
])

export async function POST(request: Request): Promise<Response> {
  const guard = await guardAdminPost(request)
  if (!guard.ok) return guard.response
  const session = await getAdminSession()
  if (!session) return adminUnauthorized()

  const { pendingId, claimVersion } = (guard.body ?? {}) as {
    pendingId?: unknown
    claimVersion?: unknown
  }
  if (typeof pendingId !== 'string' || !UUID_FORMAT.test(pendingId)) {
    return Response.json({ ok: false, reason: 'invalid_request' }, { status: 400, headers: NO_STORE })
  }
  // 0 is a valid revision. superseded_count is a DB bigint — beyond the JS safe
  // range a JSON number silently loses precision, so refuse it at the boundary.
  if (typeof claimVersion !== 'number' || !Number.isSafeInteger(claimVersion) || claimVersion < 0) {
    return Response.json({ ok: false, reason: 'invalid_request' }, { status: 400, headers: NO_STORE })
  }

  let result
  try {
    result = await applyApproveBinding({
      pendingId,
      expectedSupersededCount: claimVersion,
      adminId: session.adminId,
    })
  } catch (e) {
    console.error('admin binding approve error', e)
    return adminInternalError()
  }

  if (result.approved === 1) {
    return Response.json({ ok: true, reason: 'approved' }, { headers: NO_STORE })
  }
  const status =
    result.reason === 'pending_not_found' ? 404
    : result.reason === 'pending_not_pending' || result.reason === 'pending_changed' ? 409
    : REVIEW_OUTCOMES.has(result.reason) ? 200
    : 500
  if (status === 500) {
    console.error(`admin binding approve: unexpected reason ${result.reason}`)
    return adminInternalError()
  }
  return Response.json({ ok: false, reason: result.reason }, { status, headers: NO_STORE })
}
