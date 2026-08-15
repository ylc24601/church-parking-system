// Import the church P2 application CSV into member records (Phase 6). DRY-RUN BY DEFAULT — prints a
// validation + projection report and writes nothing; pass --apply to write. Members are keyed by
// mobile phone; line_id is never touched (binding happens later). CLI-first; an Admin UI wraps this
// in a later phase.
//   npm run members:import -- --file ./members-data/applications.csv            # dry run
//   npm run members:import -- --file ./members-data/applications.csv --apply    # write
//
// ⚠️ The CSV holds real member PII. Keep it OUTSIDE the repo (see .gitignore members-data/), and do
// not paste the report (which may contain names/plates) into shared logs.
try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may be provided by the shell instead */
}

import { importMembersFromCsv } from '../server/services/memberImportService'

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag)
}
function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const filePath = argValue('--file')
  if (!filePath) throw new Error('usage: members:import --file <path.csv> [--apply]')
  const dryRun = !hasFlag('--apply')

  const report = await importMembersFromCsv({ filePath, dryRun })
  console.log(JSON.stringify(report, null, 2))
  if (dryRun) {
    console.log('(dry run — re-run with --apply to write)')
  }
  // Non-zero exit if anything needs operator attention, so a scripted run can catch it.
  const needsAttention =
    report.phoneNameConflicts.length + report.identityConflicts.length +
    report.plateConflicts.length +
    report.batchPlateConflicts.length + report.groupConflicts.length +
    report.validationErrors.length
  if (needsAttention > 0) {
    console.error(`${needsAttention} row(s)/member(s) need attention (conflicts or validation errors) — see report`)
    process.exit(2)
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
