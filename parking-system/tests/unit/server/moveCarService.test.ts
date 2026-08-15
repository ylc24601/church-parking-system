import { describe, expect, it, vi } from 'vitest'
import { makeMockRepo, asRepo, type MockRepo } from './mockRepo'
import { requestMoveCar } from '@/server/services/moveCarService'
import type { MoveCarTarget } from '@/server/repositories/parkingRepository'

const EVENT = 'event-1'
const NOW = new Date('2026-06-21T02:30:00Z') // minute bucket → 2026-06-21T02:30

function target(over: Partial<MoveCarTarget> = {}): MoveCarTarget {
  return {
    weekly_event_id: EVENT,
    user_id: 'u1',
    status: 'attended',
    license_plate: 'ABC-1234',
    notifiable: true,
    ...over,
  }
}

function run(t: MoveCarTarget | null, repoOver: Partial<MockRepo> = {}) {
  const repo = makeMockRepo({ getMoveCarTarget: vi.fn(async () => t), ...repoOver })
  return { repo, promise: requestMoveCar({ reservationId: 'r1', eventId: EVENT, now: NOW }, asRepo(repo)) }
}

describe('requestMoveCar', () => {
  it('enqueues a move_car_request for a notifiable member and returns queued', async () => {
    const { repo, promise } = run(target())
    const res = await promise
    expect(res).toEqual({ queued: true })
    expect(repo.enqueueOutbox).toHaveBeenCalledTimes(1)
    const [eventId, rows] = (repo.enqueueOutbox as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(eventId).toBe(EVENT)
    expect(rows[0]).toMatchObject({
      dedupe_key: 'move_car:r1:2026-06-21T02:30',
      template_key: 'move_car_request',
      user_id: 'u1',
      reservation_id: 'r1',
      payload: { license_plate: 'ABC-1234' },
    })
  })

  it('does not notify a walk-in (no user_id)', async () => {
    const { repo, promise } = run(target({ user_id: null, status: 'walk_in', notifiable: false }))
    expect(await promise).toEqual({ queued: false, reason: 'not_notifiable' })
    expect(repo.enqueueOutbox).not.toHaveBeenCalled()
  })

  it('does not notify a member without a line binding (notifiable:false)', async () => {
    const { repo, promise } = run(target({ notifiable: false }))
    expect(await promise).toEqual({ queued: false, reason: 'not_notifiable' })
    expect(repo.enqueueOutbox).not.toHaveBeenCalled()
  })

  it('does not notify a non-actionable status (pending / no_show)', async () => {
    for (const status of ['pending', 'no_show', 'cancelled_by_user'] as const) {
      const { repo, promise } = run(target({ status }))
      expect(await promise).toEqual({ queued: false, reason: 'not_notifiable' })
      expect(repo.enqueueOutbox).not.toHaveBeenCalled()
    }
  })

  it('throws wrong_event when the reservation is on another event', async () => {
    const { promise } = run(target({ weekly_event_id: 'other-event' }))
    await expect(promise).rejects.toThrow('wrong_event')
  })

  it('throws not found when the reservation id does not exist', async () => {
    const { promise } = run(null)
    await expect(promise).rejects.toThrow(/not found/)
  })

  it('same-minute repeat is an idempotent success: identical dedupe_key, both return queued even with 0 inserted', async () => {
    // enqueueOutbox reports 0 inserted on the ON CONFLICT DO NOTHING collapse.
    const repo = makeMockRepo({
      getMoveCarTarget: vi.fn(async () => target()),
      enqueueOutbox: vi.fn(async () => 0),
    })
    const a = await requestMoveCar({ reservationId: 'r1', eventId: EVENT, now: NOW }, asRepo(repo))
    const b = await requestMoveCar({ reservationId: 'r1', eventId: EVENT, now: NOW }, asRepo(repo))
    expect(a).toEqual({ queued: true })
    expect(b).toEqual({ queued: true })
    const keys = (repo.enqueueOutbox as ReturnType<typeof vi.fn>).mock.calls.map(c => c[1][0].dedupe_key)
    expect(keys).toEqual(['move_car:r1:2026-06-21T02:30', 'move_car:r1:2026-06-21T02:30'])
  })
})
