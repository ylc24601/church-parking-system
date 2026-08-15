import { adminUnauthorized, getAdminSession } from '@/server/http/adminAuth'
import { adminInternalError, guardAdminPost } from '@/server/http/adminRequestGuard'
import { issueMemberBindingCode } from '@/server/services/memberAdminService'

// Issue a one-time binding code for a member (keyword fallback flow). The full code
// is returned ONCE for the operator to relay; it is never logged. createdBy is taken
// from the SESSION — any adminId/createdBy in the body is ignored.
const NO_STORE = { 'cache-control': 'no-store' }

const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_NOTE_CODEPOINTS = 200

export async function POST(request: Request): Promise<Response> {
  const guard = await guardAdminPost(request)
  if (!guard.ok) return guard.response
  const session = await getAdminSession()
  if (!session) return adminUnauthorized()

  const { userId, ttlDays, note } = (guard.body ?? {}) as {
    userId?: unknown
    ttlDays?: unknown
    note?: unknown
  }
  if (typeof userId !== 'string' || !UUID_FORMAT.test(userId)) {
    return Response.json({ ok: false, reason: 'invalid_request' }, { status: 400, headers: NO_STORE })
  }

  // ttlDays: optional; when present must be a safe integer in the service's window.
  let ttl: number | undefined
  if (ttlDays !== undefined) {
    if (typeof ttlDays !== 'number' || !Number.isSafeInteger(ttlDays) || ttlDays < 1 || ttlDays > 90) {
      return Response.json({ ok: false, reason: 'invalid_request' }, { status: 400, headers: NO_STORE })
    }
    ttl = ttlDays
  }

  // note: optional; null | string, trimmed-empty → null, ≤ 200 code points. Never logged.
  let cleanedNote: string | null = null
  if (note !== undefined && note !== null) {
    if (typeof note !== 'string') {
      return Response.json({ ok: false, reason: 'invalid_request' }, { status: 400, headers: NO_STORE })
    }
    const trimmed = note.trim()
    if ([...trimmed].length > MAX_NOTE_CODEPOINTS) {
      return Response.json({ ok: false, reason: 'invalid_request' }, { status: 400, headers: NO_STORE })
    }
    cleanedNote = trimmed === '' ? null : trimmed
  }

  let result
  try {
    result = await issueMemberBindingCode({
      userId,
      ttlDays: ttl,
      note: cleanedNote,
      createdBy: `admin:${session.username}`,
    })
  } catch (e) {
    console.error('admin binding-code issue error')
    void e
    return adminInternalError()
  }

  if (result.ok) {
    return Response.json(
      { ok: true, code: result.code, expiresAt: result.expiresAt, displayName: result.displayName },
      { headers: NO_STORE },
    )
  }
  // already_bound / member_not_found are expected states → 200 with the typed reason.
  return Response.json({ ok: false, reason: result.reason }, { headers: NO_STORE })
}
