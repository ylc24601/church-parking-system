import type { ReservationStatus } from '@/lib/types'

// Valid state transitions for the reservation state machine.
// Terminal states map to empty arrays.
const VALID_TRANSITIONS: Record<ReservationStatus, ReservationStatus[]> = {
  pending:                ['approved', 'waiting', 'cancelled_by_user'],
  approved:               ['attended', 'released_late', 'cancelled_late'],
  // temp_approved is the live offer + seat lock. On confirm → approved; on
  // expiry/decline it reverts straight back to waiting (outcome recorded in
  // reservation.offer_status, not in a separate main status).
  temp_approved:          ['approved', 'waiting'],
  waiting:                ['temp_approved', 'approved', 'cancelled_by_user'],
  released_late:          ['attended_after_release', 'no_show'],
  attended:               [],
  attended_after_release: [],
  no_show:                [],
  cancelled_by_user:      [],
  cancelled_late:         [],
  walk_in:                [],
}

export function isValidTransition(from: ReservationStatus, to: ReservationStatus): boolean {
  return VALID_TRANSITIONS[from].includes(to)
}

export function getAllowedTransitions(from: ReservationStatus): ReservationStatus[] {
  return [...VALID_TRANSITIONS[from]]
}

export function isTerminalStatus(status: ReservationStatus): boolean {
  return VALID_TRANSITIONS[status].length === 0
}
