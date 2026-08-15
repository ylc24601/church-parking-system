import { describe, expect, it, vi } from 'vitest'
import { resolveOffer } from '@/server/services/offerService'
import { buildReleaseDeadlines } from '@/lib/allocation/release'
import { asRepo, makeMockRepo } from './mockRepo'
import { makeReservation } from '../allocation/helpers'

const EVENT = 'event-1'
const NOW = new Date('2026-06-20T13:00:00Z') // pre Sunday-midnight
const deadlines = buildReleaseDeadlines('2026-06-21')
const vi_fn = (v: unknown) => vi.fn(async () => v)

const offer = (p: 2 | 3 = 3) => makeReservation({ status: 'temp_approved', weekly_event_id: EVENT, effective_priority: p })
const waiting = (order: number) =>
  makeReservation({ status: 'waiting', weekly_event_id: EVENT, effective_priority: 3, allocation_order: order })

describe('resolveOffer — confirm', () => {
  it('confirms → approved with release_deadline_at and a reservation_approved outbox', async () => {
    const r = offer(2) // P2 → 10:30
    const repo = makeMockRepo({
      getReservation: vi_fn(r),
      applyOfferResolution: vi.fn(async () => ({ resolved: 1, next_applied: 0, outbox_enqueued: 1, expired_blocked: false })),
    })
    const summary = await resolveOffer({ reservationId: r.id, action: 'confirm', now: NOW }, asRepo(repo))

    expect(summary.outcome).toBe('confirmed')
    expect(summary.resolved).toBe(true)
    const arg = repo.applyOfferResolution.mock.calls[0][0]
    expect(arg.outcome).toBe('confirmed')
    expect(arg.approved.release_deadline_at).toBe(deadlines.p2.toISOString())
    expect(arg.outbox[0].dedupe_key).toBe(`confirmed:${r.id}`)
    expect(arg.outbox[0].template_key).toBe('reservation_approved')
    expect(arg.next).toBeNull()
  })

  it('rejects confirming when the offer is not active', async () => {
    const r = makeReservation({ status: 'waiting', weekly_event_id: EVENT })
    const repo = makeMockRepo({ getReservation: vi_fn(r) })
    await expect(resolveOffer({ reservationId: r.id, action: 'confirm' }, asRepo(repo))).rejects.toThrow()
  })
})

describe('resolveOffer — decline', () => {
  it('declines and offers the next candidate', async () => {
    const r = offer()
    const w2 = waiting(3)
    const repo = makeMockRepo({
      getReservation: vi_fn(r),
      getWaitingForSubstitution: vi_fn([w2]),
      applyOfferResolution: vi.fn(async () => ({ resolved: 1, next_applied: 1, outbox_enqueued: 1, expired_blocked: false })),
    })
    const summary = await resolveOffer({ reservationId: r.id, action: 'decline', now: NOW }, asRepo(repo))

    expect(summary.resolved).toBe(true)
    expect(summary.substituteReservationId).toBe(w2.id)
    const arg = repo.applyOfferResolution.mock.calls[0][0]
    expect(arg.outcome).toBe('declined')
    expect(arg.next.id).toBe(w2.id)
  })

  it('race retry does NOT re-offer the just-declined row', async () => {
    const r = offer()                         // the declined offer (id R)
    const rAsWaiting = { ...r, status: 'waiting' as const } // it reverts to waiting after the resolve
    const w2 = waiting(3)
    const w3 = waiting(4)
    const getWaiting = vi.fn()
    getWaiting.mockResolvedValueOnce([w2])            // pre-resolution read (R is still temp_approved)
    getWaiting.mockResolvedValue([rAsWaiting, w3])    // retry read after the resolve committed
    const repo = makeMockRepo({
      getReservation: vi_fn(r),
      getWaitingForSubstitution: getWaiting,
      applyOfferResolution: vi.fn(async () => ({ resolved: 1, next_applied: 0, outbox_enqueued: 0, expired_blocked: false })), // w2 lost the race
      applyOffer: vi.fn(async () => ({ offered: 1, outbox_enqueued: 1 })),
    })

    const summary = await resolveOffer({ reservationId: r.id, action: 'decline', now: NOW }, asRepo(repo))

    expect(summary.substituteReservationId).toBe(w3.id)
    const offeredId = repo.applyOffer.mock.calls[0][1].id
    expect(offeredId).toBe(w3.id)
    expect(offeredId).not.toBe(r.id)   // never re-offers the just-declined row
    expect(offeredId).not.toBe(w2.id)
  })
})

describe('resolveOffer — enforceExpiry (member path)', () => {
  it('threads expiryGuard into the RPC and surfaces a blocked confirm as expiredBlocked', async () => {
    const r = offer()
    const repo = makeMockRepo({
      getReservation: vi_fn(r),
      applyOfferResolution: vi.fn(async () => ({ resolved: 0, next_applied: 0, outbox_enqueued: 0, expired_blocked: true })),
    })
    const summary = await resolveOffer(
      { reservationId: r.id, action: 'confirm', now: NOW, enforceExpiry: true }, asRepo(repo))

    expect(repo.applyOfferResolution.mock.calls[0][0].expiryGuard).toBe(true)
    expect(summary.resolved).toBe(false)
    expect(summary.expiredBlocked).toBe(true)
  })

  it('a blocked decline offers NO substitute (the sweep owns the lapsed row)', async () => {
    const r = offer()
    const w2 = waiting(3)
    const repo = makeMockRepo({
      getReservation: vi_fn(r),
      getWaitingForSubstitution: vi_fn([w2]),
      applyOfferResolution: vi.fn(async () => ({ resolved: 0, next_applied: 0, outbox_enqueued: 0, expired_blocked: true })),
    })
    const summary = await resolveOffer(
      { reservationId: r.id, action: 'decline', now: NOW, enforceExpiry: true }, asRepo(repo))

    expect(summary).toMatchObject({ resolved: false, expiredBlocked: true, substituteOffered: false })
    expect(repo.applyOffer).not.toHaveBeenCalled()   // no offer-only retry either
  })

  it('ops callers omit the flag → expiryGuard stays false (auto-approve past the cap keeps working)', async () => {
    const r = offer()
    const repo = makeMockRepo({ getReservation: vi_fn(r) })
    await resolveOffer({ reservationId: r.id, action: 'confirm', now: NOW }, asRepo(repo))
    expect(repo.applyOfferResolution.mock.calls[0][0].expiryGuard).toBe(false)
  })

  // ── Wave 1d (#27) ─────────────────────────────────────────────────────────────────────────
  // Each producer wires the helper itself, so each needs its own proof: the wiring is one line,
  // which is exactly how a call site gets missed.
  describe('notification context', () => {
    it('confirm → the approval notice carries the week and the plate', async () => {
      const r = offer(2)
      const repo = makeMockRepo({
        getReservation: vi_fn(r),
        getPlatesForReservations: vi.fn(async () => new Map([[r.id, 'ABC-1234']])),
      })
      await resolveOffer({ reservationId: r.id, action: 'confirm', now: NOW }, asRepo(repo))

      const outbox = repo.applyOfferResolution.mock.calls[0][0].outbox
      expect(outbox[0].template_key).toBe('reservation_approved')
      expect(outbox[0].payload).toEqual({ sunday_date: '2026-06-21', license_plate: 'ABC-1234' })
    })

    it('decline → the next candidate’s offer carries their OWN plate, not the decliner’s', async () => {
      const r = offer()
      const next = waiting(1)
      const repo = makeMockRepo({
        getReservation: vi_fn(r),
        getWaitingForSubstitution: vi_fn([next]),
        applyOfferResolution: vi.fn(async () => ({ resolved: 1, next_applied: 1, outbox_enqueued: 1, expired_blocked: false })),
        getPlatesForReservations: vi.fn(async () => new Map([[r.id, 'DECLINER-1'], [next.id, 'NEXT-2']])),
      })
      await resolveOffer({ reservationId: r.id, action: 'decline', now: NOW }, asRepo(repo))

      const outbox = repo.applyOfferResolution.mock.calls[0][0].outbox
      expect(outbox[0].template_key).toBe('offer_2hr_confirm')
      expect(outbox[0].reservation_id).toBe(next.id)
      expect(outbox[0].payload.license_plate).toBe('NEXT-2')
      expect(outbox[0].payload.sunday_date).toBe('2026-06-21')
      // the offer window the producer computed is untouched by the enrichment
      expect(outbox[0].payload.expires_at).toBeDefined()
    })
  })
})
