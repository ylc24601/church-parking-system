import { describe, expect, it, vi } from 'vitest'
import { runRelease } from '@/server/services/releaseService'
import { buildReleaseDeadlines } from '@/lib/allocation/release'
import type { OutboxRow, ReleaseResult } from '@/server/repositories/parkingRepository'
import { asRepo, makeMockRepo } from './mockRepo'
import { makeReservation, T } from '../allocation/helpers'

const EVENT = 'event-1'
const dl = buildReleaseDeadlines('2026-06-21')

const approvedP3 = () =>
  makeReservation({ status: 'approved', effective_priority: 3, weekly_event_id: EVENT, release_deadline_at: dl.p3 })
const approvedP2 = (deadline = dl.p2) =>
  makeReservation({ status: 'approved', effective_priority: 2, weekly_event_id: EVENT, release_deadline_at: deadline })
const waiting = () => makeReservation({ status: 'waiting', weekly_event_id: EVENT, release_deadline_at: null })

describe('runRelease', () => {
  it('releases approved rows past their deadline: broadcasts to waiting + notifies each released owner', async () => {
    const p3 = approvedP3()
    const p2 = approvedP2(dl.p2Grace)  // on-the-way grace 10:50, not yet due at 10:31
    const w = waiting()
    const applyRelease = vi.fn(
      async (): Promise<ReleaseResult> => ({ released: 1, outbox_enqueued: 1, owner_notices_enqueued: 1 }),
    )
    const repo = makeMockRepo({
      getReservationsForRelease: vi.fn(async () => [p3, p2, w]),
      applyRelease,
    })

    const summary = await runRelease({ eventId: EVENT, now: T.SUN_1031 }, asRepo(repo))

    expect(summary.released).toBe(1)
    expect(summary.broadcastEnqueued).toBe(1)
    expect(summary.ownerNoticesEnqueued).toBe(1)

    const [eventId, nowIso, broadcast, ownerNotices] = applyRelease.mock.calls[0] as unknown as [
      string, string, OutboxRow[], OutboxRow[],
    ]
    expect(eventId).toBe(EVENT)
    expect(nowIso).toBe(T.SUN_1031.toISOString())
    // one broadcast per waiting user, keyed per-sweep, never to the released rows
    expect(broadcast).toHaveLength(1)
    expect(broadcast[0].reservation_id).toBe(w.id)
    expect(broadcast[0].template_key).toBe('broadcast_release')
    expect(broadcast[0].dedupe_key).toBe(`broadcast:${w.id}:${T.SUN_1031.toISOString()}`)
    // one owner notice for the released P3, keyed once-per-reservation (no time bucket)
    expect(ownerNotices).toHaveLength(1)
    expect(ownerNotices[0].reservation_id).toBe(p3.id)
    expect(ownerNotices[0].user_id).toBe(p3.user_id)
    expect(ownerNotices[0].template_key).toBe('reservation_released')
    expect(ownerNotices[0].dedupe_key).toBe(`released_owner:${p3.id}`)
    // released_at is the producer's; sunday_date is stamped by withNotificationContext (#27).
    // No plate here: this mock repo resolves none, and a missing plate simply drops the line.
    expect(ownerNotices[0].payload).toEqual({
      released_at: T.SUN_1031.toISOString(),
      sunday_date: '2026-06-21',
    })
  })

  it('honours the P2 10:50 grace: a P2 on-the-way is not released at 10:40 → no broadcast, no owner notice', async () => {
    const p2grace = approvedP2(dl.p2Grace)  // deadline 10:50
    const w = waiting()
    const applyRelease = vi.fn(
      async (): Promise<ReleaseResult> => ({ released: 0, outbox_enqueued: 0, owner_notices_enqueued: 0 }),
    )
    const repo = makeMockRepo({
      getReservationsForRelease: vi.fn(async () => [p2grace, w]),
      applyRelease,
    })

    const summary = await runRelease({ eventId: EVENT, now: T.SUN_1040 }, asRepo(repo))

    expect(summary.released).toBe(0)
    const [, , broadcast, ownerNotices] = applyRelease.mock.calls[0] as unknown as [
      string, string, OutboxRow[], OutboxRow[],
    ]
    expect(broadcast).toHaveLength(0)      // nothing released → no broadcast wave
    expect(ownerNotices).toHaveLength(0)   // nothing released → no owner notices
  })

  it('notifyReleasedOwners:false (settlement pre-sweep) suppresses owner notices, keeps broadcast', async () => {
    const p3 = approvedP3()
    const w = waiting()
    const applyRelease = vi.fn(
      async (): Promise<ReleaseResult> => ({ released: 1, outbox_enqueued: 1, owner_notices_enqueued: 0 }),
    )
    const repo = makeMockRepo({
      getReservationsForRelease: vi.fn(async () => [p3, w]),
      applyRelease,
    })

    await runRelease({ eventId: EVENT, now: T.SUN_1031, notifyReleasedOwners: false }, asRepo(repo))

    const [, , broadcast, ownerNotices] = applyRelease.mock.calls[0] as unknown as [
      string, string, OutboxRow[], OutboxRow[],
    ]
    expect(broadcast).toHaveLength(1)      // waiting still hears freed capacity
    expect(ownerNotices).toHaveLength(0)   // released owner is NOT notified during settlement
  })

  it('idempotent re-run: nothing left to release → empty broadcast + empty owner notices', async () => {
    // Everything already released_late → not in the approved/waiting read set.
    const repo = makeMockRepo({ getReservationsForRelease: vi.fn(async () => []) })
    const summary = await runRelease({ eventId: EVENT, now: T.SUN_1230 }, asRepo(repo))

    expect(summary.released).toBe(0)
    const [, , broadcast, ownerNotices] = repo.applyRelease.mock.calls[0] as unknown as [
      string, string, OutboxRow[], OutboxRow[],
    ]
    expect(broadcast).toHaveLength(0)
    expect(ownerNotices).toHaveLength(0)
  })

  // ── Wave 1d (#27) ─────────────────────────────────────────────────────────────────────────
  describe('notification context', () => {
    const setup = (overrides = {}) => {
      const p3 = approvedP3()
      const w = waiting()
      const repo = makeMockRepo({
        getReservationsForRelease: vi.fn(async () => [p3, w]),
        applyRelease: vi.fn(
          async (): Promise<ReleaseResult> => ({ released: 1, outbox_enqueued: 1, owner_notices_enqueued: 1 }),
        ),
        getPlatesForReservations: vi.fn(async () => new Map([[p3.id, 'ABC-1234']])),
        ...overrides,
      })
      return { repo, p3, w }
    }
    const outboxOf = (repo: ReturnType<typeof makeMockRepo>) =>
      repo.applyRelease.mock.calls[0] as unknown as [string, string, OutboxRow[], OutboxRow[]]

    it('names the week in both notices and keeps neither payload per-member', async () => {
      const { repo } = setup()
      await runRelease({ eventId: EVENT, now: T.SUN_1031 }, asRepo(repo))
      const [, , broadcast, ownerNotices] = outboxOf(repo)

      expect(ownerNotices[0].payload.sunday_date).toBe('2026-06-21')
      expect(broadcast[0].payload.sunday_date).toBe('2026-06-21')
      // Neither carries a plate. The broadcast is about capacity someone else freed; the owner
      // notice's payload is aggregate-safe by the Phase 4 Slice D rule that
      // tests/integration/release-owner-notice.db.test.ts enforces.
      expect(ownerNotices[0].payload).not.toHaveProperty('license_plate')
      expect(broadcast[0].payload).not.toHaveProperty('license_plate')
    })

    it('never even looks a plate up during a release', async () => {
      const { repo } = setup()
      await runRelease({ eventId: EVENT, now: T.SUN_1031 }, asRepo(repo))
      expect(repo.getPlatesForReservations).not.toHaveBeenCalled()
    })

    it('releases as normal when the decorative date lookup fails', async () => {
      // The release needs no event — each row carries its own deadline. The event read exists only
      // for the message's date, so a failure must cost a word, not the Sunday release.
      const { repo } = setup({
        getWeeklyEvent: vi.fn(async () => {
          throw new Error('db down')
        }),
      })
      const summary = await runRelease({ eventId: EVENT, now: T.SUN_1031 }, asRepo(repo))

      expect(summary.released).toBe(1)
      const [, , broadcast, ownerNotices] = outboxOf(repo)
      expect(broadcast).toHaveLength(1)
      expect(ownerNotices).toHaveLength(1)
      expect(ownerNotices[0].payload).not.toHaveProperty('sunday_date')
    })

  })
})
