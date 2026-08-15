import { STAFF_SESSION_TTL_HOURS, TAIPEI_UTC_OFFSET_HOURS } from '@/lib/allocation/rules'
import { addDaysToIsoDate } from '@/lib/eligibilityStatus'
import { upcomingSundayISO } from '@/lib/taipeiDate'

// Phase 8 Slice 8 — the SINGLE source of truth for which Sundays the admin PIN page
// manages, shared by the page and the mutation routes so they can never disagree.
// "Current Sunday" is defined by the Taipei CALENDAR (same rule as the member page:
// the smallest Sunday >= today, so Sunday itself counts as current all day) — NOT by
// getActiveEvent(), whose "latest non-finalized" semantics would mislabel last week's
// event as current whenever it was left unfinalized.

export interface StaffPinManagedSundays {
  currentSunday: string // YYYY-MM-DD (Taipei calendar)
  nextSunday: string
}

export function getStaffPinManagedSundays(now: Date): StaffPinManagedSundays {
  const currentSunday = upcomingSundayISO(now)
  return { currentSunday, nextSunday: addDaysToIsoDate(currentSunday, 7) }
}

// Admin-issued PIN expiry contract: the PIN must survive until the END of its Sunday
// (next day 00:00 Taipei = sundayT16:00Z), no matter how many days in advance it was
// issued — the old `now + STAFF_SESSION_TTL_HOURS` contract would let a Saturday-issued
// next-week PIN die before its Sunday. The max() keeps the legacy floor for a PIN
// issued ON Sunday late enough that end-of-day would be shorter than the login TTL.
// Computed entirely on the server; no caller-supplied expiry/ttl exists.
export function staffPinExpiry(now: Date, sunday: string): string {
  const endOfSundayMs =
    Date.parse(`${addDaysToIsoDate(sunday, 1)}T00:00:00Z`) - TAIPEI_UTC_OFFSET_HOURS * 3600_000
  const ttlFloorMs = now.getTime() + STAFF_SESSION_TTL_HOURS * 3600_000
  return new Date(Math.max(endOfSundayMs, ttlFloorMs)).toISOString()
}
