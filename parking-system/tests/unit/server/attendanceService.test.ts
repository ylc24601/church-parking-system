import { describe, expect, it, vi } from 'vitest'
import { checkIn } from '@/server/services/attendanceService'
import { buildReleaseDeadlines } from '@/lib/allocation/release'
import { asRepo, makeMockRepo } from './mockRepo'
import { makeReservation, T } from '../allocation/helpers'

const EVENT = 'event-1'
const dl = buildReleaseDeadlines('2026-06-21')

function vi_fn(value: unknown) {
  return vi.fn(async () => value)
}

const counters = (penalty_score: number) =>
  vi_fn({ penalty_score, consecutive_no_show: 0, last_successful_attended_at: null })

describe('checkIn', () => {
  it('on-time approved P3 → attended + penalty recovery (score-1, consecutive 0, today)', async () => {
    const r = makeReservation({ status: 'approved', effective_priority: 3, weekly_event_id: EVENT, release_deadline_at: dl.p3 })
    const repo = makeMockRepo({ getReservation: vi_fn(r), getPenaltyCounters: counters(2) })

    const summary = await checkIn({ reservationId: r.id, now: T.SUN_1030 }, asRepo(repo))

    expect(summary.attended).toBe(true)
    expect(summary.status).toBe('attended')
    const arg = repo.applyAttendance.mock.calls[0][0]
    expect(arg.targetStatus).toBe('attended')
    expect(arg.penalty.penalty_score).toBe(1)            // 2 - 1
    expect(arg.penalty.consecutive_no_show).toBe(0)
    expect(arg.penalty.last_successful_attended_at).toBe('2026-06-21')
  })

  it('privileged (P2 on-the-way, grace deadline) attendance freezes the penalty score', async () => {
    const r = makeReservation({
      status: 'approved',
      effective_priority: 2,
      p2_on_the_way: true,
      weekly_event_id: EVENT,
      release_deadline_at: dl.p2Grace,
    })
    const repo = makeMockRepo({ getReservation: vi_fn(r), getPenaltyCounters: counters(2) })

    await checkIn({ reservationId: r.id, now: T.SUN_1035 }, asRepo(repo))

    const arg = repo.applyAttendance.mock.calls[0][0]
    expect(arg.targetStatus).toBe('attended')           // 10:35 <= 10:50 grace
    expect(arg.penalty.penalty_score).toBe(2)           // frozen, not 1
  })

  it('late / released_late arrival → attended_after_release', async () => {
    const r = makeReservation({ status: 'released_late', effective_priority: 3, weekly_event_id: EVENT, release_deadline_at: dl.p3 })
    const repo = makeMockRepo({ getReservation: vi_fn(r), getPenaltyCounters: counters(1) })

    const summary = await checkIn({ reservationId: r.id, now: T.SUN_1035 }, asRepo(repo))

    expect(summary.status).toBe('attended_after_release')
    expect(repo.applyAttendance.mock.calls[0][0].targetStatus).toBe('attended_after_release')
  })

  it('idempotent: already attended → no-op, no penalty write', async () => {
    const r = makeReservation({ status: 'attended', weekly_event_id: EVENT })
    const repo = makeMockRepo({ getReservation: vi_fn(r) })

    const summary = await checkIn({ reservationId: r.id, now: T.SUN_1030 }, asRepo(repo))

    expect(summary.attended).toBe(false)
    expect(repo.applyAttendance).not.toHaveBeenCalled()
  })

  it('null-user row (defensive) → attends with penalty=null', async () => {
    const r = makeReservation({ status: 'approved', user_id: null, weekly_event_id: EVENT, release_deadline_at: dl.p3 })
    const repo = makeMockRepo({ getReservation: vi_fn(r) })

    await checkIn({ reservationId: r.id, now: T.SUN_1030 }, asRepo(repo))

    expect(repo.getPenaltyCounters).not.toHaveBeenCalled()
    expect(repo.applyAttendance.mock.calls[0][0].penalty).toBeNull()
  })

  it('rejects a reservation from a different event (staff session binding)', async () => {
    const r = makeReservation({ status: 'approved', weekly_event_id: EVENT, release_deadline_at: dl.p3 })
    const repo = makeMockRepo({ getReservation: vi_fn(r) })

    await expect(
      checkIn({ reservationId: r.id, eventId: 'other-event', now: T.SUN_1030 }, asRepo(repo)),
    ).rejects.toThrow('wrong_event')
    expect(repo.applyAttendance).not.toHaveBeenCalled()
  })
})
