import { cronOrJobSecretValid, unauthorized } from '@/server/http/jobAuth'
import { ensureUpcomingWeeklyEvent } from '@/server/services/ensureWeeklyEventService'

// Phase 9 Slice 1 — idempotent daily job (00:01 Taipei): create the upcoming Sunday's
// weekly_event if missing. The request body is deliberately IGNORED: the scheduler
// always targets the Taipei-calendar upcoming Sunday, and pre-creating a specific week
// is a manual operation (npm run job:ensure-event -- --sunday <date>), not something a
// static scheduler payload may steer. Accepts x-job-secret or the Vercel-Cron Bearer
// header (future Pro path), like the other schedulable routes.
export async function POST(request: Request): Promise<Response> {
  if (!cronOrJobSecretValid(request)) return unauthorized()

  try {
    const summary = await ensureUpcomingWeeklyEvent()
    return Response.json({ ok: true, ...summary })
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
