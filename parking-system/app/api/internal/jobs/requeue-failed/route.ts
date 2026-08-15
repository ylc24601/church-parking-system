import { cronOrJobSecretValid, unauthorized } from '@/server/http/jobAuth'
import { requeueFailed } from '@/server/services/requeueFailedService'

// Phase 4 Slice F — MANUAL-ONLY dead-letter recovery (must never be scheduled). Requeues terminal
// `failed` outbox rows back to `pending` AFTER a root cause is fixed. POST-only (it mutates), same
// auth as the dispatcher. `dryRun` DEFAULTS TO true — only an explicit `dryRun:false` mutates. Body
// is operation-safe counts only.
export async function POST(request: Request): Promise<Response> {
  if (!cronOrJobSecretValid(request)) return unauthorized()

  let body: unknown = null
  try {
    body = await request.json()
  } catch {
    body = null
  }
  const b = body as { dryRun?: boolean; max?: number; errorCode?: string } | null

  if (b?.max !== undefined && (!Number.isInteger(b.max) || b.max < 1)) {
    return Response.json({ ok: false, error: 'invalid max (positive integer)' }, { status: 400 })
  }

  // Fail-safe: anything other than an explicit `false` stays a dry run.
  const dryRun = b?.dryRun !== false

  try {
    const summary = await requeueFailed({ dryRun, max: b?.max, errorCode: b?.errorCode })
    return Response.json({ ok: true, ...summary })
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
