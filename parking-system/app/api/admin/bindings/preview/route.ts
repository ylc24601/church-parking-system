import { adminUnauthorized, getAdminSession } from '@/server/http/adminAuth'
import { adminInternalError, guardAdminPost } from '@/server/http/adminRequestGuard'
import { previewApproveBinding } from '@/server/services/bindingAdminService'

// Masked approval preview for one pending claim. The response is an EXPLICIT
// whitelist of the service's ApprovePreview: all masking already happened in the
// service; matchedUserId is deliberately dropped (a UUID adds nothing to a human
// review — the member-management slice may reintroduce it consciously).
const NO_STORE = { 'cache-control': 'no-store' }

const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(request: Request): Promise<Response> {
  const guard = await guardAdminPost(request)
  if (!guard.ok) return guard.response
  if (!(await getAdminSession())) return adminUnauthorized()

  const { pendingId } = (guard.body ?? {}) as { pendingId?: unknown }
  if (typeof pendingId !== 'string' || !UUID_FORMAT.test(pendingId)) {
    return Response.json({ ok: false, reason: 'invalid_request' }, { status: 400, headers: NO_STORE })
  }

  try {
    const p = await previewApproveBinding({ pendingId })
    return Response.json(
      {
        ok: true,
        preview: {
          found: p.found,
          pendingStatus: p.pendingStatus,
          claimSource: p.claimSource,
          claimVersion: p.claimVersion,
          lineUserIdMasked: p.lineUserIdMasked,
          submittedCodeMasked: p.submittedCodeMasked,
          claimedPhoneMasked: p.claimedPhoneMasked,
          claimedName: p.claimedName,
          matchedDisplayName: p.matchedDisplayName,
          wouldApprove: p.wouldApprove,
          reason: p.reason,
        },
      },
      { headers: NO_STORE },
    )
  } catch (e) {
    console.error('admin binding preview error', e)
    return adminInternalError()
  }
}
