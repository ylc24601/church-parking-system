import type {
  AllocateResult,
  NotificationOutboxEntry,
  ReservationForAllocation,
  WeeklyEvent,
  WeeklyStaffAllocation,
} from '@/lib/types'
import { sortReservations } from './sort'

// Number of P1 full-time staff who need one of the SYSTEM-managed spaces this week.
// Only 'reserved' counts; skipped/attended/no_show do not hold a space out of the pool.
//
// Not "how many staff are at church": staff normally park in the church-managed area,
// which is outside this system and never counted (see WeeklyStaffAllocation in
// lib/types.ts). A row is 'reserved' only when that area does not work for them that
// week — typically because they have to leave early.
export function countActiveFullTimeStaffReserved(
  allocations: WeeklyStaffAllocation[],
): number {
  return allocations.filter(a => a.status === 'reserved').length
}

// Public allocatable capacity (the pool the Friday sort draws from):
//   total_capacity − blocked_spaces − guest_reserved − active_full_time_staff_reserved
// where event.admin_reserved IS the guest-reserved count, and the P1 count is the staff
// who need a system-managed space THIS week (passed in, computed from the weekly P1 list).
// Both are carved out of total_capacity before the public sort, so neither competes in it.
export function computeCapacity(
  event: Pick<WeeklyEvent, 'total_capacity' | 'admin_reserved' | 'blocked_spaces'>,
  activeFullTimeStaffReserved: number,
): number {
  const capacity =
    event.total_capacity
    - event.blocked_spaces
    - event.admin_reserved
    - activeFullTimeStaffReserved
  if (capacity < 0) {
    throw new Error(
      `Invalid capacity: guest_reserved (${event.admin_reserved}) + blocked_spaces ` +
      `(${event.blocked_spaces}) + full_time_staff_reserved (${activeFullTimeStaffReserved}) ` +
      `exceeds total_capacity (${event.total_capacity})`,
    )
  }
  return capacity
}

// Friday 18:00 batch allocation.
//
// Freezes a 1-based `allocation_order` snapshot from the fairness sort onto BOTH
// approved and waiting records. This order is the week's source of truth for
// substitution rank and is never recomputed afterwards (offer expiry/decline and
// penalty changes do not touch it).
//
// Idempotent: only processes 'pending' reservations; previously approved/waiting
// records are in `others` and left untouched, so a rerun never overwrites an
// existing allocation_order or approved_at and produces the same result.
export function allocate(
  reservations: ReservationForAllocation[],
  capacity: number,
  now: Date,
): AllocateResult {
  const pending = reservations.filter(r => r.status === 'pending')
  const others  = reservations.filter(r => r.status !== 'pending')

  const sorted = sortReservations(pending)
  const outbox: NotificationOutboxEntry[] = []

  const updated = sorted.map((r, index) => {
    const allocation_order = index + 1   // frozen 1-based snapshot of the Friday sort

    if (index < capacity) {
      outbox.push({
        user_id: r.user_id,
        reservation_id: r.id,
        template_key: 'reservation_approved',
        payload: {},
      })
      return { ...r, status: 'approved' as const, allocation_order, approved_at: now }
    }

    const waitingRank = index - capacity + 1
    outbox.push({
      user_id: r.user_id,
      reservation_id: r.id,
      template_key: 'reservation_waiting',
      payload: { rank: waitingRank },
    })
    return { ...r, status: 'waiting' as const, allocation_order }
  })

  return {
    reservations: [...others, ...updated],
    outbox,
  }
}
