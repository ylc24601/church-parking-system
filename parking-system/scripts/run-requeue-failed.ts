// MANUAL-ONLY dead-letter recovery (Phase 4 Slice F). Requeues terminal `failed` outbox rows back to
// `pending` AFTER the root cause (token/config/provider) is fixed. DRY-RUN BY DEFAULT — pass --apply
// to actually mutate. Only failed → pending; bounded batch; optional sanitized error filter.
// Aggregate-only output. DO NOT SCHEDULE this — it is a human-run recovery step.
//   npm run job:requeue-failed                      # dry run: how many WOULD requeue
//   npm run job:requeue-failed -- --apply           # actually requeue (default max 50, cap 500)
//   npm run job:requeue-failed -- --apply --max 100 --error terminal_403
try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may be provided by the shell instead */
}

import { requeueFailed } from '../server/services/requeueFailedService'

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag)
}
function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const dryRun = !hasFlag('--apply') // conservative default: dry run unless --apply
  const rawMax = argValue('--max')
  let max: number | undefined
  if (rawMax !== undefined) {
    const n = Number(rawMax)
    if (!Number.isInteger(n) || n < 1) {
      console.error(`invalid --max: ${rawMax} (must be a positive integer)`)
      process.exit(1)
    }
    max = n
  }
  const errorCode = argValue('--error')

  const summary = await requeueFailed({ dryRun, max, errorCode })
  console.log(JSON.stringify(summary, null, 2))
  if (summary.dryRun) {
    console.log('(dry run — re-run with --apply to requeue)')
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
