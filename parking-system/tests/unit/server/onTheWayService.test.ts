import { describe, expect, it, vi } from 'vitest'
import { markOnTheWay } from '@/server/services/onTheWayService'
import { buildReleaseDeadlines } from '@/lib/allocation/release'
import { asRepo, makeMockRepo } from './mockRepo'
import { makeReservation, T } from '../allocation/helpers'

const EVENT = 'event-1'
const dl = buildReleaseDeadlines('2026-06-21')

function vi_fn(value: unknown) {
  return vi.fn(async () => value)
}

const p2 = (over = {}) =>
  makeReservation({ status: 'approved', effective_priority: 2, weekly_event_id: EVENT, release_deadline_at: dl.p2, ...over })

describe('markOnTheWay', () => {
  it('before the 10:30 deadline → sets the flag and extends the deadline to 10:50', async () => {
    const r = p2()
    const repo = makeMockRepo({ getReservation: vi_fn(r), setOnTheWay: vi.fn(async () => 1) })

    const summary = await markOnTheWay({ reservationId: r.id, now: T.SUN_1030 }, asRepo(repo))

    expect(summary.updated).toBe(true)
    const [id, nowIso, deadlineIso] = repo.setOnTheWay.mock.calls[0]
    expect(id).toBe(r.id)
    expect(nowIso).toBe(T.SUN_1030.toISOString())
    expect(deadlineIso).toBe(dl.p2Grace.toISOString())   // 10:50
  })

  it('after the deadline (10:31) → no-op, never calls setOnTheWay', async () => {
    const r = p2()
    const repo = makeMockRepo({ getReservation: vi_fn(r) })

    const summary = await markOnTheWay({ reservationId: r.id, now: T.SUN_1031 }, asRepo(repo))

    expect(summary.updated).toBe(false)
    expect(repo.setOnTheWay).not.toHaveBeenCalled()
  })

  it('already on the way → no-op', async () => {
    const r = p2({ p2_on_the_way: true })
    const repo = makeMockRepo({ getReservation: vi_fn(r) })

    const summary = await markOnTheWay({ reservationId: r.id, now: T.SUN_1030 }, asRepo(repo))

    expect(summary.updated).toBe(false)
    expect(repo.setOnTheWay).not.toHaveBeenCalled()
  })

  it('non-P2 / non-approved → no-op', async () => {
    const p3 = makeReservation({ status: 'approved', effective_priority: 3, weekly_event_id: EVENT })
    const repo = makeMockRepo({ getReservation: vi_fn(p3) })
    expect((await markOnTheWay({ reservationId: p3.id, now: T.SUN_1030 }, asRepo(repo))).updated).toBe(false)

    const waiting = p2({ status: 'waiting' })
    const repo2 = makeMockRepo({ getReservation: vi_fn(waiting) })
    expect((await markOnTheWay({ reservationId: waiting.id, now: T.SUN_1030 }, asRepo(repo2))).updated).toBe(false)
  })
})
