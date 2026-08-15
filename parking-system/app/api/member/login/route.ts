import { getMemberSession, setMemberSession } from '@/server/http/memberAuth'
import { MemberAuthConfigError, loginMember } from '@/server/services/memberAuthService'

// Member LIFF login. liff mode expects { idToken } (verified against LINE's verify
// endpoint); mock mode expects { mockLineUserId } (local dev/tests only — production
// fails fast, see resolveMemberAuthMode). Session material must never be cached.
const NO_STORE = { 'cache-control': 'no-store' }

export async function POST(request: Request): Promise<Response> {
  // Idempotent: a device that already holds a live session doesn't mint another row.
  if (await getMemberSession()) {
    return Response.json({ ok: true }, { headers: NO_STORE })
  }

  let body: unknown = null
  try {
    body = await request.json()
  } catch {
    body = null
  }

  let result
  try {
    result = await loginMember((body ?? {}) as { idToken?: unknown; mockLineUserId?: unknown })
  } catch (e) {
    if (e instanceof MemberAuthConfigError) {
      // Server-side misconfiguration. The code carries no token/userId, but the
      // client still only gets a generic marker.
      console.error(`member login config error: ${e.code}`)
      return Response.json({ ok: false, error: 'config' }, { status: 500, headers: NO_STORE })
    }
    throw e
  }

  if (result.ok) {
    await setMemberSession(result.token)
    return Response.json({ ok: true }, { headers: NO_STORE })
  }

  // not_bound is an expected member state (binding is admin-approved), not an auth
  // failure — 200 lets the UI branch on the typed reason.
  const status =
    result.reason === 'invalid_request' ? 400
    : result.reason === 'invalid_token' ? 401
    : result.reason === 'verify_unreachable' ? 503
    : 200
  return Response.json({ ok: false, reason: result.reason }, { status, headers: NO_STORE })
}
