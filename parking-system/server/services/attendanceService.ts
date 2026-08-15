import type { AllocationUser } from '@/lib/types'
import { markAttendance } from '@/lib/allocation/settle'
import { TAIPEI_UTC_OFFSET_HOURS } from '@/lib/allocation/rules'
import {
  createParkingRepository,
  type AttendancePenaltyPayload,
  type ParkingRepository,
} from '@/server/repositories/parkingRepository'

export interface AttendanceSummary {
  attended: boolean
  status: string
  penaltyUpdated: boolean
}

// user_penalties.last_successful_attended_at is a DATE; store the Taipei calendar date.
function taipeiDateString(now: Date): string {
  return new Date(now.getTime() + TAIPEI_UTC_OFFSET_HOURS * 3600_000).toISOString().slice(0, 10)
}

// Staff attendance check-in. approved/released_late → attended (on time) or
// attended_after_release (past the reservation's own deadline), recovering the member's
// penalty atomically. "Privileged" (penalty frozen) follows the frozen effective_priority
// (P1/P2), per §7. Idempotent: an already-attended row returns { attended:false }.
export async function checkIn(
  params: { reservationId: string; eventId?: string; now?: Date },
  repo: ParkingRepository = createParkingRepository(),
): Promise<AttendanceSummary> {
  const { reservationId, eventId, now = new Date() } = params
  const r = await repo.getReservation(reservationId)
  if (!r) throw new Error(`reservation ${reservationId} not found`)

  // Bind to the caller's staff session event: a session for event A must not be
  // able to check in event B's reservation. Guard here (the apply_attendance RPC
  // also filters by event, but a 0-row update there looks like an idempotent no-op).
  if (eventId !== undefined && r.weekly_event_id !== eventId) {
    throw new Error('wrong_event')
  }

  if (r.status !== 'approved' && r.status !== 'released_late') {
    return { attended: false, status: r.status, penaltyUpdated: false }
  }

  let targetStatus: 'attended' | 'attended_after_release'
  let penalty: AttendancePenaltyPayload | null = null

  if (r.user_id) {
    const counters = await repo.getPenaltyCounters(r.user_id)
    const user: AllocationUser = {
      id: r.user_id,
      p1_eligible: r.effective_priority === 1,
      p2_eligible: r.effective_priority === 2,
      penalty_score: counters.penalty_score,
      consecutive_no_show: counters.consecutive_no_show,
      last_successful_attended_at: counters.last_successful_attended_at,
    }
    const result = markAttendance(r, user, now)
    targetStatus = result.reservation.status as 'attended' | 'attended_after_release'
    const pu = result.penaltyUpdate
    penalty = {
      user_id: pu.user_id,
      penalty_score: pu.penalty_score,
      consecutive_no_show: pu.consecutive_no_show,
      last_successful_attended_at: taipeiDateString(now),
    }
  } else {
    // Defensive: approved/released_late rows always have a user (member-shape CHECK),
    // but if somehow not, attend without a penalty write.
    const onTime = r.release_deadline_at !== null && now <= r.release_deadline_at
    targetStatus = onTime ? 'attended' : 'attended_after_release'
  }

  const res = await repo.applyAttendance({
    eventId: r.weekly_event_id,
    reservationId: r.id,
    targetStatus,
    nowIso: now.toISOString(),
    penalty,
  })

  return {
    attended: res.attended > 0,
    status: targetStatus,
    penaltyUpdated: res.penalty_updated > 0,
  }
}
