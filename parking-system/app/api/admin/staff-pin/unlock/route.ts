import { adminUnauthorized, getAdminSession } from '@/server/http/adminAuth'
import { adminInternalError, guardAdminPost } from '@/server/http/adminRequestGuard'
import { unlockStaffPin } from '@/server/services/staffPinAdminService'

// Phase 8 Slice 8 — clear the failure lockout on a managed Sunday's on-site PIN while
// KEEPING the existing PIN (the plaintext cannot be recovered, so nothing is returned
// to display). Same {eventId, sunday} double-check as the issue route.
const NO_STORE = { 'cache-control': 'no-store' }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SUNDAY_RE = /^\d{4}-\d{2}-\d{2}$/

export async function POST(request: Request): Promise<Response> {
  const guard = await guardAdminPost(request)
  if (!guard.ok) return guard.response
  const session = await getAdminSession()
  if (!session) return adminUnauthorized()

  const { eventId, sunday } = (guard.body ?? {}) as { eventId?: unknown; sunday?: unknown }
  if (typeof eventId !== 'string' || !UUID_RE.test(eventId) ||
      typeof sunday !== 'string' || !SUNDAY_RE.test(sunday)) {
    return Response.json({ ok: false, reason: 'invalid_request' }, { status: 400, headers: NO_STORE })
  }

  try {
    const res = await unlockStaffPin({ eventId, sunday })
    if (res.ok) return Response.json({ ok: true, eventId: res.eventId, sunday: res.sunday }, { headers: NO_STORE })
    const status = res.reason === 'event_not_found' || res.reason === 'no_pin' ? 404 : 400
    return Response.json({ ok: false, reason: res.reason }, { status, headers: NO_STORE })
  } catch (e) {
    console.error('admin staff-pin unlock error')
    void e
    return adminInternalError()
  }
}
