import { can } from '@/lib/adminRoles'
import { adminForbidden, adminUnauthorized, getAdminSession } from '@/server/http/adminAuth'
import { adminInternalError, guardAdminPost } from '@/server/http/adminRequestGuard'
import { ADMIN_ACCOUNT_ACTION_STATUS, resetAdminPassword } from '@/server/services/adminAccountService'
import { adminActor, newRequestId } from '@/server/services/auditContext'

// Reset another admin's password to a freshly generated random value. The full
// plaintext password is returned ONCE for the operator to relay — it is never
// logged. actingAdminId is taken from the SESSION — any actingAdminId/username/
// passwordHash in the body is ignored. Self-reset is refused (403): this is a
// peer-reset-only flow. The reset RPC (migration 0026) atomically revokes every
// existing session for the target, so they must sign in again with the new
// password; disabled_at is left untouched (a disabled account stays disabled).
//
// Superadmin-only and audited on BOTH paths since 0035 — a refusal logged but a real
// credential reset silent would be worse than no record at all. The plaintext password
// is in the response and nowhere else: not in the audit metadata, not in any log.
const NO_STORE = { 'cache-control': 'no-store' }

const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(request: Request): Promise<Response> {
  const guard = await guardAdminPost(request)
  if (!guard.ok) return guard.response
  const session = await getAdminSession()
  if (!session) return adminUnauthorized()
  if (!can(session.role, 'manage_admin_accounts')) return adminForbidden()

  const { targetId } = (guard.body ?? {}) as { targetId?: unknown }
  if (typeof targetId !== 'string' || !UUID_FORMAT.test(targetId)) {
    return Response.json({ ok: false, reason: 'invalid_request' }, { status: 400, headers: NO_STORE })
  }

  let result
  try {
    result = await resetAdminPassword({
      targetId,
      actor: adminActor(session),
      requestId: newRequestId(),
    })
  } catch (e) {
    console.error('admin account reset-password error')
    void e
    return adminInternalError()
  }

  if (result.ok) {
    return Response.json(
      { ok: true, username: result.username, password: result.password, disabled: result.disabled },
      { headers: NO_STORE },
    )
  }
  const status = ADMIN_ACCOUNT_ACTION_STATUS[result.reason]
  return Response.json({ ok: false, reason: result.reason }, { status, headers: NO_STORE })
}
