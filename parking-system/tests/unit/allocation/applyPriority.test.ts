import { describe, expect, it } from 'vitest'
import { canDeclareCompanion, computeApplyPriority, type ApplyEligibility } from '@/lib/allocation/priority'

// development_plan §4 — apply-time effective_priority. Auto reasons grant P2 without
// a weekly declaration; companion reasons need requested_p2_this_week; eligibility
// outside the window (either end) falls back to P3.
//
// Every case here is judged AS OF THE SUNDAY, never "today" (Wave 2B-2a / #10). That is
// the whole point of this file: the member applies midweek for a Sunday, so a window
// that lapses on Friday must not win them a spot and a window that opens on Saturday
// must not lose them one.
const SUNDAY = '2026-07-12'

const elig = (
  reason: string,
  validUntil: string | null = null,
  validFrom: string | null = null,
): ApplyEligibility => ({
  p2_eligible: true,
  p2_reason: reason,
  p2_valid_from: validFrom,
  p2_valid_until: validUntil,
})

describe('computeApplyPriority', () => {
  it.each(['mobility_long', 'mobility_short', 'pregnancy'])(
    'auto reason %s → P2 without a declaration',
    reason => {
      expect(computeApplyPriority(elig(reason), false, SUNDAY)).toBe(2)
      expect(computeApplyPriority(elig(reason), true, SUNDAY)).toBe(2)
    },
  )

  it.each(['elderly_companion', 'child_companion'])(
    'companion reason %s → P2 only when declared this week',
    reason => {
      expect(computeApplyPriority(elig(reason), true, SUNDAY)).toBe(2)
      expect(computeApplyPriority(elig(reason), false, SUNDAY)).toBe(3)
    },
  )

  it('expired p2_valid_until → P3 even for auto reasons', () => {
    expect(computeApplyPriority(elig('pregnancy', '2026-07-11'), false, SUNDAY)).toBe(3)
    expect(computeApplyPriority(elig('child_companion', '2026-07-01'), true, SUNDAY)).toBe(3)
  })

  it('valid-until ON the Sunday still counts', () => {
    expect(computeApplyPriority(elig('pregnancy', SUNDAY), false, SUNDAY)).toBe(2)
  })

  // ── The start bound, judged against the Sunday (the bug this slice exists to prevent) ──
  it('eligibility that OPENS before the Sunday but after today → P2, not P3', () => {
    // The headline case. 幹事 approves on Wednesday with valid_from = Saturday; the member
    // applies Wednesday for Sunday. Judged as-of TODAY they look not-yet-eligible and get
    // silently dropped to P3 — but on the Sunday they are eligible, so P2 is correct.
    // Nothing throws when this is wrong; the member just quietly loses their place, which
    // is exactly why it is pinned here.
    expect(computeApplyPriority(elig('pregnancy', null, '2026-07-11'), false, SUNDAY)).toBe(2)
  })

  it('valid-from ON the Sunday still counts (inclusive)', () => {
    expect(computeApplyPriority(elig('pregnancy', null, SUNDAY), false, SUNDAY)).toBe(2)
  })

  it('eligibility that opens AFTER the Sunday → P3', () => {
    expect(computeApplyPriority(elig('pregnancy', null, '2026-07-13'), false, SUNDAY)).toBe(3)
    expect(computeApplyPriority(elig('child_companion', null, '2026-07-13'), true, SUNDAY)).toBe(3)
  })

  it('a window that both opens and closes around the Sunday behaves at each edge', () => {
    expect(computeApplyPriority(elig('pregnancy', '2026-07-12', '2026-07-12'), false, SUNDAY)).toBe(2)
    expect(computeApplyPriority(elig('pregnancy', '2026-07-11', '2026-07-01'), false, SUNDAY)).toBe(3)
  })

  it('no eligibility row / not eligible / unknown reason → P3', () => {
    expect(computeApplyPriority(null, true, SUNDAY)).toBe(3)
    expect(computeApplyPriority(
      { p2_eligible: false, p2_reason: null, p2_valid_from: null, p2_valid_until: null }, true, SUNDAY,
    )).toBe(3)
    expect(computeApplyPriority(elig('something_else'), true, SUNDAY)).toBe(3)
  })
})

describe('canDeclareCompanion', () => {
  it('maps companion reasons to the UI hint; auto reasons and P3 get none', () => {
    expect(canDeclareCompanion(elig('elderly_companion'), SUNDAY)).toBe('elderly')
    expect(canDeclareCompanion(elig('child_companion'), SUNDAY)).toBe('child')
    expect(canDeclareCompanion(elig('mobility_long'), SUNDAY)).toBeNull()
    expect(canDeclareCompanion(null, SUNDAY)).toBeNull()
  })

  it('expired companion eligibility gets no declaration checkbox', () => {
    expect(canDeclareCompanion(elig('child_companion', '2026-07-01'), SUNDAY)).toBeNull()
  })
})
