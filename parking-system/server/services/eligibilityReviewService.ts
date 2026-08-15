import { taipeiToday } from '@/lib/taipeiDate'
import { addDaysToIsoDate, deriveEligibilityStatus, earliestDate } from '@/lib/eligibilityStatus'
import { createParkingRepository, type ParkingRepository } from '@/server/repositories/parkingRepository'

// ── P2 eligibility review (Phase 8 Slice 4) ──────────────────────────────────
// A read-only surface listing members whose P2 eligibility is expired, due for
// review, or approaching either within the window. The DB has no interactive write
// path for eligibility (import only), so this just makes the "who needs re-vetting"
// set visible; each row links to the member detail page. No PII beyond name is
// carried here (no phone/dependents).

const REVIEW_WINDOW_DAYS = 60
// The final list is capped for display; the repo pulls up to 2x+1 per branch so the
// global earliest-by-dueDate survive truncation. Church scale never approaches this.
const DISPLAY_CAP = 500
const BRANCH_CANDIDATE_CAP = DISPLAY_CAP * 2 + 1

// 'upcoming' == not expired, review not yet due, but the effective due date falls
// within the window (the list only contains rows at/before the cutoff).
export type ReviewListStatus = 'expired' | 'review_due' | 'upcoming'

export interface EligibilityReviewItem {
  userId: string
  displayName: string
  reason: string | null
  validUntil: string | null
  reviewDate: string | null
  reviewedAt: string | null
  dueDate: string | null   // min(validUntil, reviewDate) — the sort key, surfaced so the UI needn't guess
  status: ReviewListStatus
}

export interface EligibilityReviewResult {
  items: EligibilityReviewItem[]
  hasMore: boolean
  counts: { expired: number; review_due: number; upcoming: number }
}

export async function listEligibilityReview(
  repo: ParkingRepository = createParkingRepository(),
  now: Date = new Date(),
): Promise<EligibilityReviewResult> {
  const today = taipeiToday(now)
  const cutoff = addDaysToIsoDate(today, REVIEW_WINDOW_DAYS)

  const rows = await repo.listEligibilityReview({ cutoffDate: cutoff, branchCap: BRANCH_CANDIDATE_CAP })

  const mapped = rows.flatMap(r => {
    // as-of = today: this list answers "who needs a human NOW", not "who is P2 on some
    // Sunday". The allocator asks the other question against the event's date.
    const base = deriveEligibilityStatus(
      { validUntil: r.p2_valid_until, reviewDate: r.p2_review_date, validFrom: r.p2_valid_from },
      today,
    )
    // Permanent rows (both dates null) can't satisfy the repo's <= cutoff filter, so
    // they shouldn't reach here; skip defensively rather than mislabel them.
    if (base === 'permanent') return []
    const status: ReviewListStatus =
      base === 'expired' ? 'expired'
      : base === 'review_due' ? 'review_due'
      // 'not_yet_effective' cannot occur yet — nothing writes p2_valid_from until 2B-2b.
      // When it can, an approved-but-not-yet-started row is closest to 'upcoming': not
      // expired, not overdue, just not open. Written out rather than folded into the
      // 'active' branch so 2B-2b has to decide deliberately whether it earns its own
      // section, instead of inheriting this mapping by accident.
      : 'upcoming'
    return [{
      userId: r.user_id,
      displayName: r.display_name,
      reason: r.p2_reason,
      validUntil: r.p2_valid_until,
      reviewDate: r.p2_review_date,
      reviewedAt: r.reviewed_at,
      dueDate: earliestDate(r.p2_valid_until, r.p2_review_date),
      status,
    }]
  })

  // Global sort by the effective due date (earliest / most overdue first), then a
  // stable tiebreak. dueDate is non-null for every listed row (it passed the cutoff).
  mapped.sort((a, b) =>
    (a.dueDate ?? '').localeCompare(b.dueDate ?? '') ||
    a.displayName.localeCompare(b.displayName, 'zh-Hant') ||
    a.userId.localeCompare(b.userId),
  )

  const hasMore = mapped.length > DISPLAY_CAP
  const items = mapped.slice(0, DISPLAY_CAP)
  const counts = {
    expired: items.filter(i => i.status === 'expired').length,
    review_due: items.filter(i => i.status === 'review_due').length,
    upcoming: items.filter(i => i.status === 'upcoming').length,
  }
  return { items, hasMore, counts }
}
