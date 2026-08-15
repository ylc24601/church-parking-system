import { TAIPEI_UTC_OFFSET_HOURS } from '@/lib/allocation/rules'
import { addDaysToIsoDate } from '@/lib/eligibilityStatus'

// "Today" as a YYYY-MM-DD calendar date in Asia/Taipei (UTC+8 year-round, no DST).
// The member page resolves "this week's event" from it: the smallest sunday_date >=
// taipeiToday(now), so Sunday itself still resolves to that day's event all day and
// Monday onward points at next week (development_plan §7 timing is Taipei-local).
export function taipeiToday(now: Date): string {
  const shifted = new Date(now.getTime() + TAIPEI_UTC_OFFSET_HOURS * 3600_000)
  return shifted.toISOString().slice(0, 10)
}

// The upcoming Sunday of the Taipei calendar: the smallest Sunday >= taipeiToday(now),
// so Sunday itself counts as the current week all day. Single source for the Sunday a
// scheduled job targets (ensure-weekly-event, job eventId resolution) and for the Staff
// PIN page's "current Sunday" — NOT getActiveEvent(), whose "latest non-finalized"
// semantics would point at a stale prior week left unfinalized.
export function upcomingSundayISO(now: Date): string {
  const today = taipeiToday(now)
  const [year, month, day] = today.split('-').map(Number)
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay() // 0 = Sunday
  return addDaysToIsoDate(today, (7 - weekday) % 7)
}

// A timestamp for an admin table: Taipei date + 24h time. Extracted from
// BindingReview when the audit timeline (Wave 2A-2) needed the identical format —
// the repo's other Intl formatters stay put because their options genuinely differ
// (date-only sheets, time-only check-in).
//
// This is DISPLAY only. It intentionally takes a string and returns a string: any
// value round-tripped through Date loses sub-millisecond precision, which matters
// for audit's created_at (it doubles as a keyset cursor). Never feed a Date back
// into a query.
//
// Deterministic, ICU-free: Taipei is UTC+8 year-round (no DST), so shift the instant by
// the fixed offset and read UTC fields. Intl.DateTimeFormat is deliberately NOT used —
// its zh-TW output puts a THIN SPACE (U+2009) between date and time, and that codepoint
// differs between Node's bundled ICU and the browser's, so any 'use client' component that
// renders it (this page's status header, BindingReview, …) hydration-mismatches on an
// otherwise identical-looking string. Output shape matches the old zh-TW render but with a
// normal space: YYYY/MM/DD HH:MM.
export function fmtTaipeiDateTime(iso: string): string {
  const t = new Date(new Date(iso).getTime() + TAIPEI_UTC_OFFSET_HOURS * 3600_000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${t.getUTCFullYear()}/${p(t.getUTCMonth() + 1)}/${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`
}

// Time-only (HH:MM) Taipei, same ICU-free rationale as fmtTaipeiDateTime: the overview's
// snapshot stamp renders inside a 'use client' component, so it must hydrate deterministically
// rather than lean on Intl (whose separators can differ between Node's ICU and the browser's).
export function fmtTaipeiTime(iso: string): string {
  const t = new Date(new Date(iso).getTime() + TAIPEI_UTC_OFFSET_HOURS * 3600_000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`
}
