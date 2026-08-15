import type { EffectivePriority } from '@/lib/types'

// ── #35: this week's pending/waiting drilldown, split + sorted ────────────────
// Pure, IO-free — same reasoning as lib/weekDemand.ts: the property that matters
// (waiting sorts by allocation_order, NOT by re-deriving a predicted rank) is
// testable against raw rows here, and invisible once a repo method has reduced
// them to something else.

export interface WeekApplicationRow {
  id: string
  status: 'pending' | 'waiting'
  effective_priority: EffectivePriority
  allocation_order: number | null   // null for pending — not yet frozen by Friday allocation
  applied_at: string                // ISO timestamp
  display_name: string
  license_plate: string
}

// ── allocation_order is NOT the queue position the member was told ────────────
// The Friday allocator stamps `index + 1` onto EVERY allocated row, approved and
// waiting alike (lib/allocation/allocate.ts) — so the first waiting member's
// allocation_order is `capacity + 1`, not 1. What that member actually received,
// in LINE and on /member, is a different number: `index - capacity + 1` at
// allocation time, and thereafter repo.getWaitingRank() = "how many still-waiting
// rows sort ahead of me, plus one".
//
// This page exists to settle exactly that conversation ("LINE said I'm 候補第 1 —
// did the system get it?"), so it must show the member's number, not the internal
// index. Listing the week's whole waiting set in allocation_order and numbering
// from 1 IS getWaitingRank's definition, which is why the two agree by
// construction rather than by coincidence.
//
// It also has to survive substitution: once a waiting row is offered it becomes
// temp_approved and leaves this set, while the rest keep their frozen orders. Raw
// orders would then read 20, 22, 23 against the members' live 1, 2, 3.
export interface WeekWaitingRow extends WeekApplicationRow {
  waitingRank: number   // 1-based over the week's waiting set — matches getWaitingRank
}

export interface WeekApplicationsSplit {
  pending: WeekApplicationRow[]
  waiting: WeekWaitingRow[]
}

// Ascending by allocation_order, nulls last. Written as explicit branches rather
// than `(a ?? Infinity) - (b ?? Infinity)`: that form yields NaN when BOTH are
// null, and only survives because SortCompare coerces NaN to +0. Relying on that
// makes "nulls last" true by accident, not by construction.
function byAllocationOrder(a: WeekApplicationRow, b: WeekApplicationRow): number {
  if (a.allocation_order === null && b.allocation_order === null) return 0
  if (a.allocation_order === null) return 1
  if (b.allocation_order === null) return -1
  return a.allocation_order - b.allocation_order
}

// pending → applied_at ascending (arrival order only — NOT a preview of the Friday
// allocation result; #35's spec forbids reusing lib/allocation/sort.ts here, since a
// pre-allocation preview that later disagreed with the real outcome would mislead the
// exact person debugging that disagreement).
// waiting → allocation_order ascending, then numbered 1..n as waitingRank (see above).
//
// ⚠️ waitingRank must be assigned over the week's COMPLETE waiting set, i.e. here,
// before any presentational filter. Numbering a ?priority=-filtered subset would
// renumber from 1 and re-introduce the very mismatch this function exists to remove.
export function splitWeekApplications(rows: WeekApplicationRow[]): WeekApplicationsSplit {
  const pending = rows
    .filter(r => r.status === 'pending')
    .slice()
    .sort((a, b) => (a.applied_at < b.applied_at ? -1 : a.applied_at > b.applied_at ? 1 : 0))
  const waiting = rows
    .filter(r => r.status === 'waiting')
    .slice()
    .sort(byAllocationOrder)
    .map((r, index) => ({ ...r, waitingRank: index + 1 }))
  return { pending, waiting }
}
