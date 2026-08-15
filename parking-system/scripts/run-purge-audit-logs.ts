// Audit retention purge (Wave 2A-3, #15). Deletes audit_logs rows older than
// AUDIT_RETENTION_MONTHS (default 24, floor 24), keeping audit.substrate_enabled and
// audit.retention_purge forever. DRY-RUN BY DEFAULT — pass --apply to actually delete.
// The scheduled entry point is GET /api/internal/jobs/purge-audit-logs (applies by
// default); this CLI is the conservative human path for previews and first manual runs.
// There is deliberately NO time / window override flag: the DB clock and env window are
// the sole authorities (a caller-supplied "now" would bypass the retention window).
//   npm run job:purge-audit-logs                 # dry run: how many WOULD be deleted
//   npm run job:purge-audit-logs -- --apply      # actually delete (per-batch max 200, cap 500)
//   npm run job:purge-audit-logs -- --apply --max 500
try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may be provided by the shell instead */
}

import { purgeAuditLogs } from '../server/services/auditRetentionService'

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

  const summary = await purgeAuditLogs({ dryRun, max })
  console.log(JSON.stringify(summary, null, 2))
  if (summary.dryRun) {
    console.log('(dry run — re-run with --apply to delete)')
  } else if (summary.hasMore) {
    console.log('(backlog remains beyond this run — run again or raise the cadence)')
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
