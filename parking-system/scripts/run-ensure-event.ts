// Creates the upcoming Sunday's weekly_event if missing (idempotent; Phase 9 Slice 1).
//   npm run job:ensure-event                        → upcoming Sunday (Taipei calendar)
//   npm run job:ensure-event -- --sunday 2026-07-19 → pre-create a specific future Sunday
// Loads .env.local if present (so SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are available).
try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may be provided by the shell instead */
}

import { ensureUpcomingWeeklyEvent } from '../server/services/ensureWeeklyEventService'

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const summary = await ensureUpcomingWeeklyEvent({ sunday: argValue('--sunday') })
  console.log(JSON.stringify(summary, null, 2))
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
