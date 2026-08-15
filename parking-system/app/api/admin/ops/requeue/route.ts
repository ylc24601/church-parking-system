import { can } from '@/lib/adminRoles'
import { adminForbidden, adminUnauthorized, getAdminSession } from '@/server/http/adminAuth'
import { adminInternalError, guardAdminPost } from '@/server/http/adminRequestGuard'
import { requeueFailed } from '@/server/services/requeueFailedService'

// Admin-facing dead-letter recovery (Phase 8 Slice 6): requeue terminal `failed`
// notification rows back to `pending` AFTER the root cause is fixed. Same conservative
// posture as the internal job route, now behind an admin session: dryRun is fail-safe
// (anything but an explicit `false` stays a dry run), max is strictly 1..500, and only
// { dryRun, max, errorCode } are read from the body — any adminId/now/status is ignored.
//
// Superadmin-only (2C-1 / #19): this replays real notifications to real members, and
// judging whether the root cause is actually fixed is a maintenance call, not a 幹事 one.
const NO_STORE = { 'cache-control': 'no-store' }

const ERROR_CODE_FORMAT = /^[a-z0-9][a-z0-9_.:-]{0,99}$/i

export async function POST(request: Request): Promise<Response> {
  const guard = await guardAdminPost(request)
  if (!guard.ok) return guard.response
  const session = await getAdminSession()
  if (!session) return adminUnauthorized()
  if (!can(session.role, 'view_ops')) return adminForbidden()

  const { dryRun, max, errorCode } = (guard.body ?? {}) as {
    dryRun?: unknown
    max?: unknown
    errorCode?: unknown
  }

  // max: optional; when present must be a plain integer in [1, 500] — reject rather than
  // let the service silently clamp, so the API contract matches the UI's stated range.
  if (max !== undefined && (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > 500)) {
    return Response.json({ ok: false, reason: 'invalid_request' }, { status: 400, headers: NO_STORE })
  }

  // dryRun: optional; if present must be a boolean (so `"false"` can't read as a 200
  // dry-run and mislead the caller). Fail-safe: only an explicit `false` mutates.
  if (dryRun !== undefined && typeof dryRun !== 'boolean') {
    return Response.json({ ok: false, reason: 'invalid_request' }, { status: 400, headers: NO_STORE })
  }
  const effectiveDryRun = dryRun !== false

  // errorCode: optional; string only, trimmed-empty → all failed, else a sanitized code.
  let code: string | null = null
  if (errorCode !== undefined && errorCode !== null) {
    if (typeof errorCode !== 'string') {
      return Response.json({ ok: false, reason: 'invalid_request' }, { status: 400, headers: NO_STORE })
    }
    const trimmed = errorCode.trim()
    if (trimmed !== '') {
      if (!ERROR_CODE_FORMAT.test(trimmed)) {
        return Response.json({ ok: false, reason: 'invalid_request' }, { status: 400, headers: NO_STORE })
      }
      code = trimmed
    }
  }

  try {
    const summary = await requeueFailed({
      dryRun: effectiveDryRun,
      max: max as number | undefined,
      errorCode: code,
    })
    return Response.json({ ok: true, ...summary }, { headers: NO_STORE })
  } catch (e) {
    console.error('admin ops requeue error')
    void e
    return adminInternalError()
  }
}
