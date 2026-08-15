import type {
  AllocationUser,
  AttendResult,
  PenaltyUpdate,
  Reservation,
  ReservationStatus,
  SettleResult,
} from '@/lib/types'
import { MAX_PENALTY, PASTORAL_CARE_THRESHOLD } from './rules'

// Staff clicks "結束當週點名": convert released_late → no_show and compute penalties.
//
// Idempotent: released_late entries are consumed on first run; subsequent calls
// find none and return unchanged reservations with no penalty updates.
export function settleNoShow(
  reservations: Reservation[],
  users: AllocationUser[],
): SettleResult {
  const userMap = new Map(users.map(u => [u.id, u]))
  const penaltyUpdates: PenaltyUpdate[] = []

  const updated = reservations.map(r => {
    if (r.status !== 'released_late') return r

    if (r.user_id !== null) {
      const user = userMap.get(r.user_id)
      if (user) {
        penaltyUpdates.push(buildNoShowPenalty(user))
      }
    }

    return { ...r, status: 'no_show' as ReservationStatus }
  })

  return { reservations: updated, penaltyUpdates }
}

// Staff marks a reservation as attended (before 10:30).
// Returns the updated reservation and the penalty recovery for the user.
export function applyAttended(
  reservation: Reservation,
  user: AllocationUser,
  now: Date,
): AttendResult {
  return buildAttendResult(reservation, user, now, 'attended')
}

// Staff marks a reservation as attended after 10:30 (遲到補點名, 免除違規).
export function applyAttendedAfterRelease(
  reservation: Reservation,
  user: AllocationUser,
  now: Date,
): AttendResult {
  return buildAttendResult(reservation, user, now, 'attended_after_release')
}

// Staff check-in: decides attended vs attended_after_release using the
// reservation's own release deadline. On time (now <= release_deadline_at) →
// attended; otherwise → attended_after_release. This is why a P2 who reported
// 「正在路上」(grace deadline 10:50) arriving at 10:40 is `attended`, while a
// P3 (deadline 10:30) arriving at the same 10:40 is `attended_after_release`.
export function markAttendance(
  reservation: Reservation,
  user: AllocationUser,
  now: Date,
): AttendResult {
  const onTime =
    reservation.release_deadline_at !== null && now <= reservation.release_deadline_at
  return onTime
    ? applyAttended(reservation, user, now)
    : applyAttendedAfterRelease(reservation, user, now)
}

// ── Helpers ────────────────────────────────────────────────────────────────

function buildNoShowPenalty(user: AllocationUser): PenaltyUpdate {
  const isPrivileged = user.p1_eligible || user.p2_eligible
  const newConsecutive = user.consecutive_no_show + 1

  return {
    user_id: user.id,
    penalty_score: isPrivileged
      ? user.penalty_score
      : Math.min(user.penalty_score + 1, MAX_PENALTY),
    consecutive_no_show: newConsecutive,
    pastoral_care_flag: isPrivileged && newConsecutive >= PASTORAL_CARE_THRESHOLD,
    last_successful_attended_at: user.last_successful_attended_at,
  }
}

function buildAttendResult(
  reservation: Reservation,
  user: AllocationUser,
  now: Date,
  targetStatus: 'attended' | 'attended_after_release',
): AttendResult {
  const isPrivileged = user.p1_eligible || user.p2_eligible

  return {
    reservation: { ...reservation, status: targetStatus, attended_at: now },
    penaltyUpdate: {
      user_id: user.id,
      penalty_score: isPrivileged
        ? user.penalty_score
        : Math.max(user.penalty_score - 1, 0),
      consecutive_no_show: 0,
      pastoral_care_flag: false,
      last_successful_attended_at: now,
    },
  }
}
