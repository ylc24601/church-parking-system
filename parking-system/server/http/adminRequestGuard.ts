// ── Shared request hardening for Admin POST routes (Phase 8 Slice 1) ─────────
// Same input boundary the public LIFF claim route established (see
// app/api/member/binding-claim/route.ts), plus an Origin guard: admin routes are
// cookie-authenticated state changers, so a present-but-foreign Origin is refused
// (403). An ABSENT Origin passes — non-browser clients don't carry ambient cookies
// (no CSRF surface), while browser POSTs always send it.
// Request bodies are never logged here or downstream.

const NO_STORE = { 'cache-control': 'no-store' }
const MAX_BODY_BYTES = 4096

export type AdminPostGuardResult =
  | { ok: true; body: unknown }
  | { ok: false; response: Response }

// Origin-only guard for body-less admin POSTs (logout). Null = pass.
export function guardAdminOrigin(request: Request): Response | null {
  const origin = request.headers.get('origin')
  if (origin !== null && origin.toLowerCase() !== new URL(request.url).origin.toLowerCase()) {
    return Response.json({ ok: false, reason: 'bad_origin' }, { status: 403, headers: NO_STORE })
  }
  return null
}

export async function guardAdminPost(request: Request): Promise<AdminPostGuardResult> {
  const originRefusal = guardAdminOrigin(request)
  if (originRefusal) return { ok: false, response: originRefusal }

  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('application/json')) {
    return refuse('unsupported_media_type', 415)
  }
  const declaredLength = Number(request.headers.get('content-length') ?? '0')
  if (declaredLength > MAX_BODY_BYTES) {
    return refuse('payload_too_large', 413)
  }

  let raw: string
  try {
    raw = await request.text()
  } catch {
    return refuse('invalid_request', 400)
  }
  // UTF-8 BYTES, not UTF-16 code units — CJK is ~3 bytes per .length unit.
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    return refuse('payload_too_large', 413)
  }

  try {
    return { ok: true, body: JSON.parse(raw) }
  } catch {
    return refuse('invalid_request', 400)
  }
}

function refuse(reason: string, status: number): AdminPostGuardResult {
  return {
    ok: false,
    response: Response.json({ ok: false, reason }, { status, headers: NO_STORE }),
  }
}

// Generic 500 for unexpected service throws: no error message, no PII.
export function adminInternalError(): Response {
  return Response.json(
    { ok: false, error: 'internal' },
    { status: 500, headers: NO_STORE },
  )
}
