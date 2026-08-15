import { verifyLineSignature } from '@/server/http/lineSignature'
import { processWebhookEvents } from '@/server/services/pendingBindingService'

// Phase 5A — LINE Messaging API webhook. Capture-only: verify the signature, record any pending
// binding claim, return 200. It NEVER replies, pushes, broadcasts, or writes users.line_id, so it
// is safe to point at the production OA during the dry-run (see docs/go-live-readiness.md).
//
// Auth is the LINE signature (HMAC over the RAW body), not the job secret — LINE, not our
// scheduler, calls this. Node runtime is required for node:crypto and for reading the raw body
// before any JSON parse. Responses carry counts only — never userId, code, or message text.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  // Read the raw body FIRST — the HMAC must be computed over the exact bytes LINE signed.
  const raw = await request.text()
  const signature = request.headers.get('x-line-signature')

  if (!verifyLineSignature(raw, signature, process.env.LINE_CHANNEL_SECRET)) {
    // Bad/absent signature → reject and write nothing.
    return Response.json({ ok: false, error: 'invalid signature' }, { status: 401 })
  }

  // Signature is valid. Parse + process defensively so a malformed or unsupported payload still
  // returns 200 (LINE retries non-2xx) and never throws.
  try {
    let body: unknown = null
    try {
      body = JSON.parse(raw)
    } catch {
      body = null
    }
    const summary = await processWebhookEvents(body, new Date().toISOString())
    return Response.json({ ok: true, ...summary })
  } catch {
    // Never leak internals; a processing error must not turn into a retry storm.
    return Response.json({ ok: true }, { status: 200 })
  }
}
