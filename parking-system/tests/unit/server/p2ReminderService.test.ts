import { describe, expect, it, vi } from 'vitest'
import { sendArrivalReminders } from '@/server/services/p2ReminderService'
import type { OutboxRow } from '@/server/repositories/parkingRepository'
import { asRepo, makeMockRepo } from './mockRepo'
import { makeReservation, T } from '../allocation/helpers'

const EVENT = 'event-1'

describe('sendArrivalReminders', () => {
  it('enqueues one p2_arrival_reminder per target with a stable per-event dedupe key', async () => {
    const a = makeReservation({ status: 'approved', effective_priority: 2, weekly_event_id: EVENT })
    const b = makeReservation({ status: 'approved', effective_priority: 2, weekly_event_id: EVENT })
    const repo = makeMockRepo({
      getP2ArrivalReminderTargets: vi.fn(async () => [a, b]),
      enqueueOutbox: vi.fn(async () => 2),
    })

    const summary = await sendArrivalReminders({ eventId: EVENT, now: T.SUN_1000 }, asRepo(repo))

    expect(summary.enqueued).toBe(2)
    const [eventId, rows] = repo.enqueueOutbox.mock.calls[0] as [string, OutboxRow[]]
    expect(eventId).toBe(EVENT)
    expect(rows).toHaveLength(2)
    expect(rows.every(r => r.template_key === 'p2_arrival_reminder')).toBe(true)
    expect(rows[0].dedupe_key).toBe(`p2_reminder:${a.id}:2026-06-21`)
    expect(rows[1].dedupe_key).toBe(`p2_reminder:${b.id}:2026-06-21`)
  })

  // Wave 1d (#27). sunday_date used to be hand-written into the payload here; it now comes from
  // withNotificationContext, together with the plate. The dedupe key is deliberately unchanged,
  // so this slice re-sends nothing.
  it('carries the week and each member’s own plate', async () => {
    const a = makeReservation({ status: 'approved', effective_priority: 2, weekly_event_id: EVENT })
    const b = makeReservation({ status: 'approved', effective_priority: 2, weekly_event_id: EVENT })
    const repo = makeMockRepo({
      getP2ArrivalReminderTargets: vi.fn(async () => [a, b]),
      enqueueOutbox: vi.fn(async () => 2),
      getPlatesForReservations: vi.fn(async () => new Map([[a.id, 'ABC-1234']])),
    })

    await sendArrivalReminders({ eventId: EVENT, now: T.SUN_1000 }, asRepo(repo))

    const [, rows] = repo.enqueueOutbox.mock.calls[0] as [string, OutboxRow[]]
    expect(rows[0].payload).toEqual({ sunday_date: '2026-06-21', license_plate: 'ABC-1234' })
    // b's plate is unknown → the date still lands, the plate line is simply absent
    expect(rows[1].payload).toEqual({ sunday_date: '2026-06-21' })
    expect(repo.getPlatesForReservations).toHaveBeenCalledWith([a.id, b.id])
  })

  it('reminds as normal when the plate lookup fails', async () => {
    const a = makeReservation({ status: 'approved', effective_priority: 2, weekly_event_id: EVENT })
    const repo = makeMockRepo({
      getP2ArrivalReminderTargets: vi.fn(async () => [a]),
      enqueueOutbox: vi.fn(async () => 1),
      getPlatesForReservations: vi.fn(async () => {
        throw new Error('db down')
      }),
    })

    const summary = await sendArrivalReminders({ eventId: EVENT, now: T.SUN_1000 }, asRepo(repo))

    expect(summary.enqueued).toBe(1)
    const [, rows] = repo.enqueueOutbox.mock.calls[0] as [string, OutboxRow[]]
    expect(rows[0].payload).toEqual({ sunday_date: '2026-06-21' })
  })

  it('no targets → enqueues nothing', async () => {
    const repo = makeMockRepo({ getP2ArrivalReminderTargets: vi.fn(async () => []) })
    const summary = await sendArrivalReminders({ eventId: EVENT, now: T.SUN_1000 }, asRepo(repo))
    expect(summary.enqueued).toBe(0)
    expect(repo.enqueueOutbox.mock.calls[0][1]).toHaveLength(0)
  })
})
