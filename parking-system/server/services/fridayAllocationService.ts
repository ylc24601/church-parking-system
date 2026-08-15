import { allocate, computeCapacity } from '@/lib/allocation/allocate'
import { buildReleaseDeadlines, computeReleaseDeadline } from '@/lib/allocation/release'
import {
  createParkingRepository,
  type OutboxRow,
  type ParkingRepository,
  type ReservationUpdate,
} from '@/server/repositories/parkingRepository'
import { withNotificationContext } from './notification/context'

export const FRIDAY_ALLOCATION_JOB = 'friday_allocation'

export interface FridayAllocationSummary {
  jobStatus: 'success' | 'skipped'
  // planned: what allocate() decided from the read snapshot
  plannedApproved: number
  plannedWaiting: number
  // actual: what the RPC applied (diverges from planned if rows changed between read and apply)
  updated: number | null
  outboxEnqueued: number | null
}

// Friday 18:00 allocation. CLAIMS the run first (claim_friday_allocation commits a
// 'running' job_runs row under the weekly_events row lock — the same lock member
// applies take), THEN reads pending + capacity: every apply that committed before the
// claim is in the snapshot, and every apply after it sees applications_closed. Runs
// the pure allocator, stamps release_deadline_at for approved rows, then atomically
// persists + enqueues notifications via the apply_friday_allocation RPC (idempotent,
// still guarded by job_runs).
export async function runFridayAllocation(
  params: { eventId: string; now?: Date },
  repo: ParkingRepository = createParkingRepository(),
): Promise<FridayAllocationSummary> {
  const { eventId, now = new Date() } = params

  const claim = await repo.claimFridayAllocation(eventId, FRIDAY_ALLOCATION_JOB)
  if (!claim.claimed) {
    // already_succeeded (rerun of a completed week) or event_not_found.
    return { jobStatus: 'skipped', plannedApproved: 0, plannedWaiting: 0, updated: null, outboxEnqueued: null }
  }

  // Everything after the claim runs under try/catch: a throw would otherwise strand
  // the job_runs row at 'running' — which keeps the apply window closed with no
  // failure record ('failed' reopens it and marks the rerun path).
  try {
    const event = await repo.getWeeklyEvent(eventId)
    const inputs = await repo.getCapacityInputs(eventId)
    const capacity = computeCapacity(inputs, inputs.active_full_time_staff_reserved)

    const pending = await repo.getPendingForAllocation(eventId)
    const { reservations, outbox } = allocate(pending, capacity, now)

    const deadlines = buildReleaseDeadlines(event.sunday_date)

    const plannedApproved = reservations.filter(r => r.status === 'approved').length
    const plannedWaiting = reservations.filter(r => r.status === 'waiting').length

    const reservationUpdates: ReservationUpdate[] = reservations.map(r => ({
      id: r.id,
      status: r.status,
      allocation_order: r.allocation_order,
      approved_at: r.approved_at ? r.approved_at.toISOString() : null,
      release_deadline_at:
        r.status === 'approved' ? computeReleaseDeadline(r, deadlines).toISOString() : null,
    }))

    // event.sunday_date is already in hand from the core read above — no extra lookup. The plate
    // lookup inside is fail-soft: this runs AFTER the job claim, so a throw here would land in the
    // catch below and mark the whole week's allocation failed for the sake of a message detail.
    const outboxRows: OutboxRow[] = await withNotificationContext(
      outbox.map(o => ({
        dedupe_key: `friday_allocation:${o.reservation_id}`,
        template_key: o.template_key,
        user_id: o.user_id,
        reservation_id: o.reservation_id,
        payload: o.payload,
      })),
      { sundayDate: event.sunday_date, repo },
    )

    const result = await repo.applyFridayAllocation(
      eventId,
      FRIDAY_ALLOCATION_JOB,
      reservationUpdates,
      outboxRows,
    )

    return {
      jobStatus: result.skipped ? 'skipped' : 'success',
      plannedApproved,
      plannedWaiting,
      updated: result.updated ?? null,
      outboxEnqueued: result.outbox_enqueued ?? null,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Best-effort failure record; never mask the original error.
    try {
      await repo.markJobFailed(eventId, FRIDAY_ALLOCATION_JOB, message)
    } catch {
      /* swallow — original error is what matters */
    }
    throw err
  }
}
