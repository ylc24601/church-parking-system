import type { WeeklyEventStatus } from '@/lib/types'

// ── Week stage for the admin overview (Wave 3 / #8) ──────────────────────────
// Pure, IO-free. Turns a weekly_events row's status + "has the Friday allocation
// job run?" flag into the single label the dashboard shows for THIS week.
//
// The status enum is DB-constrained to open/closed/finalized; a null status means
// the ensure-weekly-event job has not created this Sunday's row yet (a legitimate
// "nothing scheduled" state, not an error — same as the capacity/print pages treat it).
//
// allocationRan (repo.hasFridayAllocationRun) is what actually distinguishes "still
// taking applications" from "allocated, now filling waitlist" — the status stays
// 'open' across both, so the flag, not the status, carries that boundary.

export type WeekStage =
  | 'no_event'
  | 'application_open'
  | 'allocated'
  | 'finalized'
  | 'closed'

export function deriveWeekStage(
  status: WeeklyEventStatus | null,
  allocationRan: boolean,
): WeekStage {
  if (status === null) return 'no_event'
  switch (status) {
    case 'finalized':
      return 'finalized'
    case 'closed':
      return 'closed'
    case 'open':
      return allocationRan ? 'allocated' : 'application_open'
    default: {
      // Exhaustiveness guard: a new WeeklyEventStatus must decide its stage here,
      // not silently inherit one.
      const _never: never = status
      return _never
    }
  }
}

export const WEEK_STAGE_LABEL: Record<WeekStage, string> = {
  no_event: '尚未建立本週場次',
  application_open: '申請開放中',
  allocated: '已完成分配（候補遞補中）',
  finalized: '已結算',
  closed: '已關閉',
}
