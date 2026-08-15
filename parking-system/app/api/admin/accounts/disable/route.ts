import { can } from '@/lib/adminRoles'
import { adminForbidden, adminUnauthorized, getAdminSession } from '@/server/http/adminAuth'
import { adminInternalError, guardAdminPost } from '@/server/http/adminRequestGuard'
import { ADMIN_ACCOUNT_ACTION_STATUS, setAdminDisabled } from '@/server/services/adminAccountService'
import { adminActor, newRequestId } from '@/server/services/auditContext'

// Disable or re-enable another admin account. The actor is taken from the SESSION —
// any actingAdminId in the body is ignored. Self-target is refused (403) so an
// operator can never lock themselves out; the last active admin cannot be disabled
// (409) so the account list can never reach zero enabled admins via this route.
// Both directions revoke the target's sessions (see migration 0026 — this forces
// re-login even on re-enable, closing a stale-cookie-revival hazard).
//
// Audited (0030): the audit row is written inside the RPC's transaction, so a 500
// here means nothing changed. The 409 (last_active_superadmin) is a governance refusal
// and DOES leave an audit row — that path must stay a typed return rather than a
// raised error, or the rollback would erase the very record of the refusal.
//
// Superadmin-only (2C-1 / #19). The check below is the gate; the RPC re-derives the
// acting role in-transaction and refuses again, so this route being wrong is not enough
// to grant a clerk account management.
const NO_STORE = { 'cache-control': 'no-store' }

const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(request: Request): Promise<Response> {
  const guard = await guardAdminPost(request)
  if (!guard.ok) return guard.response
  const session = await getAdminSession()
  if (!session) return adminUnauthorized()
  if (!can(session.role, 'manage_admin_accounts')) return adminForbidden()

  const { targetId, disabled } = (guard.body ?? {}) as { targetId?: unknown; disabled?: unknown }
  if (typeof targetId !== 'string' || !UUID_FORMAT.test(targetId)) {
    return Response.json({ ok: false, reason: 'invalid_request' }, { status: 400, headers: NO_STORE })
  }
  if (typeof disabled !== 'boolean') {
    return Response.json({ ok: false, reason: 'invalid_request' }, { status: 400, headers: NO_STORE })
  }

  let result
  try {
    result = await setAdminDisabled({
      targetId,
      actor: adminActor(session),
      disabled,
      requestId: newRequestId(),
    })
  } catch (e) {
    console.error('admin account disable error')
    void e
    return adminInternalError()
  }

  if (result.ok) {
    return Response.json({ ok: true }, { headers: NO_STORE })
  }
  const status = ADMIN_ACCOUNT_ACTION_STATUS[result.reason]
  return Response.json({ ok: false, reason: result.reason }, { status, headers: NO_STORE })
}
