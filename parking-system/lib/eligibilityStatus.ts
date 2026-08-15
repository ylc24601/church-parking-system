// ── P2 eligibility date logic (Phase 8 Slice 4; reshaped by Wave 2B-2a / #10) ────
// Pure, IO-free. All dates are 'YYYY-MM-DD' calendar strings in Taipei
// (lexicographic order == chronological order).
//
// ── The as-of date is ALWAYS a parameter. Never a default, never a clock. ────────
// Two callers ask two DIFFERENT questions and each has its own correct as-of date.
// This is not an inconsistency to unify away — it is the point:
//
//   lib/allocation/priority.ts   "is this member P2 for the event on Sunday D?"
//                                -> as-of = the event's sunday_date. A decision, frozen
//                                   onto the reservation row at apply time.
//   this file's deriveEligibilityStatus / the review queue / the detail badge
//                                "does this eligibility need a human TODAY?"
//                                -> as-of = taipeiToday(now). A work queue.
//
// A member applying on Wednesday for Sunday must be judged against SUNDAY: eligibility
// that lapses on Friday must not win them a Sunday spot, and eligibility that starts on
// Saturday must not lose them one. Judge either by "today" and they are silently wrong —
// no error, just a member quietly in the wrong priority band.
//
// So the window predicate takes `asOf` and this file exports no clock. Read the call
// site and you can see which question is being asked.

export type EligibilityStatus = 'expired' | 'not_yet_effective' | 'review_due' | 'active' | 'permanent'

export interface EligibilityWindow {
  validFrom: string | null   // inclusive; null = no start bound
  validUntil: string | null  // inclusive; null = no end bound
}

// THE eligibility window predicate. Both ends inclusive: validFrom <= asOf <= validUntil.
// The upper bound preserves the pre-2B-2a behaviour exactly (`p2_valid_until < sundayDate`
// meant inactive, so a member IS eligible on their last day).
export function isWithinEligibilityWindow(w: EligibilityWindow, asOf: string): boolean {
  if (w.validFrom !== null && asOf < w.validFrom) return false
  if (w.validUntil !== null && w.validUntil < asOf) return false
  return true
}

// ── Taiwan school-year cohort: when does a child companion's P2 end? ─────────────
// 國民教育法: 當年 9/1 前滿 6 歲者入學 — so the 9/1 cutoff is INCLUSIVE (a child born
// 9/1 is in the earlier cohort) and 9/2 begins the next one. Eligibility runs until the
// day before the school year the child enters: August 31.
//
//   born 2019-09-01 -> enters Sept 2025 -> last eligible 2025-08-31
//   born 2019-09-02 -> enters Sept 2026 -> last eligible 2026-08-31
//
// Two children born a day apart differ by a full year. That is inherent to cohort rules,
// not a bug — it is the same line the school system draws.
//
// This is the AUTHORITY for the rule; the only other copy is 0032's one-time recompute
// of pre-existing rows, which is frozen in a migration and pinned by a parity test.
// It lives in TS because the dry-run import preview must show the derived date before
// anything is written, and SQL cannot serve a preview.
const SCHOOL_ENTRY_AGE = 6

export function childCompanionValidUntil(youngestChildBirthdate: string): string {
  const [year, month, day] = youngestChildBirthdate.split('-').map(Number)
  const afterCutoff = month > 9 || (month === 9 && day > 1)
  const entryYear = year + SCHOOL_ENTRY_AGE + (afterCutoff ? 1 : 0)
  return `${entryYear}-08-31`
}

// Whole (完整/週) years between a birthdate and asOf, both 'YYYY-MM-DD'. Calendar
// subtraction, decremented by one if the asOf month/day hasn't reached the birthdate's
// yet — i.e. the birthday itself is the day the age ticks over, not the day after.
// asOf is a parameter for the same reason as the rest of this file: display callers pass
// taipeiToday(now), never a clock read inside this function.
export function ageInYears(birthdate: string, asOf: string): number {
  const [by, bm, bd] = birthdate.split('-').map(Number)
  const [ay, am, ad] = asOf.split('-').map(Number)
  let age = ay - by
  if (am < bm || (am === bm && ad < bd)) age -= 1
  return age
}

// The earlier of the given non-null ISO dates, or null when all are null. The review
// list sorts and classifies by this: the date the member actually needs attention is
// whichever comes FIRST, not review_date by preference. Import usually writes
// review_date == valid_until for temporary eligibility, but that is a convention, not
// a DB constraint — legacy / manually-corrected rows may differ, so we never assume it.
export function earliestDate(...dates: Array<string | null>): string | null {
  const present = dates.filter((d): d is string => d !== null)
  if (present.length === 0) return null
  return present.reduce((min, d) => (d < min ? d : min))
}

// Add whole calendar days to a 'YYYY-MM-DD' date via UTC calendar arithmetic (handles
// month/year/leap-year rollover). Taipei has no DST, so date-only math is unambiguous.
export function addDaysToIsoDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number)
  const d = new Date(Date.UTC(year, month - 1, day + days))
  return d.toISOString().slice(0, 10)
}

// Status of a single eligibility for the review queue and the detail-page badge.
// `today` must be a Taipei calendar date — this is the "needs a human?" question, so
// its as-of date is today, NOT any event's Sunday (see the header).
//
// Precedence matters:
//   valid_until < today       → 'expired'           (silently falls back to P3 at apply time)
//   valid_from  > today       → 'not_yet_effective' (approved, but the window hasn't opened)
//   review_date <= today      → 'review_due'
//   no end and no review date → 'permanent'         (a past valid_from doesn't change that)
//   otherwise (future due)    → 'active'
// 'expired' outranks 'not_yet_effective' only defensively — the DB forbids
// valid_from > valid_until (eligibility_window_ordered_ck), so both cannot be true.
export function deriveEligibilityStatus(
  e: { validUntil: string | null; reviewDate: string | null; validFrom?: string | null },
  today: string,
): EligibilityStatus {
  const validFrom = e.validFrom ?? null
  if (e.validUntil !== null && e.validUntil < today) return 'expired'
  if (validFrom !== null && validFrom > today) return 'not_yet_effective'
  if (e.reviewDate !== null && e.reviewDate <= today) return 'review_due'
  if (e.validUntil === null && e.reviewDate === null) return 'permanent'
  return 'active'
}
