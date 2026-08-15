import type { ReservationForAllocation } from '@/lib/types'

// Sort reservations by the fairness rules (lower index = higher priority):
//   1. effective_priority ASC (P1=1 > P2=2 > P3=3)
//   2. penalty_score ASC      (0 is best; P1/P2 are always 0)
//   3. last_successful_attended_at ASC NULLS FIRST
//      (null = never attended = highest rotation priority)
//   4. applied_at ASC         (earlier application wins ties)
//
// Does NOT mutate the input array.
export function sortReservations(
  reservations: ReservationForAllocation[],
): ReservationForAllocation[] {
  return [...reservations].sort((a, b) => {
    if (a.effective_priority !== b.effective_priority) {
      return a.effective_priority - b.effective_priority
    }

    if (a.penalty_score !== b.penalty_score) {
      return a.penalty_score - b.penalty_score
    }

    const aLast = a.last_successful_attended_at
    const bLast = b.last_successful_attended_at
    if (aLast === null && bLast !== null) return -1
    if (aLast !== null && bLast === null) return 1
    if (aLast !== null && bLast !== null && aLast.getTime() !== bLast.getTime()) {
      return aLast.getTime() - bLast.getTime()
    }

    return a.applied_at.getTime() - b.applied_at.getTime()
  })
}
