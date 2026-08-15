import { adminUnauthorized, getAdminSession } from '@/server/http/adminAuth'
import { adminInternalError, guardAdminPost } from '@/server/http/adminRequestGuard'
import { issueStaffPin } from '@/server/services/staffPinAdminService'

// Phase 8 Slice 8 — generate-and-replace the shared on-site PIN for a managed Sunday
// (current or next, Taipei calendar). The client submits the {eventId, sunday} pair it
// SAW; the service re-verifies both against each other and against the managed window
// (single source of truth in lib/staffPinSchedule — this route never computes dates).
// The response carries the plaintext PIN exactly once (no-store, never logged); expiry
// is entirely server-computed — no ttl/expiry/now is accepted from the body.
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
    const res = await issueStaffPin({ eventId, sunday, adminId: session.adminId })
    if (res.ok) {
      return Response.json(
        { ok: true, pin: res.pin, eventId: res.eventId, sunday: res.sunday, expiresAt: res.expiresAt },
        { headers: NO_STORE },
      )
    }
    const status = res.reason === 'event_not_found' ? 404 : 400
    return Response.json({ ok: false, reason: res.reason }, { status, headers: NO_STORE })
  } catch (e) {
    console.error('admin staff-pin issue error')
    void e
    return adminInternalError()
  }
}
