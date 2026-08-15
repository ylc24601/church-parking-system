import { cronOrJobSecretValid, unauthorized } from '@/server/http/jobAuth'
import { purgeAuditLogs } from '@/server/services/auditRetentionService'

// Wave 2A-3 (#15) — scheduled audit_logs retention purge. Auth accepts EITHER
// `x-job-secret` OR a Vercel-Cron `Authorization: Bearer $CRON_SECRET`.
//
// Entry points default DIFFERENTLY, matching the binding-PII sweep:
//   * GET  = the scheduler entry point → defaults to APPLY (a cron hit exists to do
//     the work); `?dryRun=1|true` previews, `0|false` applies, any other value → 400.
//   * POST = the human/tooling entry point → defaults to DRY-RUN (a hand-typed request
//     that forgot a parameter must never trigger an irreversible audit deletion); only
//     an explicit boolean `false` applies, and a non-boolean `dryRun` → 400.
// Ambiguous dryRun values are ALWAYS a 400 — never silently resolved toward apply.
//
// Only `dryRun` and `max` are read. There is NO `now` / `retentionMonths` knob: the DB
// clock and env window are the sole authorities (a caller-supplied clock would let a
// job-secret holder wipe fresh audit rows early — 0034's central refusal).
// Responses are operation-safe: counts / retentionMonths / deletedBefore only. When an
// apply run leaves a backlog (`hasMore`), the response carries an explicit warning so a
// monitor can catch it instead of the backlog silently waiting a month.

async function handle(dryRun: boolean, max: number | undefined): Promise<Response> {
  if (max !== undefined && (!Number.isInteger(max) || max < 1 || max > 500)) {
    return Response.json({ ok: false, error: 'invalid max' }, { status: 400 })
  }
  try {
    const summary = await purgeAuditLogs({ dryRun, max })
    const warning =
      summary.dryRun === false && summary.hasMore
        ? 'backlog remains beyond this run — schedule another purge or raise the cadence'
        : undefined
    return Response.json({ ok: true, ...summary, ...(warning ? { warning } : {}) })
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

export async function GET(request: Request): Promise<Response> {
  if (!cronOrJobSecretValid(request)) return unauthorized()
  const url = new URL(request.url)

  const rawDryRun = url.searchParams.get('dryRun')
  let dryRun: boolean
  if (rawDryRun === null) dryRun = false // scheduler default: apply
  else if (rawDryRun === '1' || rawDryRun === 'true') dryRun = true
  else if (rawDryRun === '0' || rawDryRun === 'false') dryRun = false
  else return Response.json({ ok: false, error: 'invalid dryRun' }, { status: 400 })

  const rawMax = url.searchParams.get('max')
  const max = rawMax === null ? undefined : Number(rawMax)
  return handle(dryRun, max)
}

export async function POST(request: Request): Promise<Response> {
  if (!cronOrJobSecretValid(request)) return unauthorized()
  let body: unknown = null
  try {
    body = await request.json()
  } catch {
    body = null
  }
  const b = body as { dryRun?: unknown; max?: unknown } | null

  const rawDryRun = b?.dryRun
  if (rawDryRun !== undefined && typeof rawDryRun !== 'boolean') {
    return Response.json({ ok: false, error: 'invalid dryRun' }, { status: 400 })
  }
  // Human-path fail-safe: anything but an explicit boolean false stays a dry run.
  const dryRun = rawDryRun !== false

  const rawMax = b?.max
  if (rawMax !== undefined && typeof rawMax !== 'number') {
    return Response.json({ ok: false, error: 'invalid max' }, { status: 400 })
  }
  return handle(dryRun, rawMax as number | undefined)
}
