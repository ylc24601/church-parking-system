import { describe, expect, it } from 'vitest'
import {
  applyAttended,
  applyAttendedAfterRelease,
  markAttendance,
  settleNoShow,
} from '@/lib/allocation/settle'
import { makeReservation, makeUser, makeWalkIn, T } from './helpers'

// ── settleNoShow ───────────────────────────────────────────────────────────

describe('settleNoShow', () => {
  it('converts released_late → no_show', () => {
    const user = makeUser()
    const res  = makeReservation({ status: 'released_late', user_id: user.id })
    const { reservations } = settleNoShow([res], [user])
    expect(reservations[0].status).toBe('no_show')
  })

  it('does not touch attended reservations', () => {
    const user = makeUser()
    const res  = makeReservation({ status: 'attended', user_id: user.id })
    const { reservations } = settleNoShow([res], [user])
    expect(reservations[0].status).toBe('attended')
  })

  it('does not touch attended_after_release', () => {
    const user = makeUser()
    const res  = makeReservation({ status: 'attended_after_release', user_id: user.id })
    const { reservations } = settleNoShow([res], [user])
    expect(reservations[0].status).toBe('attended_after_release')
  })

  it('does not touch cancelled_late', () => {
    const user = makeUser()
    const res  = makeReservation({ status: 'cancelled_late', user_id: user.id })
    const { reservations } = settleNoShow([res], [user])
    expect(reservations[0].status).toBe('cancelled_late')
  })

  it('does not touch walk_in reservations', () => {
    const walkIn = makeWalkIn()
    const { reservations } = settleNoShow([walkIn], [])
    expect(reservations[0].status).toBe('walk_in')
  })

  // ── P3 penalty ───────────────────────────────────────────────────────────

  it('increments penalty_score by 1 for P3 no-show', () => {
    const user = makeUser({ p1_eligible: false, p2_eligible: false, penalty_score: 1 })
    const res  = makeReservation({ status: 'released_late', user_id: user.id })
    const { penaltyUpdates } = settleNoShow([res], [user])
    expect(penaltyUpdates[0].penalty_score).toBe(2)
  })

  it('caps penalty_score at 3', () => {
    const user = makeUser({ penalty_score: 3 })
    const res  = makeReservation({ status: 'released_late', user_id: user.id })
    const { penaltyUpdates } = settleNoShow([res], [user])
    expect(penaltyUpdates[0].penalty_score).toBe(3)
  })

  it('increments consecutive_no_show for P3', () => {
    const user = makeUser({ consecutive_no_show: 1 })
    const res  = makeReservation({ status: 'released_late', user_id: user.id })
    const { penaltyUpdates } = settleNoShow([res], [user])
    expect(penaltyUpdates[0].consecutive_no_show).toBe(2)
  })

  // ── P1/P2 pastoral care ──────────────────────────────────────────────────

  it('P1 no-show does not increase penalty_score', () => {
    const user = makeUser({ p1_eligible: true, penalty_score: 0 })
    const res  = makeReservation({ status: 'released_late', user_id: user.id })
    const { penaltyUpdates } = settleNoShow([res], [user])
    expect(penaltyUpdates[0].penalty_score).toBe(0)
  })

  it('P2 no-show does not increase penalty_score', () => {
    const user = makeUser({ p2_eligible: true, penalty_score: 0 })
    const res  = makeReservation({ status: 'released_late', user_id: user.id })
    const { penaltyUpdates } = settleNoShow([res], [user])
    expect(penaltyUpdates[0].penalty_score).toBe(0)
  })

  it('P1/P2 pastoral_care_flag triggers after 4 consecutive no-shows', () => {
    const user = makeUser({ p1_eligible: true, consecutive_no_show: 3 })
    const res  = makeReservation({ status: 'released_late', user_id: user.id })
    const { penaltyUpdates } = settleNoShow([res], [user])
    expect(penaltyUpdates[0].pastoral_care_flag).toBe(true)
    expect(penaltyUpdates[0].consecutive_no_show).toBe(4)
  })

  it('P1/P2 pastoral_care_flag is false below threshold', () => {
    const user = makeUser({ p1_eligible: true, consecutive_no_show: 2 })
    const res  = makeReservation({ status: 'released_late', user_id: user.id })
    const { penaltyUpdates } = settleNoShow([res], [user])
    expect(penaltyUpdates[0].pastoral_care_flag).toBe(false)
  })

  it('P3 pastoral_care_flag is always false', () => {
    const user = makeUser({ consecutive_no_show: 10 })
    const res  = makeReservation({ status: 'released_late', user_id: user.id })
    const { penaltyUpdates } = settleNoShow([res], [user])
    expect(penaltyUpdates[0].pastoral_care_flag).toBe(false)
  })

  // ── Idempotency ────────────────────────────────────────────────────────────

  it('is idempotent: second run produces no penalty updates (no released_late left)', () => {
    const user = makeUser()
    const res  = makeReservation({ status: 'released_late', user_id: user.id })
    const { reservations: firstPass } = settleNoShow([res], [user])
    const { penaltyUpdates: secondUpdates } = settleNoShow(firstPass, [user])
    expect(secondUpdates).toHaveLength(0)
  })

  it('processes walk_in without throwing (user_id is null)', () => {
    const walkIn = makeWalkIn({ status: 'walk_in' })
    expect(() => settleNoShow([walkIn], [])).not.toThrow()
  })
})

// ── applyAttended ──────────────────────────────────────────────────────────

describe('applyAttended', () => {
  it('sets status to attended', () => {
    const user = makeUser()
    const res  = makeReservation({ status: 'approved' })
    const { reservation } = applyAttended(res, user, T.SUN_1000)
    expect(reservation.status).toBe('attended')
  })

  it('sets attended_at to now', () => {
    const user = makeUser()
    const res  = makeReservation({ status: 'approved' })
    const { reservation } = applyAttended(res, user, T.SUN_1000)
    expect(reservation.attended_at?.getTime()).toBe(T.SUN_1000.getTime())
  })

  it('decrements P3 penalty_score (min 0)', () => {
    const user = makeUser({ penalty_score: 2 })
    const res  = makeReservation({ status: 'approved' })
    const { penaltyUpdate } = applyAttended(res, user, T.SUN_1000)
    expect(penaltyUpdate.penalty_score).toBe(1)
  })

  it('does not reduce P3 penalty_score below 0', () => {
    const user = makeUser({ penalty_score: 0 })
    const res  = makeReservation({ status: 'approved' })
    const { penaltyUpdate } = applyAttended(res, user, T.SUN_1000)
    expect(penaltyUpdate.penalty_score).toBe(0)
  })

  it('does not change P1 penalty_score on attendance', () => {
    const user = makeUser({ p1_eligible: true, penalty_score: 0 })
    const res  = makeReservation({ status: 'approved' })
    const { penaltyUpdate } = applyAttended(res, user, T.SUN_1000)
    expect(penaltyUpdate.penalty_score).toBe(0)
  })

  it('resets consecutive_no_show to 0', () => {
    const user = makeUser({ consecutive_no_show: 3, p1_eligible: true })
    const res  = makeReservation({ status: 'approved' })
    const { penaltyUpdate } = applyAttended(res, user, T.SUN_1000)
    expect(penaltyUpdate.consecutive_no_show).toBe(0)
  })

  it('resets pastoral_care_flag to false', () => {
    const user = makeUser({ p1_eligible: true, consecutive_no_show: 4 })
    const res  = makeReservation({ status: 'approved' })
    const { penaltyUpdate } = applyAttended(res, user, T.SUN_1000)
    expect(penaltyUpdate.pastoral_care_flag).toBe(false)
  })

  it('updates last_successful_attended_at to now', () => {
    const user = makeUser()
    const res  = makeReservation({ status: 'approved' })
    const { penaltyUpdate } = applyAttended(res, user, T.SUN_1000)
    expect(penaltyUpdate.last_successful_attended_at?.getTime()).toBe(T.SUN_1000.getTime())
  })
})

// ── applyAttendedAfterRelease ──────────────────────────────────────────────

describe('applyAttendedAfterRelease', () => {
  it('sets status to attended_after_release', () => {
    const user = makeUser()
    const res  = makeReservation({ status: 'released_late' })
    const { reservation } = applyAttendedAfterRelease(res, user, T.SUN_1031)
    expect(reservation.status).toBe('attended_after_release')
  })

  it('applies same penalty recovery logic as applyAttended', () => {
    const user = makeUser({ penalty_score: 2 })
    const res  = makeReservation({ status: 'released_late' })
    const { penaltyUpdate } = applyAttendedAfterRelease(res, user, T.SUN_1031)
    expect(penaltyUpdate.penalty_score).toBe(1)
    expect(penaltyUpdate.consecutive_no_show).toBe(0)
  })

  it('does not produce no_show (race condition guard)', () => {
    // Verifies that marking attended_after_release never results in no_show
    const user = makeUser()
    const res  = makeReservation({ status: 'released_late' })
    const { reservation } = applyAttendedAfterRelease(res, user, T.SUN_1031)
    expect(reservation.status).not.toBe('no_show')
  })
})

// ── markAttendance (deadline-aware) ────────────────────────────────────────

describe('markAttendance', () => {
  it('P2 (not on the way) arriving 10:35 (deadline 10:30, same as P3) is attended_after_release', () => {
    const user = makeUser({ p2_eligible: true })
    const res  = makeReservation({
      status: 'approved',
      effective_priority: 2,
      release_deadline_at: T.SUN_1030,
    })
    const { reservation } = markAttendance(res, user, T.SUN_1035)
    expect(reservation.status).toBe('attended_after_release')
  })

  it('P2 on-the-way arriving 10:40 (deadline 10:50 grace) is attended, NOT attended_after_release', () => {
    const user = makeUser({ p2_eligible: true })
    const res  = makeReservation({
      status: 'approved',
      effective_priority: 2,
      p2_on_the_way: true,
      release_deadline_at: T.SUN_1050,
    })
    const { reservation } = markAttendance(res, user, T.SUN_1040)
    expect(reservation.status).toBe('attended')
  })

  it('P3 arriving 10:35 (deadline 10:30) is attended_after_release', () => {
    const user = makeUser()
    const res  = makeReservation({
      status: 'approved',
      effective_priority: 3,
      release_deadline_at: T.SUN_1030,
    })
    const { reservation } = markAttendance(res, user, T.SUN_1035)
    expect(reservation.status).toBe('attended_after_release')
  })

  it('arriving exactly at the deadline counts as attended', () => {
    const user = makeUser()
    const res  = makeReservation({ status: 'approved', release_deadline_at: T.SUN_1030 })
    const { reservation } = markAttendance(res, user, T.SUN_1030)
    expect(reservation.status).toBe('attended')
  })

  it('P2 on-the-way arriving 10:50 (exactly the grace deadline) is attended', () => {
    const user = makeUser({ p2_eligible: true })
    const res  = makeReservation({
      status: 'approved',
      effective_priority: 2,
      p2_on_the_way: true,
      release_deadline_at: T.SUN_1050,
    })
    const { reservation } = markAttendance(res, user, T.SUN_1050)
    expect(reservation.status).toBe('attended')
  })
})
