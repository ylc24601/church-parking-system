import { cronOrJobSecretValid, unauthorized } from '@/server/http/jobAuth'
import { getOutboxHealth } from '@/server/services/outboxHealthService'

// Phase 4 Slice C — operational visibility into notification_outbox (failed / retrying /
// stuck rows). Same auth as the dispatcher (x-job-secret OR Vercel-Cron bearer). Response is
// operation-safe: counts / notification-type names / sanitized error codes / timestamps only.
export async function GET(request: Request): Promise<Response> {
  if (!cronOrJobSecretValid(request)) return unauthorized()
  try {
    const health = await getOutboxHealth()
    return Response.json({ ok: true, ...health })
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
