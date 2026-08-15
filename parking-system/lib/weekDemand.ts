import type { WeekStage } from '@/lib/weekStage'

// ── This week's DEMAND side of the admin overview (Wave 3 / #32) ──────────────
// Pure, IO-free. Turns raw reservation rows into the counts the dashboard shows
// next to capacity. Lives here rather than inside the repository so the aggregation
// itself is testable against RAW rows — the property that matters most (that a P2
// count reads a frozen column and nothing else) is invisible once a repo method has
// already reduced the rows to numbers.
//
// ── effective_priority is FROZEN AT APPLY TIME, and must stay that way ────────
// 「優先」 means: the reservations the Friday allocator sorts ahead of ordinary ones by
// their frozen effective_priority (today, `<= 2`) — NOT "the P2 ones". The two give the
// same number today, but the definitions differ, and only the first one survives contact
// with a P1 row.
//
// The allocator sorts on this very column (lib/allocation/sort.ts), so the overview's
// 「優先 N 位」 is exactly the set it will rank first. A member whose eligibility is revoked
// AFTER applying still counts as 優先 here — matching the allocation outcome. Deriving the
// split from users/eligibility instead would produce a second truth ("overview says 4,
// allocator says 3"), so this module deliberately takes nothing but the reservation row.

// The statuses that make up "this week's live demand + promised seats". Exported so the
// repository's .in('status', …) filter and the counter below cannot drift apart.
// Terminal states (attended / no_show / cancelled_* / walk_in) are after-the-fact
// analysis (#16), not "is there anything to handle right now".
export const WEEK_DEMAND_STATUSES = ['pending', 'waiting', 'approved', 'temp_approved'] as const

export interface WeekReservationRow {
  status: string
  effective_priority: number
}

// Named for what the dashboard says — 「優先」/「一般」 — not for a priority band, because
// the band and the label are not the same question. staff_checkin_view answers the same
// one with `is_priority` (P1 OR P2, reason hidden); a field called `p2` that also counted
// P1 would be renaming data rather than reporting it, so the field is called `priority`
// and genuinely means "gets priority treatment in the Friday sort".
export interface DemandCounts {
  total: number
  priority: number   // effective_priority 1 or 2 — sorted ahead of ordinary reservations
  general: number    // effective_priority 3
}

export interface WeekReservationCounts {
  promised: number          // approved + temp_approved — same set as countPromisedReservations
  pending: DemandCounts
  waiting: DemandCounts
}

const emptyCounts = (): DemandCounts => ({ total: 0, priority: 0, general: 0 })

// P1 is counted as 優先 rather than rejected. The member apply flow refuses full-time staff
// outright (memberReservationService's staff_use_p1) so no current path produces one, but
// the allocator does contemplate P1 reservations and sorts them first (lib/allocation/sort.ts,
// and 'P1 always ranks before P3' in allocate.test.ts). Throwing on one would take the /admin
// landing page down for every admin the moment some future slice writes such a row — a large
// blast radius bought for no benefit, since 優先 is where it belongs anyway.
//
// Each band is matched exactly, so the guard covers what its comment claims: 0 and -1 are
// as impossible as 4, and none of them may pass as 優先.
function bump(counts: DemandCounts, priority: number): void {
  counts.total += 1
  if (priority === 1 || priority === 2) {
    counts.priority += 1
    return
  }
  if (priority === 3) {
    counts.general += 1
    return
  }
  // Unreachable: reservations.effective_priority is CHECK-constrained to (1, 2, 3)
  // (0002:42). Kept so priority + general === total can never quietly stop holding.
  throw new Error(
    `summarizeWeekReservations: unexpected effective_priority ${priority} on a reservation`,
  )
}

export function summarizeWeekReservations(rows: WeekReservationRow[]): WeekReservationCounts {
  const counts: WeekReservationCounts = { promised: 0, pending: emptyCounts(), waiting: emptyCounts() }

  for (const row of rows) {
    switch (row.status) {
      case 'pending':
        bump(counts.pending, row.effective_priority)
        break
      case 'waiting':
        bump(counts.waiting, row.effective_priority)
        break
      case 'approved':
      case 'temp_approved':
        // temp_approved is a HELD seat, not a pending one (0006:26-36) — same set the
        // capacity page calls "已核准", so the two pages cannot disagree.
        counts.promised += 1
        break
      default:
        // Defensive: the query filters to WEEK_DEMAND_STATUSES, so anything else is a
        // caller passing unfiltered rows. Ignore rather than throw — a terminal row is
        // not corrupt data, it simply isn't demand.
        break
    }
  }

  return counts
}

// Should the 「申請中」 number be called out? After allocation runs, pending rows are
// expected to have become approved/waiting, so a non-zero count is worth a second look.
//
// NOT proof of a mistake: hasFridayAllocationRun counts job_runs rows in status
// 'running' as well as 'success' (parkingRepository), and the Friday job claims the run
// BEFORE it reads and allocates the pending rows — so `allocated` + pending > 0 legitimately
// occurs for the duration of a run. That window is short, and a genuinely stuck 'running'
// job is exactly the case an operator wants surfaced, so this stays as-is. Copy must say
// "needs attention", never "you missed some".
export function pendingNeedsAttention(stage: WeekStage, pending: number): boolean {
  if (pending <= 0) return false
  return stage !== 'application_open' && stage !== 'no_event'
}
