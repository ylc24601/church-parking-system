import { isWithinEligibilityWindow } from '@/lib/eligibilityStatus'

// ── Member apply-time priority (Phase 7 Slice 3, development_plan §4) ─────────
// effective_priority is frozen onto the reservation row at APPLY time. Auto reasons
// (long/short mobility, pregnancy) grant P2 every week without a declaration;
// companion reasons (elderly/child) grant P2 only when the member declares the
// companion for THIS week. P1 never applies through this flow — full-time staff
// spots live in weekly_staff_allocations.
//
// ── The as-of date is the event's Sunday, never "today" (Wave 2B-2a / #10) ────
// A member applies on Wednesday for a Sunday, so the question is "are they eligible
// ON THAT SUNDAY", not "are they eligible right now". Both bounds matter:
//   valid_until on Friday  -> NOT eligible for Sunday (they'd lapse first)
//   valid_from on Saturday -> IS eligible for Sunday (it opens in time)
// Judge either by today and the member is silently in the wrong band — no error, they
// just quietly lose (or wrongly win) a spot. p2_eligible deliberately carries no date
// of its own (see 0032), so the window check has to happen here, against sundayDate.
const AUTO_P2_REASONS = new Set(['mobility_long', 'mobility_short', 'pregnancy'])
const DECLARED_P2_REASONS = new Set(['elderly_companion', 'child_companion'])

export interface ApplyEligibility {
  p2_eligible: boolean            // DERIVED from review_status; carries no date (0032)
  p2_reason: string | null
  p2_valid_from: string | null    // 'YYYY-MM-DD', inclusive
  p2_valid_until: string | null   // 'YYYY-MM-DD', inclusive
}

function eligibilityActive(e: ApplyEligibility | null, sundayDate: string): boolean {
  if (!e || !e.p2_eligible || !e.p2_reason) return false
  return isWithinEligibilityWindow({ validFrom: e.p2_valid_from, validUntil: e.p2_valid_until }, sundayDate)
}

export function computeApplyPriority(
  eligibility: ApplyEligibility | null,
  requestedP2ThisWeek: boolean,
  sundayDate: string,
): 2 | 3 {
  if (!eligibilityActive(eligibility, sundayDate)) return 3
  const reason = eligibility!.p2_reason!
  if (AUTO_P2_REASONS.has(reason)) return 2
  if (DECLARED_P2_REASONS.has(reason) && requestedP2ThisWeek) return 2
  return 3
}

// UI hint: whether the apply form should offer the weekly companion declaration.
export function canDeclareCompanion(
  eligibility: ApplyEligibility | null,
  sundayDate: string,
): 'elderly' | 'child' | null {
  if (!eligibilityActive(eligibility, sundayDate)) return null
  if (eligibility!.p2_reason === 'elderly_companion') return 'elderly'
  if (eligibility!.p2_reason === 'child_companion') return 'child'
  return null
}
