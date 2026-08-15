import { describe, expect, it } from 'vitest'
import { computeReleaseDeadline, releaseExpired } from '@/lib/allocation/release'
import { makeReservation, makeWalkIn, T } from './helpers'

// P3 reservation: deadline 10:30
const p3 = (overrides = {}) =>
  makeReservation({ effective_priority: 3, release_deadline_at: T.SUN_1030, ...overrides })
// P2 reservation (not on the way): deadline 10:30, same as P3 (#42)
const p2 = (overrides = {}) =>
  makeReservation({ effective_priority: 2, release_deadline_at: T.SUN_1030, ...overrides })
// P2 on-the-way: deadline 10:50 (grace)
const p2OnWay = (overrides = {}) =>
  makeReservation({
    effective_priority: 2,
    p2_on_the_way: true,
    release_deadline_at: T.SUN_1050,
    ...overrides,
  })

describe('releaseExpired', () => {
  // ── P3 @ 10:30 ─────────────────────────────────────────────────────────────
  it('P3 approved: not released before 10:30', () => {
    const { reservations, releasedCount } = releaseExpired([p3({ status: 'approved' })], T.SUN_1000)
    expect(reservations[0].status).toBe('approved')
    expect(releasedCount).toBe(0)
  })

  it('P3 approved → released_late at 10:30', () => {
    const { reservations } = releaseExpired([p3({ status: 'approved' })], T.SUN_1030)
    expect(reservations[0].status).toBe('released_late')
  })

  it('P3 approved → released_late after 10:30, sets released_at', () => {
    const { reservations } = releaseExpired([p3({ status: 'approved' })], T.SUN_1031)
    expect(reservations[0].status).toBe('released_late')
    expect(reservations[0].released_at?.getTime()).toBe(T.SUN_1031.getTime())
  })

  // ── P2 (not on the way) @ 10:30 — collapsed onto P3's deadline by #42 ────────
  it('P2 approved: not released before 10:30', () => {
    const { reservations, releasedCount } = releaseExpired([p2({ status: 'approved' })], T.SUN_1000)
    expect(reservations[0].status).toBe('approved')
    expect(releasedCount).toBe(0)
  })

  it('P2 approved (not on the way) → released_late at 10:30, same as P3', () => {
    const { reservations } = releaseExpired([p2({ status: 'approved' })], T.SUN_1030)
    expect(reservations[0].status).toBe('released_late')
  })

  // ── P2 on the way @ 10:50 grace ──────────────────────────────────────────────
  it('P2 on the way: NOT released at 10:30 (held until 10:50 grace)', () => {
    const { reservations, releasedCount } = releaseExpired([p2OnWay({ status: 'approved' })], T.SUN_1030)
    expect(reservations[0].status).toBe('approved')
    expect(releasedCount).toBe(0)
  })

  it('P2 on the way → released_late at 10:50', () => {
    const { reservations } = releaseExpired([p2OnWay({ status: 'approved' })], T.SUN_1050)
    expect(reservations[0].status).toBe('released_late')
  })

  // ── Status guards ────────────────────────────────────────────────────────────
  it('does not change attended reservations', () => {
    const { reservations } = releaseExpired([p3({ status: 'attended' })], T.SUN_1031)
    expect(reservations[0].status).toBe('attended')
  })

  it('does not downgrade an approved-but-already-attended record (attended_at set)', () => {
    // Defensive: status approved yet attended_at populated → must not be released.
    const res = p3({ status: 'approved', attended_at: T.SUN_1000 })
    const { reservations } = releaseExpired([res], T.SUN_1031)
    expect(reservations[0].status).toBe('approved')
  })

  it('does not change waiting reservations', () => {
    const { reservations } = releaseExpired([p3({ status: 'waiting' })], T.SUN_1031)
    expect(reservations[0].status).toBe('waiting')
  })

  it('does not change cancelled_late reservations', () => {
    const { reservations } = releaseExpired([p3({ status: 'cancelled_late' })], T.SUN_1031)
    expect(reservations[0].status).toBe('cancelled_late')
  })

  it('does not change cancelled_by_user reservations', () => {
    const { reservations } = releaseExpired([p3({ status: 'cancelled_by_user' })], T.SUN_1031)
    expect(reservations[0].status).toBe('cancelled_by_user')
  })

  it('does not touch temp_approved during release', () => {
    const { reservations } = releaseExpired([p3({ status: 'temp_approved' })], T.SUN_1031)
    expect(reservations[0].status).toBe('temp_approved')
  })

  it('does not touch walk_in reservations', () => {
    const { reservations } = releaseExpired([makeWalkIn()], T.SUN_1031)
    expect(reservations[0].status).toBe('walk_in')
  })

  // ── Mixed batch / counting ───────────────────────────────────────────────────
  it('at 10:30 releases due P3 and P2 but leaves on-the-way P2 held', () => {
    const reservations = [
      p3({ status: 'approved' }),       // due at 10:30
      p2({ status: 'approved' }),       // due at 10:30
      p2OnWay({ status: 'approved' }),  // due at 10:50
    ]
    const { reservations: result, releasedCount } = releaseExpired(reservations, T.SUN_1030)
    expect(releasedCount).toBe(2)
    expect(result[2].status).toBe('approved')
  })

  // ── Broadcast ─────────────────────────────────────────────────────────────────
  it('broadcasts to all waiting users when spaces are released', () => {
    const approved = p3({ status: 'approved' })
    const w1 = makeReservation({ status: 'waiting' })
    const w2 = makeReservation({ status: 'waiting' })
    const { outbox } = releaseExpired([approved, w1, w2], T.SUN_1031)

    const broadcasts = outbox.filter(o => o.template_key === 'broadcast_release')
    expect(broadcasts).toHaveLength(2)
    expect(broadcasts.map(o => o.user_id)).toContain(w1.user_id)
    expect(broadcasts.map(o => o.user_id)).toContain(w2.user_id)
  })

  it('emits no broadcast when no spaces were released', () => {
    const { outbox } = releaseExpired(
      [p3({ status: 'attended' }), makeReservation({ status: 'waiting' })],
      T.SUN_1031,
    )
    expect(outbox).toHaveLength(0)
  })

  // ── Owner notice (the member whose own seat was released) ───────────────────────
  it('notifies the released owner with reservation_released (id/user/released_at)', () => {
    const approved = p3({ status: 'approved' })
    const { outbox } = releaseExpired([approved], T.SUN_1031)

    const owner = outbox.filter(o => o.template_key === 'reservation_released')
    expect(owner).toHaveLength(1)
    expect(owner[0].reservation_id).toBe(approved.id)
    expect(owner[0].user_id).toBe(approved.user_id)
    // released_at is the SWEEP time, not the deadline
    expect(owner[0].payload).toEqual({ released_at: T.SUN_1031.toISOString() })
  })

  it('emits one owner notice per released row and none for held/other statuses', () => {
    const relP3 = p3({ status: 'approved' })       // due at 10:30 → released at 10:30
    const relP2 = p2({ status: 'approved' })        // due at 10:30 → released at 10:30
    const heldP2OnWay = p2OnWay({ status: 'approved' }) // due at 10:50 → held
    const attended = p3({ status: 'attended' })
    const waitingRow = makeReservation({ status: 'waiting' })
    const { outbox } = releaseExpired(
      [relP3, relP2, heldP2OnWay, attended, waitingRow],
      T.SUN_1030,
    )

    const owner = outbox.filter(o => o.template_key === 'reservation_released')
    expect(owner.map(o => o.reservation_id).sort()).toEqual([relP3.id, relP2.id].sort())
    // never to the held on-the-way P2, the attended row, or waiting users
    expect(owner.map(o => o.reservation_id)).not.toContain(heldP2OnWay.id)
    expect(owner.map(o => o.reservation_id)).not.toContain(attended.id)
    expect(owner.map(o => o.reservation_id)).not.toContain(waitingRow.id)
  })

  it('emits no owner notice when nothing was released', () => {
    const { outbox } = releaseExpired([p3({ status: 'attended' })], T.SUN_1031)
    expect(outbox.filter(o => o.template_key === 'reservation_released')).toHaveLength(0)
  })

  // ── Idempotency ────────────────────────────────────────────────────────────────
  it('is idempotent: second run releases nothing more', () => {
    const { reservations: firstPass } = releaseExpired([p3({ status: 'approved' })], T.SUN_1031)
    const { releasedCount: secondCount } = releaseExpired(firstPass, T.SUN_1230)
    expect(secondCount).toBe(0)
  })
})

// ── computeReleaseDeadline ──────────────────────────────────────────────────────

describe('computeReleaseDeadline', () => {
  const deadlines = { p3: T.SUN_1030, p2: T.SUN_1030, p2Grace: T.SUN_1050 }

  it('P3 → 10:30', () => {
    expect(computeReleaseDeadline({ effective_priority: 3, p2_on_the_way: false }, deadlines)).toBe(T.SUN_1030)
  })

  it('P2 not on the way → 10:30, same as P3', () => {
    expect(computeReleaseDeadline({ effective_priority: 2, p2_on_the_way: false }, deadlines)).toBe(T.SUN_1030)
  })

  it('P2 on the way → 10:50 grace', () => {
    expect(computeReleaseDeadline({ effective_priority: 2, p2_on_the_way: true }, deadlines)).toBe(T.SUN_1050)
  })
})
