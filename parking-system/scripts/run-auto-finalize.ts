// Local dev / ops entry point for the auto-finalize fallback (mirrors run-settle.ts).
// Scans past weekly_events still 'open' and settles + finalizes each.
//   npm run job:auto-finalize
//   npm run job:auto-finalize -- --grace-days 3
//   npm run job:auto-finalize -- --now 2099-06-01T03:00:00Z   (testing: override "now")
try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may be provided by the shell instead */
}

import { autoFinalizeStaleEvents } from '../server/services/autoFinalizeService'

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function resolveGraceDaysArg(): number | undefined {
  const raw = argValue('--grace-days')
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) fail(`invalid --grace-days: ${raw} (must be an integer >= 1)`)
  return n
}

function resolveNowArg(): Date | undefined {
  const raw = argValue('--now')
  if (raw === undefined) return undefined
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) fail(`invalid --now: ${raw} (must be an ISO date-time)`)
  return d
}

async function main() {
  const graceDays = resolveGraceDaysArg()
  const now = resolveNowArg()
  const summary = await autoFinalizeStaleEvents({ graceDays, now })
  console.log(JSON.stringify(summary, null, 2))
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
