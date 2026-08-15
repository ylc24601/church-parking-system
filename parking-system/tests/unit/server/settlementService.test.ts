import { describe, expect, it, vi } from 'vitest'
import { settle } from '@/server/services/settlementService'
import { asRepo, makeMockRepo } from './mockRepo'
import { makeReservation, T } from '../allocation/helpers'

const EVENT = 'event-1'

function vi_fn(value: unknown) {
  return vi.fn(async () => value)
}

const releasedLate = (over = {}) =>
  makeReservation({ status: 'released_late', weekly_event_id: EVENT, ...over })

// counters row helper
const ctr = (user_id: string, penalty_score = 0, consecutive_no_show = 0) =>
  ({ user_id, penalty_score, consecutive_no_show, last_successful_attended_at: null })

describe('settle', () => {
  it('P3 no-show → penalty_score+1, no alert', async () => {
    const r = releasedLate({ effective_priority: 3 })
    const repo = makeMockRepo({
      getReleasedLateForSettlement: vi_fn([r]),
      getPenaltyCountersForUsers: vi_fn([ctr(r.user_id!, 1, 0)]),
      applySettlement: vi.fn(async () => ({ settled: 1, penalties_applied: 1, alerts_created: 0 })),
    })

    const summary = await settle({ eventId: EVENT, now: T.SUN_1230 }, asRepo(repo))
    expect(summary.settled).toBe(1)

    const arg = repo.applySettlement.mock.calls[0][0]
    expect(arg.penalties).toHaveLength(1)
    // settleNoShow increments consecutive_no_show for everyone; only P3's penalty_score moves
    // and the P3 counter is never read (pastoral flag is privileged-only).
    expect(arg.penalties[0]).toMatchObject({ user_id: r.user_id, penalty_score: 2, consecutive_no_show: 1 })
    expect(arg.alerts).toHaveLength(0)
  })

  it('P2 reaching consecutive_no_show=4 → score frozen + one pastoral alert (no outbox arg)', async () => {
    const r = releasedLate({ effective_priority: 2 })
    const repo = makeMockRepo({
      getReleasedLateForSettlement: vi_fn([r]),
      getPenaltyCountersForUsers: vi_fn([ctr(r.user_id!, 2, 3)]),
      applySettlement: vi.fn(async () => ({ settled: 1, penalties_applied: 1, alerts_created: 1 })),
    })

    const summary = await settle({ eventId: EVENT, now: T.SUN_1230 }, asRepo(repo))
    expect(summary.alertsCreated).toBe(1)

    const arg = repo.applySettlement.mock.calls[0][0]
    expect(arg.penalties[0]).toMatchObject({ user_id: r.user_id, penalty_score: 2, consecutive_no_show: 4 })
    expect(arg.alerts).toEqual([{ user_id: r.user_id, reason: 'consecutive_no_show', trigger_count: 4 }])
    // settlement enqueues no notification: applySettlement receives only penalties + alerts.
    expect(Object.keys(arg).sort()).toEqual(['alerts', 'eventId', 'nowIso', 'penalties'])
    expect(repo.enqueueOutbox).not.toHaveBeenCalled()
  })

  it('P2 below threshold (consecutive 1→2) → no alert', async () => {
    const r = releasedLate({ effective_priority: 2 })
    const repo = makeMockRepo({
      getReleasedLateForSettlement: vi_fn([r]),
      getPenaltyCountersForUsers: vi_fn([ctr(r.user_id!, 0, 1)]),
    })

    await settle({ eventId: EVENT, now: T.SUN_1230 }, asRepo(repo))
    const arg = repo.applySettlement.mock.calls[0][0]
    expect(arg.penalties[0]).toMatchObject({ consecutive_no_show: 2 })
    expect(arg.alerts).toHaveLength(0)
  })

  it('runs the release sweep BEFORE reading released_late', async () => {
    const order: string[] = []
    const r = releasedLate({ effective_priority: 3 })
    const repo = makeMockRepo({
      getReservationsForRelease: vi.fn(async () => { order.push('release-read'); return [] }),
      applyRelease: vi.fn(async () => { order.push('release-apply'); return { released: 0, outbox_enqueued: 0, owner_notices_enqueued: 0 } }),
      getReleasedLateForSettlement: vi.fn(async () => { order.push('settle-read'); return [r] }),
      getPenaltyCountersForUsers: vi_fn([ctr(r.user_id!, 0, 0)]),
    })

    await settle({ eventId: EVENT, now: T.SUN_1230 }, asRepo(repo))
    expect(order).toEqual(['release-read', 'release-apply', 'settle-read'])
  })

  it('no released_late → early return, no settlement applied', async () => {
    const repo = makeMockRepo({
      getReleasedLateForSettlement: vi_fn([]),
      applyRelease: vi.fn(async () => ({ released: 2, outbox_enqueued: 0, owner_notices_enqueued: 0 })),
    })

    const summary = await settle({ eventId: EVENT, now: T.SUN_1230 }, asRepo(repo))
    expect(summary).toMatchObject({ releasedNow: 2, settled: 0, penaltiesApplied: 0, alertsCreated: 0 })
    expect(repo.applySettlement).not.toHaveBeenCalled()
  })

  it('mixed batch: penalties for all, alert only for the flagged P2', async () => {
    const p3 = releasedLate({ effective_priority: 3 })
    const p2 = releasedLate({ effective_priority: 2 })
    const repo = makeMockRepo({
      getReleasedLateForSettlement: vi_fn([p3, p2]),
      getPenaltyCountersForUsers: vi_fn([ctr(p3.user_id!, 0, 0), ctr(p2.user_id!, 1, 3)]),
    })

    await settle({ eventId: EVENT, now: T.SUN_1230 }, asRepo(repo))
    const arg = repo.applySettlement.mock.calls[0][0]
    expect(arg.penalties).toHaveLength(2)
    expect(arg.alerts).toHaveLength(1)
    expect(arg.alerts[0].user_id).toBe(p2.user_id)
  })
})
