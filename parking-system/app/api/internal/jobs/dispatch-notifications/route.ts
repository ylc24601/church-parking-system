import { cronOrJobSecretValid, unauthorized } from '@/server/http/jobAuth'
import { dispatchNotifications, previewDispatch } from '@/server/services/notificationDispatchService'

// Phase 4 Slice A/C — internal job that drains due notification_outbox rows to LINE.
// Auth accepts EITHER `x-job-secret` (manual / external scheduler) OR a Vercel-Cron
// `Authorization: Bearer $CRON_SECRET`. GET is used by Vercel Cron / most schedulers
// (query params); POST keeps the manual/CLI JSON-body path. `dryRun` returns a no-mutation
// preview. Responses are operation-safe: counts / notification-type names only — never
// line_id, user_id, plate, message body, or member/penalty detail.

interface Params {
  limit?: number
  dryRun: boolean
}

async function handle(request: Request, params: Params): Promise<Response> {
  const { limit, dryRun } = params
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    return Response.json({ ok: false, error: 'invalid limit' }, { status: 400 })
  }
  try {
    if (dryRun) {
      const preview = await previewDispatch({ limit })
      return Response.json({ ok: true, ...preview })
    }
    const summary = await dispatchNotifications({ limit })
    return Response.json({ ok: true, ...summary })
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

export async function GET(request: Request): Promise<Response> {
  if (!cronOrJobSecretValid(request)) return unauthorized()
  const url = new URL(request.url)
  const rawLimit = url.searchParams.get('limit')
  const limit = rawLimit === null ? undefined : Number(rawLimit)
  const dryRun = url.searchParams.get('dryRun') === '1' || url.searchParams.get('dryRun') === 'true'
  return handle(request, { limit, dryRun })
}

export async function POST(request: Request): Promise<Response> {
  if (!cronOrJobSecretValid(request)) return unauthorized()
  let body: unknown = null
  try {
    body = await request.json()
  } catch {
    body = null
  }
  const b = body as { limit?: number; dryRun?: boolean } | null
  return handle(request, { limit: b?.limit, dryRun: b?.dryRun === true })
}
