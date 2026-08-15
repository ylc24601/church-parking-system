import { isAdminRole, normalizeAdminDisplayName, normalizeAdminUsername } from '@/lib/adminAccountInput'
import { can } from '@/lib/adminRoles'
import { adminForbidden, adminUnauthorized, getAdminSession } from '@/server/http/adminAuth'
import { adminInternalError, guardAdminPost } from '@/server/http/adminRequestGuard'
import { ADMIN_ACCOUNT_ACTION_STATUS, createAdmin } from '@/server/services/adminAccountService'
import { adminActor, newRequestId } from '@/server/services/auditContext'

// Provision another operator (Wave 2C-2 / #19). The actor and its role come from the
// SESSION; the password is server-generated and returned ONCE. Superadmin-only, enforced
// here and again inside the RPC. Input is validated at the edge (400) so a bad username /
// display name / role never reaches the DB as a raised 500 — the DB's own username check
// and unique index remain the final authority.
//
// no-store because the success response carries the one-time plaintext password.
const NO_STORE = { 'cache-control': 'no-store' }

function badRequest(): Response {
  return Response.json({ ok: false, reason: 'invalid_request' }, { status: 400, headers: NO_STORE })
}

export async function POST(request: Request): Promise<Response> {
  const guard = await guardAdminPost(request)
  if (!guard.ok) return guard.response
  const session = await getAdminSession()
  if (!session) return adminUnauthorized()
  if (!can(session.role, 'manage_admin_accounts')) return adminForbidden()

  const { username, displayName, role } = (guard.body ?? {}) as {
    username?: unknown; displayName?: unknown; role?: unknown
  }
  // No `as AdminRole` — an unknown role is a 400, not a cast past the type system.
  if (!isAdminRole(role)) return badRequest()
  const normalizedUsername = normalizeAdminUsername(username)
  if (normalizedUsername === null) return badRequest()
  const name = normalizeAdminDisplayName(displayName)
  if (!name.ok) return badRequest()

  let result
  try {
    result = await createAdmin({
      username: normalizedUsername,
      displayName: name.value,
      role,
      actor: adminActor(session),
      requestId: newRequestId(),
    })
  } catch (e) {
    console.error('admin account create error')
    void e
    return adminInternalError()
  }

  if (result.ok) {
    return Response.json({ ok: true, account: result.account, password: result.password }, { headers: NO_STORE })
  }
  const status = ADMIN_ACCOUNT_ACTION_STATUS[result.reason]
  return Response.json({ ok: false, reason: result.reason }, { status, headers: NO_STORE })
}
