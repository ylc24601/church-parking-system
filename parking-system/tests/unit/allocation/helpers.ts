import type {
  AllocationUser,
  EffectivePriority,
  Reservation,
  ReservationForAllocation,
  ReservationStatus,
  WeeklyStaffAllocation,
} from '@/lib/types'
import { RELEASE_TIMES, TAIPEI_UTC_OFFSET_HOURS } from '@/lib/allocation/rules'

let _id = 0
const nextId = (prefix: string) => `${prefix}-${++_id}`

// Build a UTC Date from an Asia/Taipei (UTC+8, no DST) wall-clock time.
// All test times for the week of Sunday 2026-06-21 are expressed this way so
// nothing hardcodes a pre-computed UTC offset.
const tpe = (day: number, hour: number, minute = 0): Date =>
  new Date(Date.UTC(2026, 5, day, hour - TAIPEI_UTC_OFFSET_HOURS, minute))

export function makeUser(overrides: Partial<AllocationUser> = {}): AllocationUser {
  return {
    id: nextId('user'),
    p1_eligible: false,
    p2_eligible: false,
    penalty_score: 0,
    consecutive_no_show: 0,
    last_successful_attended_at: null,
    ...overrides,
  }
}

export function makeReservation(overrides: Partial<ReservationForAllocation> = {}): ReservationForAllocation {
  return {
    id: nextId('res'),
    weekly_event_id: 'event-1',
    user_id: nextId('user'),
    vehicle_id: nextId('vehicle'),
    requested_p2_this_week: false,
    effective_priority: 3 as EffectivePriority,
    status: 'pending' as ReservationStatus,
    offer_status: null,
    last_offer_at: null,
    offer_expires_at: null,
    p2_on_the_way: false,
    release_deadline_at: new Date('2026-06-21T02:30:00Z'),  // Sun 10:30 Taipei (P3 default)
    allocation_order: null,
    applied_at: new Date('2026-06-15T01:00:00Z'),   // Mon 09:00 Taipei
    approved_at: null,
    attended_at: null,
    released_at: null,
    cancelled_at: null,
    finalized_at: null,
    walk_in_name: null,
    walk_in_license_plate: null,
    staff_note: null,
    admin_note: null,
    penalty_score: 0,
    last_successful_attended_at: null,
    ...overrides,
  }
}

export function makeWalkIn(overrides: Partial<Reservation> = {}): Reservation {
  return {
    id: nextId('res'),
    weekly_event_id: 'event-1',
    user_id: null,
    vehicle_id: null,
    requested_p2_this_week: false,
    effective_priority: 3 as EffectivePriority,
    status: 'walk_in' as ReservationStatus,
    offer_status: null,
    last_offer_at: null,
    offer_expires_at: null,
    p2_on_the_way: false,
    release_deadline_at: new Date('2026-06-21T02:30:00Z'),  // Sun 10:30 Taipei
    allocation_order: null,
    applied_at: new Date('2026-06-21T02:15:00Z'),   // Sun 10:15 Taipei
    approved_at: null,
    attended_at: null,
    released_at: null,
    cancelled_at: null,
    finalized_at: null,
    walk_in_name: '現場散客',
    walk_in_license_plate: 'ABC-1234',
    staff_note: null,
    admin_note: null,
    ...overrides,
  }
}

export function makeStaffAllocation(
  overrides: Partial<WeeklyStaffAllocation> = {},
): WeeklyStaffAllocation {
  return {
    id: nextId('alloc'),
    weekly_event_id: 'event-1',
    user_id: nextId('user'),
    status: 'reserved',
    skip_reason: null,
    updated_at: new Date('2026-06-19T10:00:00Z'),  // Fri 18:00 Taipei
    ...overrides,
  }
}

// Common time constants for the week of Sunday 2026-06-21, built from Taipei
// wall-clock via tpe(). The two release deadlines reference RELEASE_TIMES
// (rules.ts) so the canonical 10:30 / 10:50 live in exactly one place.
//
// #42 (2026-08-14): P2's own deadline collapsed onto P3's (both 10:30 now); only
// the on-the-way grace remains distinct, at 10:50. SUN_1045/SUN_1055 — the old P2
// and P2-grace deadlines — are gone; every former use of "the P2 deadline" is now
// SUN_1030, and "the P2 grace deadline" is SUN_1050.
export const T = {
  MON_09:   tpe(15, 9),                                      // Mon 09:00 Taipei
  FRI_18:   tpe(19, 18),                                     // Fri 18:00 Taipei
  SAT_22:   tpe(20, 22),                                     // Sat 22:00 Taipei
  SAT_2345: tpe(20, 23, 45),                                 // Sat 23:45 Taipei
  SUN_00:   tpe(21, 0),                                      // Sun 00:00 Taipei (= Sat 16:00 UTC)
  SUN_0001: tpe(21, 0, 1),                                   // Sun 00:01 Taipei
  SUN_1000: tpe(21, 10),                                     // Sun 10:00 Taipei
  SUN_1030: tpe(21, RELEASE_TIMES.p3.hour, RELEASE_TIMES.p3.minute),            // P3 + P2 deadline 10:30
  SUN_1031: tpe(21, 10, 31),                                 // Sun 10:31 Taipei — just past 10:30
  SUN_1035: tpe(21, 10, 35),                                 // Sun 10:35 Taipei
  SUN_1040: tpe(21, 10, 40),                                 // Sun 10:40 Taipei
  SUN_1050: tpe(21, RELEASE_TIMES.p2Grace.hour, RELEASE_TIMES.p2Grace.minute),  // P2 grace deadline 10:50
  SUN_1051: tpe(21, 10, 51),                                 // Sun 10:51 Taipei — just past grace
  SUN_1055: tpe(21, 10, 55),                                 // Sun 10:55 Taipei — well after grace
  SUN_1230: tpe(21, 12, 30),                                 // Sun 12:30 Taipei
}
