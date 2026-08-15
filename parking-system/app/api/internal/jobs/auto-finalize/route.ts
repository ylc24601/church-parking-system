import { jobSecretValid, unauthorized } from '@/server/http/jobAuth'
import { autoFinalizeStaleEvents } from '@/server/services/autoFinalizeService'

// Operational fallback (behind the job secret, not a Staff route): finalize past weeks that
// were left 'open' because Staff forgot to「結束當週點名」. Optional body { graceDays } lets
// ops override the window; per-event failures are reported in results (not a 500) so a cron
// isn't hard-failed by one bad week. Response stays finalize-focused — no penalty/pastoral/
// member/vehicle detail.
export async function POST(request: Request): Promise<Response> {
  if (!jobSecretValid(request.headers.get('x-job-secret'))) return unauthorized()

  let body: unknown = null
  try {
    body = await request.json()
  } catch {
    body = null
  }
  const graceDays = (body as { graceDays?: number } | null)?.graceDays
  if (graceDays !== undefined && (!Number.isInteger(graceDays) || graceDays < 1)) {
    return Response.json({ ok: false, error: 'invalid graceDays' }, { status: 400 })
  }

  try {
    const summary = await autoFinalizeStaleEvents({ graceDays })
    return Response.json({ ok: true, ...summary })
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
