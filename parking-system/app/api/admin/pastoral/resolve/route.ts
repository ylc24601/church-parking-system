import { adminUnauthorized, getAdminSession } from '@/server/http/adminAuth'
import { adminInternalError, guardAdminPost } from '@/server/http/adminRequestGuard'
import { resolvePastoralAlert } from '@/server/services/pastoralAlertService'

// Phase 8 Slice 8 — resolve a pastoral-care alert (sensitive surface: admin session
// only). Only { alertId, note, resetCounter } are read from the body; the resolving
// admin's identity comes from the session alone (a smuggled adminId is ignored) and
// `now` is always server time. Typed outcomes keep the HTTP semantics honest:
// resolved → 200, already_resolved → 409, not_found → 404 — never ok:true for a
// resolution that did not happen. The note is never logged.
const NO_STORE = { 'cache-control': 'no-store' }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NOTE_MAX_CODE_POINTS = 200

export async function POST(request: Request): Promise<Response> {
  const guard = await guardAdminPost(request)
  if (!guard.ok) return guard.response
  const session = await getAdminSession()
  if (!session) return adminUnauthorized()

  const { alertId, note, resetCounter } = (guard.body ?? {}) as {
    alertId?: unknown
    note?: unknown
    resetCounter?: unknown
  }

  if (typeof alertId !== 'string' || !UUID_RE.test(alertId)) {
    return Response.json({ ok: false, reason: 'invalid_request' }, { status: 400, headers: NO_STORE })
  }
  // note: optional; string only, bounded in code points (emoji/CJK count as 1).
  if (note !== undefined && note !== null) {
    if (typeof note !== 'string' || [...note.trim()].length > NOTE_MAX_CODE_POINTS) {
      return Response.json({ ok: false, reason: 'invalid_request' }, { status: 400, headers: NO_STORE })
    }
  }
  // resetCounter: optional; boolean only. Fail-safe default false — a forgotten flag
  // must never reset a member's counter.
  if (resetCounter !== undefined && typeof resetCounter !== 'boolean') {
    return Response.json({ ok: false, reason: 'invalid_request' }, { status: 400, headers: NO_STORE })
  }

  try {
    const res = await resolvePastoralAlert({
      alertId,
      adminId: session.adminId,
      note: (note as string | null | undefined) ?? null,
      resetCounter: resetCounter === true,
    })
    if (res.ok) return Response.json({ ok: true, counterReset: res.counterReset }, { headers: NO_STORE })
    const status = res.reason === 'not_found' ? 404 : 409
    return Response.json({ ok: false, reason: res.reason }, { status, headers: NO_STORE })
  } catch (e) {
    console.error('admin pastoral resolve error')
    void e
    return adminInternalError()
  }
}
