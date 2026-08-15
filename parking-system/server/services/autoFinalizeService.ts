import { createParkingRepository, type ParkingRepository } from '@/server/repositories/parkingRepository'
import { settle } from './settlementService'

// Operational fallback for weeks Staff forgot to「結束當週點名」: scan past weekly_events
// still 'open', and for each run the existing settle() then finalizeWeeklyEvent(). This is
// NOT the primary Staff flow — manual settle stays normal; this only backstops a miss.
//
// Not Staff-safe by projection (it runs behind the job secret), but stays finalize-focused:
// the summary never carries penalty/pastoral/member/vehicle detail. See the route for the
// exposed shape.

const DEFAULT_GRACE_DAYS = 2
const DAY_MS = 24 * 60 * 60 * 1000
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000 // UTC+8, no DST

export interface AutoFinalizeResult {
  eventId: string
  sunday_date: string
  releasedNow: number
  settled: number
  finalized: boolean
  error?: string
}

export interface AutoFinalizeSummary {
  scanned: number
  finalized: number
  failed: number
  results: AutoFinalizeResult[]
}

// Strict grace-days resolution (never `Number(x) || default`, which mis-handles 0/''/NaN):
// an explicit input must be an integer ≥ 1 or we throw; otherwise fall back to the env var
// (only when it parses to an integer ≥ 1) and finally to the default.
export function resolveGraceDays(input?: number): number {
  if (input !== undefined) {
    if (!Number.isInteger(input) || input < 1) throw new Error('invalid graceDays')
    return input
  }
  const raw = process.env.AUTO_FINALIZE_GRACE_DAYS
  if (raw !== undefined && raw.trim() !== '') {
    const parsed = Number.parseInt(raw, 10)
    if (Number.isInteger(parsed) && parsed >= 1) return parsed
  }
  return DEFAULT_GRACE_DAYS
}

// Exclusive cutoff = (Asia/Taipei business date of `now`) − graceDays, as YYYY-MM-DD.
// Using the Taipei calendar day (not UTC midnight) avoids finalizing a day late when a cron
// runs in the early Taiwan morning. sunday_date is a plain date column, so a date string is
// the right comparison key.
export function taipeiBusinessCutoff(now: Date, graceDays: number): string {
  const taipeiToday = new Date(now.getTime() + TAIPEI_OFFSET_MS)
  const cutoff = new Date(taipeiToday.getTime() - graceDays * DAY_MS)
  return cutoff.toISOString().slice(0, 10)
}

export async function autoFinalizeStaleEvents(
  params: { now?: Date; graceDays?: number } = {},
  repo: ParkingRepository = createParkingRepository(),
): Promise<AutoFinalizeSummary> {
  const now = params.now ?? new Date()
  const graceDays = resolveGraceDays(params.graceDays)
  const cutoff = taipeiBusinessCutoff(now, graceDays)

  const events = await repo.getStaleOpenEvents(cutoff)
  const results: AutoFinalizeResult[] = []

  // Per-event isolation: one bad week must not abort the sweep. settle() is idempotent and
  // finalizeWeeklyEvent is status-guarded, so the whole job is safe to re-run (finalized
  // events drop out of the 'open' scan on the next pass).
  for (const ev of events) {
    try {
      const s = await settle({ eventId: ev.id, now }, repo)
      await repo.finalizeWeeklyEvent(ev.id)
      results.push({
        eventId: ev.id,
        sunday_date: ev.sunday_date,
        releasedNow: s.releasedNow,
        settled: s.settled,
        finalized: true,
      })
    } catch (err) {
      results.push({
        eventId: ev.id,
        sunday_date: ev.sunday_date,
        releasedNow: 0,
        settled: 0,
        finalized: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const finalized = results.filter(r => r.finalized).length
  return { scanned: events.length, finalized, failed: results.length - finalized, results }
}
