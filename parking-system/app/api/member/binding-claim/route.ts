import { MemberAuthConfigError } from '@/server/services/memberAuthService'
import { submitBindingClaim } from '@/server/services/memberBindingService'

// LIFF binding claim (Phase 7 Slice 2). No session required — the claimant is unbound
// by definition; identity is re-verified on every call (liff: idToken / mock:
// mockLineUserId). NO membership oracle: success is the same response whether or not
// the phone matches a member. Request body / claim values are never logged.
const NO_STORE = { 'cache-control': 'no-store' }
const MAX_BODY_BYTES = 4096

export async function POST(request: Request): Promise<Response> {
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('application/json')) {
    return Response.json({ ok: false, reason: 'unsupported_media_type' }, { status: 415, headers: NO_STORE })
  }
  const declaredLength = Number(request.headers.get('content-length') ?? '0')
  if (declaredLength > MAX_BODY_BYTES) {
    return Response.json({ ok: false, reason: 'payload_too_large' }, { status: 413, headers: NO_STORE })
  }

  let body: unknown = null
  try {
    const raw = await request.text()
    // Measure UTF-8 BYTES, not UTF-16 code units — CJK text is ~3 bytes per .length unit,
    // so a char-count check would let ~12KB of Chinese through a "4KB" limit.
    if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
      return Response.json({ ok: false, reason: 'payload_too_large' }, { status: 413, headers: NO_STORE })
    }
    body = JSON.parse(raw)
  } catch {
    body = null
  }

  let result
  try {
    result = await submitBindingClaim(
      (body ?? {}) as { idToken?: unknown; mockLineUserId?: unknown; name?: unknown; phone?: unknown },
    )
  } catch (e) {
    if (e instanceof MemberAuthConfigError) {
      console.error(`binding claim config error: ${e.code}`)
      return Response.json({ ok: false, error: 'config' }, { status: 500, headers: NO_STORE })
    }
    throw e
  }

  if (result.ok) return Response.json({ ok: true }, { headers: NO_STORE })

  // line_account_already_bound is an expected state (the admin may have approved while
  // the member was filling the form) — 200 lets the UI auto-login.
  const status =
    result.reason === 'invalid_request' ? 400
    : result.reason === 'invalid_token' ? 401
    : result.reason === 'verify_unreachable' ? 503
    : 200
  return Response.json({ ok: false, reason: result.reason }, { status, headers: NO_STORE })
}
