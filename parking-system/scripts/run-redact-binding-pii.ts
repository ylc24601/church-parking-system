// Binding PII retention sweep (Phase 8 Slice 7, binding-ops.md「PII 保留」). Clears
// claimed_phone / claimed_name / submitted_code on pending_binding rows decided
// (approved/rejected) at least BINDING_PII_RETENTION_DAYS (default 90, floor 30) ago.
// DRY-RUN BY DEFAULT — pass --apply to actually clear. The scheduled entry point is
// GET /api/internal/jobs/redact-binding-pii (applies by default); this CLI is the
// conservative human path for previews and first manual runs.
// There is deliberately NO time-override flag: an arbitrary future "now" would bypass
// the retention window exactly like a shortened retentionDays. Tests inject `now` at
// the service layer; live verification backdates seeded rows instead.
//   npm run job:redact-binding-pii                    # dry run: how many WOULD be cleared
//   npm run job:redact-binding-pii -- --apply         # actually clear (default max 200, cap 500)
//   npm run job:redact-binding-pii -- --apply --max 500
try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may be provided by the shell instead */
}

import { redactBindingPii } from '../server/services/bindingPiiRetentionService'

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
    if (!Number.isInteger(n) || n < 1 || n > 500) {
      console.error(`invalid --max: ${rawMax} (must be an integer between 1 and 500)`)
      process.exit(1)
    }
    max = n
  }

  const summary = await redactBindingPii({ dryRun, max })
  console.log(JSON.stringify(summary, null, 2))
  if (summary.dryRun) {
    console.log('(dry run — re-run with --apply to clear)')
    if (summary.hasMore) {
      console.log('(more matching rows exist beyond this batch — further runs needed)')
    }
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
