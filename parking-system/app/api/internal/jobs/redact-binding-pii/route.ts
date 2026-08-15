import { cronOrJobSecretValid, unauthorized } from '@/server/http/jobAuth'
import { redactBindingPii } from '@/server/services/bindingPiiRetentionService'

// Phase 8 Slice 7 — scheduled binding-PII retention sweep (binding-ops.md「PII 保留」).
// Auth accepts EITHER `x-job-secret` OR a Vercel-Cron `Authorization: Bearer $CRON_SECRET`.
//
// The two entry points deliberately default DIFFERENTLY:
//   * GET  = the scheduler entry point → defaults to APPLY (a cron hit exists to do the
//     work); `?dryRun=1|true` previews, `0|false` applies, any other value → 400.
//   * POST = the human/tooling entry point → defaults to DRY-RUN (a hand-typed request
//     that forgot a parameter must never trigger an irreversible PII deletion); only an
//     explicit boolean `false` applies, and a non-boolean `dryRun` → 400. This matches
//     the CLI's dry-run-by-default / --apply posture.
// Ambiguous dryRun values are ALWAYS a 400 — never silently resolved toward apply.
//
// Only `dryRun` and `max` are read; a smuggled `now` / `retentionDays` is ignored
// entirely (the window is env-only and `now` is always server current time — either
// knob would let a job-secret holder shorten the retention window).
// Responses are operation-safe: counts / retentionDays / cutoff timestamp only.

async function handle(dryRun: boolean, max: number | undefined): Promise<Response> {
  if (max !== undefined && (!Number.isInteger(max) || max < 1 || max > 500)) {
    return Response.json({ ok: false, error: 'invalid max' }, { status: 400 })
  }
  try {
    const summary = await redactBindingPii({ dryRun, max })
    return Response.json({ ok: true, ...summary })
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
