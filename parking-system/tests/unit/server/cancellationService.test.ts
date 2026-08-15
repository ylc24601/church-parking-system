import { describe, expect, it, vi } from 'vitest'
import { cancelReservation } from '@/server/services/cancellationService'
import { renderTemplate } from '@/server/services/notification/templates'
import { buildReleaseDeadlines } from '@/lib/allocation/release'
import { asRepo, makeMockRepo } from './mockRepo'
import { makeReservation } from '../allocation/helpers'

// Tiny helper: a vi.fn resolving a fixed value (typed loosely for brevity).
function vi_fn(value: unknown) {
  return vi.fn(async () => value)
}

const EVENT = 'event-1'
const NOW_PRE = new Date('2026-06-20T13:00:00Z')   // Sat, +2h = 15:00 < Sunday-midnight (16:00Z)
const NOW_POST = new Date('2026-06-20T16:01:00Z')  // after Sunday midnight
const deadlines = buildReleaseDeadlines('2026-06-21')

const approved = () => makeReservation({ status: 'approved', weekly_event_id: EVENT })
const waiting = (order: number, p: 2 | 3 = 3) =>
  makeReservation({ status: 'waiting', weekly_event_id: EVENT, effective_priority: p, allocation_order: order })

describe('cancelReservation', () => {
  it('pending → cancelled_by_user with no substitute', async () => {
    const r = makeReservation({ status: 'pending', weekly_event_id: EVENT })
    const repo = makeMockRepo({ getReservation: vi_fn(r) })
    const summary = await cancelReservation({ reservationId: r.id, now: NOW_PRE }, asRepo(repo))

    expect(summary.cancelStatus).toBe('cancelled_by_user')
    expect(summary.substituteOffered).toBe(false)
    expect(summary.confirmationEnqueued).toBe(true)
    expect(repo.applyCancellation).toHaveBeenCalledOnce()
    expect(repo.applyCancellation.mock.calls[0][0].substitute).toBeNull()
    expect(repo.applyCancellation.mock.calls[0][0].cancelStatus).toBe('cancelled_by_user')

    // a cancel-confirmation is queued to the cancelling member, keyed once-per-reservation.
    const notice = repo.applyCancellation.mock.calls[0][0].cancelNotice
    expect(notice).toHaveLength(1)
    expect(notice[0].template_key).toBe('reservation_cancelled')
    expect(notice[0].user_id).toBe(r.user_id)
    expect(notice[0].reservation_id).toBe(r.id)
    expect(notice[0].dedupe_key).toBe(`cancel_notice:${r.id}`)
  })

  it('waiting → cancelled_by_user with no substitute', async () => {
    const r = makeReservation({ status: 'waiting', weekly_event_id: EVENT })
    const repo = makeMockRepo({ getReservation: vi_fn(r) })
    const summary = await cancelReservation({ reservationId: r.id, now: NOW_PRE }, asRepo(repo))
    expect(summary.cancelStatus).toBe('cancelled_by_user')
    expect(repo.applyCancellation.mock.calls[0][0].substitute).toBeNull()
  })

  it('approved (pre-midnight, waiting exists) → cancelled_late + temp_approved offer', async () => {
    const r = approved()
    const w1 = waiting(2, 3)
    const w2 = waiting(3, 3)
    const repo = makeMockRepo({
      getReservation: vi_fn(r),
      getWaitingForSubstitution: vi_fn([w1, w2]),
    })
    const summary = await cancelReservation({ reservationId: r.id, now: NOW_PRE }, asRepo(repo))

    expect(summary.cancelStatus).toBe('cancelled_late')
    expect(summary.substituteOffered).toBe(true)
    expect(summary.substituteReservationId).toBe(w1.id)

    const arg = repo.applyCancellation.mock.calls[0][0]
    expect(arg.substitute.id).toBe(w1.id)
    expect(arg.substitute.status).toBe('temp_approved')
    expect(arg.substitute.offer_expires_at).toBe(new Date('2026-06-20T15:00:00Z').toISOString())
    expect(arg.substitute.last_offer_at).toBe(NOW_PRE.toISOString())
    expect(arg.outbox[0].dedupe_key).toBe(`offer:${w1.id}:${NOW_PRE.toISOString()}`)
    // the cancelling member's confirmation is additive and distinct from the substitute offer.
    expect(arg.cancelNotice).toHaveLength(1)
    expect(arg.cancelNotice[0].reservation_id).toBe(r.id)         // the CANCELLER, not the substitute
    expect(arg.cancelNotice[0].dedupe_key).toBe(`cancel_notice:${r.id}`)
    expect(summary.confirmationEnqueued).toBe(true)
  })

  it('approved (after midnight) → substitute is direct approved with release_deadline_at stamped', async () => {
    const r = approved()
    const w1 = waiting(2, 2) // P2
    const repo = makeMockRepo({ getReservation: vi_fn(r), getWaitingForSubstitution: vi_fn([w1]) })
    await cancelReservation({ reservationId: r.id, now: NOW_POST }, asRepo(repo))

    const arg = repo.applyCancellation.mock.calls[0][0]
    expect(arg.substitute.status).toBe('approved')
    expect(arg.substitute.approved_at).toBe(NOW_POST.toISOString())
    expect(arg.substitute.release_deadline_at).toBe(deadlines.p2.toISOString())
  })

  it('approved with no waiting → cancelled_late, no substitute', async () => {
    const r = approved()
    const repo = makeMockRepo({ getReservation: vi_fn(r), getWaitingForSubstitution: vi_fn([]) })
    const summary = await cancelReservation({ reservationId: r.id, now: NOW_PRE }, asRepo(repo))
    expect(summary.substituteOffered).toBe(false)
    expect(repo.applyCancellation.mock.calls[0][0].substitute).toBeNull()
  })

  it('race: first candidate taken → offer-only retry promotes the next', async () => {
    const r = approved()
    const w1 = waiting(2, 3)
    const w2 = waiting(3, 3)
    const repo = makeMockRepo({
      getReservation: vi_fn(r),
      getWaitingForSubstitution: vi_fn([w1, w2]),
      applyCancellation: vi.fn(async () => ({ cancelled: 1, substitute_applied: 0, outbox_enqueued: 0, cancel_notice_enqueued: 1 })),
      applyOffer: vi.fn(async () => ({ offered: 1, outbox_enqueued: 1 })),
    })
    const summary = await cancelReservation({ reservationId: r.id, now: NOW_PRE }, asRepo(repo))

    expect(summary.cancelled).toBe(true)
    expect(summary.substituteReservationId).toBe(w2.id)
    expect(repo.applyOffer).toHaveBeenCalledOnce()
    expect(repo.applyOffer.mock.calls[0][1].id).toBe(w2.id) // not w1
  })

  it('rejects cancelling a temp_approved (use the offer endpoints)', async () => {
    const r = makeReservation({ status: 'temp_approved', weekly_event_id: EVENT })
    const repo = makeMockRepo({ getReservation: vi_fn(r) })
    await expect(cancelReservation({ reservationId: r.id }, asRepo(repo))).rejects.toThrow()
  })

  it('already cancelled → idempotent no-op (no RPC call)', async () => {
    const r = makeReservation({ status: 'cancelled_late', weekly_event_id: EVENT })
    const repo = makeMockRepo({ getReservation: vi_fn(r) })
    const summary = await cancelReservation({ reservationId: r.id, now: NOW_PRE }, asRepo(repo))

    expect(summary.cancelled).toBe(false)
    expect(summary.cancelStatus).toBe('cancelled_late')
    expect(summary.substituteOffered).toBe(false)
    expect(summary.confirmationEnqueued).toBe(false)   // no RPC → no confirmation
    expect(repo.applyCancellation).not.toHaveBeenCalled()
  })

  // ── Wave 1d (#27): the notice's date must never be able to block the cancel ────────────────
  describe('notification context', () => {
    it('stamps the week and no plate onto the cancel notice', async () => {
      const r = makeReservation({ status: 'pending', weekly_event_id: EVENT })
      const repo = makeMockRepo({
        getReservation: vi_fn(r),
        getPlatesForReservations: vi.fn(async () => new Map([[r.id, 'ABC-1234']])),
      })
      await cancelReservation({ reservationId: r.id, now: NOW_PRE }, asRepo(repo))

      const notice = repo.applyCancellation.mock.calls[0][0].cancelNotice
      expect(notice[0].payload.sunday_date).toBe('2026-06-21')
      // the member just pressed cancel — the plate adds nothing, so it is not even persisted
      expect(notice[0].payload).not.toHaveProperty('license_plate')
    })

    it('still cancels when the decorative date lookup fails (pending/waiting path)', async () => {
      // A pending/waiting cancel reads no event for its own logic. If a weekly_events blip could
      // throw here, a member would be unable to cancel — purely because a message wanted a date.
      const r = makeReservation({ status: 'waiting', weekly_event_id: EVENT })
      const repo = makeMockRepo({
        getReservation: vi_fn(r),
        getWeeklyEvent: vi.fn(async () => {
          throw new Error('db down')
        }),
      })
      const summary = await cancelReservation({ reservationId: r.id, now: NOW_PRE }, asRepo(repo))

      expect(summary.cancelled).toBe(true)
      expect(summary.cancelStatus).toBe('cancelled_by_user')
      expect(summary.confirmationEnqueued).toBe(true)

      const notice = repo.applyCancellation.mock.calls[0][0].cancelNotice
      expect(notice).toHaveLength(1)
      expect(notice[0].payload).not.toHaveProperty('sunday_date')
      // …and the member reads the vaguer, still-correct wording
      expect(renderTemplate('reservation_cancelled', notice[0].payload)).toContain('本週')
    })

    it('still cancels when the plate lookup fails', async () => {
      const r = makeReservation({ status: 'pending', weekly_event_id: EVENT })
      const repo = makeMockRepo({
        getReservation: vi_fn(r),
        getPlatesForReservations: vi.fn(async () => {
          throw new Error('db down')
        }),
      })
      const summary = await cancelReservation({ reservationId: r.id, now: NOW_PRE }, asRepo(repo))
      expect(summary.cancelled).toBe(true)
      expect(summary.confirmationEnqueued).toBe(true)
    })

    it('an APPROVED cancel still throws if the event read fails — that read is core', async () => {
      // The approved path derives the substitution offer's deadlines from the event. That is not
      // decoration, so it must not be swallowed the way the notification lookups are.
      const r = approved()
      const repo = makeMockRepo({
        getReservation: vi_fn(r),
        getWeeklyEvent: vi.fn(async () => {
          throw new Error('db down')
        }),
      })
      await expect(
        cancelReservation({ reservationId: r.id, now: NOW_PRE }, asRepo(repo)),
      ).rejects.toThrow(/db down/)
      expect(repo.applyCancellation).not.toHaveBeenCalled()
    })
  })
})
