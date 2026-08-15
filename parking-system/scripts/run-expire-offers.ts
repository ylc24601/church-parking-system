// Local dev entry point for the offer-expiry sweep (mirrors run-friday-allocation.ts).
//   npm run job:expire-offers -- --event <uuid>
//   npm run job:expire-offers -- --sunday 2026-06-21
try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may be provided by the shell instead */
}

import { getServiceClient } from '../lib/supabase/server'
import { expireOffers } from '../server/services/offerExpiryService'

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

  throw new Error('usage: run-expire-offers --event <uuid> | --sunday <YYYY-MM-DD>')
}

async function main() {
  const eventId = await resolveEventId()
  const summary = await expireOffers({ eventId })
  console.log(JSON.stringify(summary, null, 2))
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
