import { can } from '@/lib/adminRoles'
import { adminForbidden, adminUnauthorized, getAdminSession } from '@/server/http/adminAuth'
import { adminInternalError, guardAdminPost } from '@/server/http/adminRequestGuard'
import { ADMIN_ACCOUNT_ACTION_STATUS, revokeAdminSessions } from '@/server/services/adminAccountService'
import { adminActor, newRequestId } from '@/server/services/auditContext'

// Force-log-out every device of another admin account without changing its
// disabled/password state. The actor comes from the SESSION; self-target is refused and
// the role is enforced inside the RPC. Superadmin-only (2C-1 / #19), and audited since
// Wave 2C-2 (0036) — it used to be a bare repository DELETE with no trail.
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
    result = await revokeAdminSessions({ targetId, actor: adminActor(session), requestId: newRequestId() })
  } catch (e) {
    console.error('admin account revoke-sessions error')
    void e
    return adminInternalError()
  }

  if (result.ok) {
    return Response.json({ ok: true, sessionsRevoked: result.sessionsRevoked }, { headers: NO_STORE })
  }
  const status = ADMIN_ACCOUNT_ACTION_STATUS[result.reason]
  return Response.json({ ok: false, reason: result.reason }, { status, headers: NO_STORE })
}
