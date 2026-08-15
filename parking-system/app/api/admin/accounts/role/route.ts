import { isAdminRole } from '@/lib/adminAccountInput'
import { can } from '@/lib/adminRoles'
import { adminForbidden, adminUnauthorized, getAdminSession } from '@/server/http/adminAuth'
import { adminInternalError, guardAdminPost } from '@/server/http/adminRequestGuard'
import { ADMIN_ACCOUNT_ACTION_STATUS, setAdminRole } from '@/server/services/adminAccountService'
import { adminActor, newRequestId } from '@/server/services/auditContext'

// Change another operator's tier (Wave 2C-2 / #19). The actor comes from the SESSION;
// self-target (both self-promotion and self-demotion) is refused and audited inside the
// RPC. Superadmin-only. A same-role request is an inert no-op the RPC reports as
// changed:false — no audit row, no session revoke.
const NO_STORE = { 'cache-control': 'no-store' }

const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function badRequest(): Response {
  return Response.json({ ok: false, reason: 'invalid_request' }, { status: 400, headers: NO_STORE })
}

export async function POST(request: Request): Promise<Response> {
  const guard = await guardAdminPost(request)
  if (!guard.ok) return guard.response
  const session = await getAdminSession()
  if (!session) return adminUnauthorized()
  if (!can(session.role, 'manage_admin_accounts')) return adminForbidden()

  const { targetId, role } = (guard.body ?? {}) as { targetId?: unknown; role?: unknown }
  if (typeof targetId !== 'string' || !UUID_FORMAT.test(targetId)) return badRequest()
  if (!isAdminRole(role)) return badRequest()

  let result
  try {
    result = await setAdminRole({ targetId, role, actor: adminActor(session), requestId: newRequestId() })
  } catch (e) {
    console.error('admin account role error')
    void e
    return adminInternalError()
  }

  if (result.ok) {
    return Response.json({ ok: true, changed: result.changed, role: result.role }, { headers: NO_STORE })
  }
  const status = ADMIN_ACCOUNT_ACTION_STATUS[result.reason]
  return Response.json({ ok: false, reason: result.reason }, { status, headers: NO_STORE })
}
