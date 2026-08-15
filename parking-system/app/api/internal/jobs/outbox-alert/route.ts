import { cronOrJobSecretValid, unauthorized } from '@/server/http/jobAuth'
import { getOutboxAlert } from '@/server/services/outboxAlertService'

// Phase 4 Slice F — scheduler-surfaced health alert. Same auth as the dispatcher (x-job-secret OR
// Vercel-Cron bearer). The verdict is encoded in the HTTP status so a dumb external monitor/cron can
// alert with zero integration: 200 when healthy, 503 when a threshold is breached. Body is
// operation-safe: healthy flag / breach reason codes / threshold names / counts / a timestamp only.
export async function GET(request: Request): Promise<Response> {
  if (!cronOrJobSecretValid(request)) return unauthorized()
  try {
    const alert = await getOutboxAlert()
    return Response.json({ ok: true, ...alert }, { status: alert.healthy ? 200 : 503 })
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
