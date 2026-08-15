import { taipeiToday, upcomingSundayISO } from '@/lib/taipeiDate'
import { createParkingRepository, type ParkingRepository } from '@/server/repositories/parkingRepository'

// Phase 9 Slice 1 — idempotent "the upcoming Sunday's weekly_event exists" job.
// Scheduled daily at 00:01 Taipei so the row for the new week appears right after the
// Taipei day rolls past a Sunday (no gap for the eventId-resolving job routes) and a
// single missed scheduler day self-heals the next. Creation only ever inserts
// sunday_date (DB defaults fill capacity/status), so an existing row — including
// admin-tuned capacity — is never modified (see repo.ensureWeeklyEvent).

export interface EnsureWeeklyEventSummary {
  created: boolean
  eventId: string
  sundayDate: string // YYYY-MM-DD
  status: string
}

const ISO_DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/

// Validate an explicit CLI-provided Sunday (ops pre-creating a specific week). The
// scheduled route never passes one. Typed errors, strictest first: format (including
// impossible calendar dates like 02-30, caught by the UTC round-trip), then weekday,
// then "no past events" (Taipei calendar comparison; Sunday itself is allowed all day).
function validateExplicitSunday(sunday: string, now: Date): string {
  if (!ISO_DATE_FORMAT.test(sunday)) throw new Error('invalid_sunday_format')
  const [year, month, day] = sunday.split('-').map(Number)
  const utc = new Date(Date.UTC(year, month - 1, day))
  if (utc.toISOString().slice(0, 10) !== sunday) throw new Error('invalid_sunday_format')
  if (utc.getUTCDay() !== 0) throw new Error('not_a_sunday')
  if (sunday < taipeiToday(now)) throw new Error('sunday_in_past')
  return sunday
}

export async function ensureUpcomingWeeklyEvent(
  params: { now?: Date; sunday?: string } = {},
  repo: ParkingRepository = createParkingRepository(),
): Promise<EnsureWeeklyEventSummary> {
  const now = params.now ?? new Date()
  const target =
    params.sunday !== undefined
      ? validateExplicitSunday(params.sunday, now)
      : upcomingSundayISO(now)

  const { created, event } = await repo.ensureWeeklyEvent(target)
  return { created, eventId: event.id, sundayDate: event.sunday_date, status: event.status }
}
