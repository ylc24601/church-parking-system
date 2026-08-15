import { describe, expect, it } from 'vitest'
import {
  addDaysToIsoDate,
  ageInYears,
  childCompanionValidUntil,
  deriveEligibilityStatus,
  earliestDate,
  isWithinEligibilityWindow,
} from '@/lib/eligibilityStatus'

// ── Wave 2B-2a (#10) ─────────────────────────────────────────────────────────────
// isWithinEligibilityWindow is THE eligibility window predicate: the allocator calls it
// with the event's Sunday, the review queue calls it with today. It takes `asOf` and
// never reads a clock, so neither caller can accidentally inherit the other's date.
describe('isWithinEligibilityWindow', () => {
  const AS_OF = '2026-07-12'

  it.each([
    ['no bounds at all',            null,         null,         true],
    ['opened in the past',          '2026-01-01', null,         true],
    ['opens later',                 '2026-07-13', null,         false],
    ['opens exactly on the as-of',  '2026-07-12', null,         true],
    ['closes exactly on the as-of', null,         '2026-07-12', true],
    ['closed yesterday',            null,         '2026-07-11', false],
    ['closes later',                null,         '2026-12-31', true],
    ['as-of inside the window',     '2026-01-01', '2026-12-31', true],
    ['single-day window, on it',    '2026-07-12', '2026-07-12', true],
  ])('%s', (_label, validFrom, validUntil, expected) => {
    expect(isWithinEligibilityWindow({ validFrom, validUntil }, AS_OF)).toBe(expected)
  })

  it('is inclusive at BOTH ends, which is what preserves the pre-2B-2a upper bound', () => {
    // The old rule was `p2_valid_until < sundayDate -> inactive`, i.e. the last day counts.
    // A half-open window here would silently strip every member of their final Sunday.
    expect(isWithinEligibilityWindow({ validFrom: null, validUntil: AS_OF }, AS_OF)).toBe(true)
    expect(isWithinEligibilityWindow({ validFrom: AS_OF, validUntil: null }, AS_OF)).toBe(true)
  })
})

// ── #33a: 週歲 for the member detail badge ────────────────────────────────────────
describe('ageInYears', () => {
  it.each([
    ['birthday already passed this year',   '2020-03-05', '2026-08-14', 6],
    ['birthday exactly today (ticks over)', '2020-08-14', '2026-08-14', 6],
    ['birthday not yet reached this year',  '2020-08-15', '2026-08-14', 5],
    ['day before birthday',                 '2020-08-14', '2026-08-13', 5],
  ])('%s: %s as of %s → %d', (_label, birthdate, asOf, expected) => {
    expect(ageInYears(birthdate, asOf)).toBe(expected)
  })

  it('a leap-day birthdate ages correctly on the following Feb 28/Mar 1', () => {
    expect(ageInYears('2020-02-29', '2026-02-28')).toBe(5)
    expect(ageInYears('2020-02-29', '2026-03-01')).toBe(6)
  })
})

// ── The Taiwan school-year cohort rule ───────────────────────────────────────────
// 當年 9/1 前滿 6 歲者入學: 9/1 is INCLUSIVE (earlier cohort), 9/2 starts the next one.
describe('childCompanionValidUntil', () => {
  it('9/1 and 9/2 are a year apart — the cutoff this rule exists for', () => {
    // The boundary the whole rule turns on. Born 9/1 is 6 by the cutoff and enters school
    // that September; born a single day later misses it and waits a full year.
    expect(childCompanionValidUntil('2019-09-01')).toBe('2025-08-31')
    expect(childCompanionValidUntil('2019-09-02')).toBe('2026-08-31')
  })

  it.each([
    ['well before the cutoff',    '2019-01-15', '2025-08-31'],
    ['the day before the cutoff', '2019-08-31', '2025-08-31'],
    ['ON the cutoff (inclusive)', '2019-09-01', '2025-08-31'],
    ['the day after the cutoff',  '2019-09-02', '2026-08-31'],
    ['well after the cutoff',     '2019-12-31', '2026-08-31'],
  ])('%s: %s → %s', (_label, birthdate, expected) => {
    expect(childCompanionValidUntil(birthdate)).toBe(expected)
  })

  it('a leap-day birthdate resolves without throwing or drifting', () => {
    // Feb 29 has no anniversary in the target year. The cohort rule never adds years to
    // the birthdate — it lands on a fixed Aug 31 — so the leap case cannot roll over into
    // March the way a naive `+6 years` would.
    expect(childCompanionValidUntil('2020-02-29')).toBe('2026-08-31')
  })

  it('always lands on Aug 31, never on a birthday', () => {
    for (const b of ['2018-03-05', '2021-09-01', '2021-09-02', '2022-11-30']) {
      expect(childCompanionValidUntil(b)).toMatch(/-08-31$/)
    }
  })

  it('never shortens against the old rule (youngest child + 5 years to the day)', () => {
    // 0032 recomputes existing rows, so the new rule must only ever extend — a member
    // must not lose eligibility they already had because the formula changed under them.
    for (const b of ['2018-01-01', '2019-08-31', '2019-09-01', '2019-09-02', '2020-06-15', '2021-12-31']) {
      const [y, m, d] = b.split('-').map(Number)
      const oldRule = new Date(Date.UTC(y + 5, m - 1, d)).toISOString().slice(0, 10)
      expect(childCompanionValidUntil(b) >= oldRule).toBe(true)
    }
  })
})

describe('earliestDate', () => {
  it('returns the earlier of two dates regardless of argument order', () => {
    expect(earliestDate('2026-07-15', '2026-08-30')).toBe('2026-07-15')
    expect(earliestDate('2026-08-30', '2026-07-15')).toBe('2026-07-15')
  })

  it('ignores nulls; returns the single present date', () => {
    expect(earliestDate(null, '2026-07-15')).toBe('2026-07-15')
    expect(earliestDate('2026-07-15', null)).toBe('2026-07-15')
  })

  it('returns null when all inputs are null', () => {
    expect(earliestDate(null, null)).toBeNull()
  })
})

describe('addDaysToIsoDate', () => {
  it('+0 returns the same day (cutoff is inclusive of the current day)', () => {
    expect(addDaysToIsoDate('2026-07-12', 0)).toBe('2026-07-12')
  })

  it('rolls over a month boundary', () => {
    expect(addDaysToIsoDate('2026-07-15', 60)).toBe('2026-09-13')
  })

  it('rolls over a year boundary', () => {
    expect(addDaysToIsoDate('2026-12-01', 60)).toBe('2027-01-30')
  })

  it('handles a leap-year February (2028 is a leap year)', () => {
    expect(addDaysToIsoDate('2028-01-30', 30)).toBe('2028-02-29')
    expect(addDaysToIsoDate('2028-02-28', 1)).toBe('2028-02-29')
  })

  it('handles a non-leap February', () => {
    expect(addDaysToIsoDate('2027-02-28', 1)).toBe('2027-03-01')
  })
})

describe('deriveEligibilityStatus', () => {
  const today = '2026-07-12'

  it('valid_until in the past → expired (even if a later review_date exists)', () => {
    expect(deriveEligibilityStatus({ validUntil: '2026-07-11', reviewDate: '2026-08-30' }, today)).toBe('expired')
  })

  it('valid_until == today is NOT yet expired (same-day still valid, matches priority.ts)', () => {
    expect(deriveEligibilityStatus({ validUntil: today, reviewDate: null }, today)).toBe('active')
  })

  it('review_date at/before today (not expired) → review_due', () => {
    expect(deriveEligibilityStatus({ validUntil: null, reviewDate: '2026-07-11' }, today)).toBe('review_due')
    expect(deriveEligibilityStatus({ validUntil: null, reviewDate: today }, today)).toBe('review_due')
  })

  it('both dates null → permanent', () => {
    expect(deriveEligibilityStatus({ validUntil: null, reviewDate: null }, today)).toBe('permanent')
  })

  // ── valid_from (Wave 2B-2a). Nothing writes it until 2B-2b, so every case below is
  // forward-looking: today it is NULL everywhere and this status cannot fire. That is
  // exactly why 'zero behaviour change' is claimable for the allocator in this slice.
  it('valid_from in the future → not_yet_effective', () => {
    expect(deriveEligibilityStatus(
      { validUntil: null, reviewDate: null, validFrom: '2026-07-13' }, today,
    )).toBe('not_yet_effective')
  })

  it('valid_from == today is already effective (inclusive)', () => {
    expect(deriveEligibilityStatus(
      { validUntil: null, reviewDate: null, validFrom: today }, today,
    )).toBe('permanent')
  })

  it('a past valid_from with no end/review date is still permanent', () => {
    // "Permanent" means nothing will expire it and nobody needs to look at it again.
    // Having a recorded start date does not change either of those.
    expect(deriveEligibilityStatus(
      { validUntil: null, reviewDate: null, validFrom: '2026-01-01' }, today,
    )).toBe('permanent')
  })

  it('expired outranks not_yet_effective (defensive — the DB forbids the combination)', () => {
    // eligibility_window_ordered_ck rejects valid_from > valid_until, so this row cannot
    // exist. Pinned anyway: if it ever does, saying "已過期" is the safe read, and the
    // precedence should be a decision rather than whichever branch happened to come first.
    expect(deriveEligibilityStatus(
      { validUntil: '2026-07-01', reviewDate: null, validFrom: '2026-07-20' }, today,
    )).toBe('expired')
  })

  it('omitting validFrom entirely behaves exactly as before (callers not yet updated)', () => {
    expect(deriveEligibilityStatus({ validUntil: null, reviewDate: null }, today)).toBe('permanent')
    expect(deriveEligibilityStatus({ validUntil: '2026-07-11', reviewDate: null }, today)).toBe('expired')
  })

  it('a future due date → active', () => {
    expect(deriveEligibilityStatus({ validUntil: '2026-09-01', reviewDate: '2026-09-01' }, today)).toBe('active')
  })
})
