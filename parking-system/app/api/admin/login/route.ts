import { getAdminSession, setAdminSession } from '@/server/http/adminAuth'
import { adminInternalError, guardAdminPost } from '@/server/http/adminRequestGuard'
import { loginAdmin } from '@/server/services/adminAuthService'

// Admin login. Anti-enumeration posture: `invalid` AND `locked` both surface as
// 401 `invalid` (a distinct 423 would tell an attacker the username exists and
// that five wrong guesses DoS'd it); the typed `locked` stays service-side.
// Credentials are never logged.
const NO_STORE = { 'cache-control': 'no-store' }

export async function POST(request: Request): Promise<Response> {
  const guard = await guardAdminPost(request)
  if (!guard.ok) return guard.response

  // Idempotent: a device that already holds a live session doesn't mint another row.
  if (await getAdminSession()) {
    return Response.json({ ok: true }, { headers: NO_STORE })
  }

  const { username, password } = (guard.body ?? {}) as { username?: unknown; password?: unknown }
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return Response.json({ ok: false, reason: 'invalid_request' }, { status: 400, headers: NO_STORE })
  }

  let result
  try {
    result = await loginAdmin({ username, password })
  } catch (e) {
    // e.g. session row creation failed — the account state is safe (failures were
    // already reset), but the login did NOT complete and no cookie may be set.
    console.error('admin login error', e)
    return adminInternalError()
  }

  if (result.ok) {
    await setAdminSession(result.token)
    return Response.json({ ok: true }, { headers: NO_STORE })
  }
  return Response.json({ ok: false, reason: 'invalid' }, { status: 401, headers: NO_STORE })
}
