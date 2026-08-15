import { computeCapacity } from '@/lib/allocation/allocate'
import { upcomingSundayISO } from '@/lib/taipeiDate'
import type { WeeklyEventStatus } from '@/lib/types'
import type { WeekOverview } from '@/lib/adminTodoTypes'
import { deriveWeekStage } from '@/lib/weekStage'
import { createParkingRepository, type ParkingRepository } from '@/server/repositories/parkingRepository'

// ── Admin overview top metrics (Wave 3 / #8) ─────────────────────────────────
// The "上指標" of the /admin dashboard: this week's stage + capacity. This is the
// LIVE half (the page re-renders on navigation), separate from the snapshot todo
// counts, so it never has to agree with anything in the sidebar.
//
// The week is the Taipei CALENDAR's upcoming Sunday (upcomingSundayISO) — NOT
// getActiveEvent(), whose "latest non-finalized" semantics would surface a stale
// week that was simply never finalized. Same rule (and reasoning) as the capacity /
// print pages. Reads the SAME row + formula the capacity admin page uses, so the
// numbers shown here match what an operator sees when they open 車位設定.
export async function getWeekOverview(
  params: { now?: Date } = {},
  repo: ParkingRepository = createParkingRepository(),
): Promise<WeekOverview> {
  const sunday = upcomingSundayISO(params.now ?? new Date())
  const row = await repo.getWeeklyCapacityAdmin(sunday)

  // No weekly_events row yet: the ensure-weekly-event job hasn't created it. A
  // legitimate "nothing scheduled" state, not an error.
  if (!row) return { sunday, stage: 'no_event', capacity: null, demand: null }

  const allocationRan = await repo.hasFridayAllocationRun(row.id)
  // One reservations read feeds promised + pending + waiting (#32). This is NOT a
  // transactional snapshot of the whole card — the weekly_events row and the allocation
  // flag are their own queries — but the three reservation-derived numbers now come from
  // one result set scoped to the one weekly_event_id resolved above, so the card cannot
  // contradict itself about this week's reservations. Making all five atomic would mean
  // an RPC, which this metric does not warrant.
  const counts = await repo.countWeekReservations(row.id)

  return {
    sunday,
    stage: deriveWeekStage(row.status as WeeklyEventStatus, allocationRan),
    capacity: {
      allocatable: computeCapacity(row, row.active_full_time_staff_reserved),
      blocked: row.blocked_spaces,
      promised: counts.promised,
    },
    demand: { pending: counts.pending, waiting: counts.waiting },
  }
}
