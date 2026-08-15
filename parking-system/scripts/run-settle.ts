// Local dev entry point for the settlement sweep (mirrors run-release.ts).
//   npm run job:settle -- --event <uuid>
//   npm run job:settle -- --sunday 2026-06-21
try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may be provided by the shell instead */
}

import { getServiceClient } from '../lib/supabase/server'
import { settle } from '../server/services/settlementService'

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

  throw new Error('usage: run-settle --event <uuid> | --sunday <YYYY-MM-DD>')
}

async function main() {
  const eventId = await resolveEventId()
  const summary = await settle({ eventId })
  console.log(JSON.stringify(summary, null, 2))
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
