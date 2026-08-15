// Local dev entry point that calls the same service as the route handler.
//   npm run job:friday -- --event <uuid>
//   npm run job:friday -- --sunday 2026-06-21
// Loads .env.local if present (so SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are available).
try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may be provided by the shell instead */
}

import { getServiceClient } from '../lib/supabase/server'
import { runFridayAllocation } from '../server/services/fridayAllocationService'

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function resolveEventId(): Promise<string> {
  const event = argValue('--event')
  if (event) return event

  const sunday = argValue('--sunday')
  if (sunday) {
    const { data, error } = await getServiceClient()
      .from('weekly_events')
      .select('id')
      .eq('sunday_date', sunday)
      .single()
    if (error || !data) {
      throw new Error(`No weekly_event for sunday ${sunday}: ${error?.message ?? 'not found'}`)
    }
    return data.id as string
  }

  throw new Error('usage: run-friday-allocation --event <uuid> | --sunday <YYYY-MM-DD>')
}

async function main() {
  const eventId = await resolveEventId()
  const summary = await runFridayAllocation({ eventId })
  console.log(JSON.stringify(summary, null, 2))
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
