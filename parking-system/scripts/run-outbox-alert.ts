// Local dev / ops health alert for notification_outbox (Phase 4 Slice F).
// Evaluates outbox_health against thresholds; prints the operation-safe verdict and EXITS NON-ZERO
// when unhealthy (crontab / monitor friendly). Aggregate-only — no per-row / member data. No mutation.
//   npm run job:outbox-alert
//   npm run job:outbox-alert -- --now 2099-06-01T03:00:00Z   (testing: override "now")
try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may be provided by the shell instead */
}

import { getOutboxAlert } from '../server/services/outboxAlertService'

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function resolveNowArg(): Date | undefined {
  const raw = argValue('--now')
  if (raw === undefined) return undefined
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) {
    console.error(`invalid --now: ${raw} (must be an ISO date-time)`)
    process.exit(1)
  }
  return d
}

async function main() {
  const now = resolveNowArg()
  const alert = await getOutboxAlert({ now })
  console.log(JSON.stringify(alert, null, 2))
  if (!alert.healthy) process.exit(1) // surface the alert to the caller (cron / monitor)
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
