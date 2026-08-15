import { describe, expect, it, vi } from 'vitest'
import { runFridayAllocation } from '@/server/services/fridayAllocationService'
import { buildReleaseDeadlines } from '@/lib/allocation/release'
import type {
  ApplyResult,
  CapacityInputs,
  OutboxRow,
  ParkingRepository,
  ReservationUpdate,
  WeeklyEventRow,
} from '@/server/repositories/parkingRepository'
import type { ReservationForAllocation } from '@/lib/types'
import { makeReservation } from '../allocation/helpers'

const SUNDAY = '2026-06-21'
const EVENT_ID = 'event-1'

function makeRepo(opts: {
  capacity: Partial<CapacityInputs>
  pending: ReservationForAllocation[]
  applyResult?: ApplyResult
  applyThrows?: Error
  plates?: Map<string, string>
  platesThrow?: Error
}): {
  repo: ParkingRepository
  applySpy: ReturnType<typeof vi.fn>
  markFailedSpy: ReturnType<typeof vi.fn>
} {
  const applySpy = vi.fn(async (): Promise<ApplyResult> => {
    if (opts.applyThrows) throw opts.applyThrows
    return opts.applyResult ?? { skipped: false, updated: 0, outbox_enqueued: 0 }
  })
  const markFailedSpy = vi.fn(async () => {})

  // Only the methods this Friday-allocation test exercises; cast since the full
  // ParkingRepository surface (cancellation/offer methods) is unused here.
  const repo = {
    // Lock-protocol claim (0023): default = freshly claimed.
    claimFridayAllocation: vi.fn(async () => ({ claimed: true, reason: 'claimed' })),
    getWeeklyEvent: async (): Promise<WeeklyEventRow> =>
      ({ id: EVENT_ID, sunday_date: SUNDAY, status: 'open' }),
    getCapacityInputs: async (): Promise<CapacityInputs> => ({
      weekly_event_id: EVENT_ID,
      total_capacity: 23,
      blocked_spaces: 0,
      admin_reserved: 0,
      active_full_time_staff_reserved: 0,
      ...opts.capacity,
    }),
    getPendingForAllocation: async () => opts.pending,
    // Wave 1d (#27) — plates for the approved/waiting notices. Decoration only, hence fail-soft.
    getPlatesForReservations: async () => {
      if (opts.platesThrow) throw opts.platesThrow
      return opts.plates ?? new Map<string, string>()
    },
    applyFridayAllocation: applySpy as ParkingRepository['applyFridayAllocation'],
    markJobFailed: markFailedSpy as ParkingRepository['markJobFailed'],
  } as unknown as ParkingRepository
  return { repo, applySpy, markFailedSpy }
}

// capacity 2: 1 P2 + 2 P3 → P2 + one P3 approved, one P3 waiting.
function pendingMix(): ReservationForAllocation[] {
  return [
    makeReservation({ effective_priority: 2 }),                  // P2
    makeReservation({ effective_priority: 3, applied_at: new Date('2026-06-15T01:00:00Z') }),
    makeReservation({ effective_priority: 3, applied_at: new Date('2026-06-15T02:00:00Z') }),
  ]
}

describe('runFridayAllocation (mocked repo)', () => {
  it('approves up to capacity, sets allocation_order 1..N, one outbox per reservation', async () => {
    const pending = pendingMix()
    const { repo, applySpy } = makeRepo({ capacity: { total_capacity: 2 }, pending })

    const summary = await runFridayAllocation({ eventId: EVENT_ID, now: new Date('2026-06-19T10:00:00Z') }, repo)

    expect(summary.plannedApproved).toBe(2)
    expect(summary.plannedWaiting).toBe(1)

    const [, , updates, outbox] = applySpy.mock.calls[0] as [string, string, ReservationUpdate[], OutboxRow[]]
    const approved = updates.filter(u => u.status === 'approved')
    const waiting = updates.filter(u => u.status === 'waiting')
    expect(approved).toHaveLength(2)
    expect(waiting).toHaveLength(1)
    expect([...updates].map(u => u.allocation_order).sort()).toEqual([1, 2, 3])

    // one outbox entry per reservation, all with the friday_allocation dedupe key
    expect(outbox).toHaveLength(3)
    expect(outbox.every(o => o.dedupe_key === `friday_allocation:${o.reservation_id}`)).toBe(true)
  })

  it('stamps release_deadline_at: P2 approved → 10:30 (same as P3), waiting → null', async () => {
    const pending = pendingMix()
    const { repo, applySpy } = makeRepo({ capacity: { total_capacity: 2 }, pending })
    await runFridayAllocation({ eventId: EVENT_ID }, repo)

    const [, , updates] = applySpy.mock.calls[0] as [string, string, ReservationUpdate[], OutboxRow[]]
    const priorityById = new Map(pending.map(p => [p.id, p.effective_priority]))
    const deadlines = buildReleaseDeadlines(SUNDAY)

    for (const u of updates) {
      if (u.status === 'waiting') {
        expect(u.release_deadline_at).toBeNull()
      } else if (priorityById.get(u.id) === 2) {
        expect(u.release_deadline_at).toBe(deadlines.p2.toISOString())
      } else {
        expect(u.release_deadline_at).toBe(deadlines.p3.toISOString())
      }
    }
  })

  it('returns jobStatus=skipped when the RPC reports skipped (second run)', async () => {
    const { repo } = makeRepo({
      capacity: { total_capacity: 2 },
      pending: pendingMix(),
      applyResult: { skipped: true },
    })
    const summary = await runFridayAllocation({ eventId: EVENT_ID }, repo)
    expect(summary.jobStatus).toBe('skipped')
  })

  it('short-circuits on a refused claim (already succeeded) without reading the snapshot', async () => {
    const { repo, applySpy } = makeRepo({ capacity: { total_capacity: 2 }, pending: pendingMix() })
    ;(repo.claimFridayAllocation as ReturnType<typeof vi.fn>).mockResolvedValue({
      claimed: false, reason: 'already_succeeded',
    })
    const summary = await runFridayAllocation({ eventId: EVENT_ID }, repo)
    expect(summary).toEqual({
      jobStatus: 'skipped', plannedApproved: 0, plannedWaiting: 0, updated: null, outboxEnqueued: null,
    })
    expect(applySpy).not.toHaveBeenCalled()
  })

  it('claims BEFORE reading the pending snapshot (the lock-protocol ordering)', async () => {
    const order: string[] = []
    const { repo } = makeRepo({ capacity: { total_capacity: 2 }, pending: pendingMix() })
    ;(repo.claimFridayAllocation as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push('claim')
      return { claimed: true, reason: 'claimed' }
    })
    const origPending = repo.getPendingForAllocation.bind(repo)
    repo.getPendingForAllocation = (async (eventId: string) => {
      order.push('snapshot')
      return origPending(eventId)
    }) as ParkingRepository['getPendingForAllocation']
    await runFridayAllocation({ eventId: EVENT_ID }, repo)
    expect(order).toEqual(['claim', 'snapshot'])
  })

  it('records a failed job (upsert) and rethrows when the RPC throws', async () => {
    const boom = new Error('rpc exploded')
    const { repo, markFailedSpy } = makeRepo({
      capacity: { total_capacity: 2 },
      pending: pendingMix(),
      applyThrows: boom,
    })
    await expect(runFridayAllocation({ eventId: EVENT_ID }, repo)).rejects.toThrow('rpc exploded')
    expect(markFailedSpy).toHaveBeenCalledOnce()
    expect(markFailedSpy.mock.calls[0][0]).toBe(EVENT_ID)
    expect(markFailedSpy.mock.calls[0][1]).toBe('friday_allocation')
  })

  // ── Wave 1d (#27) ─────────────────────────────────────────────────────────────────────────
  describe('notification context', () => {
    it('stamps the week and each member’s plate onto the approved/waiting notices', async () => {
      const pending = pendingMix()
      const plates = new Map(pending.map((r, i) => [r.id, `TEST-${i + 1}`]))
      const { repo, applySpy } = makeRepo({ capacity: { total_capacity: 2 }, pending, plates })

      await runFridayAllocation({ eventId: EVENT_ID, now: new Date('2026-06-19T10:00:00Z') }, repo)

      const outbox = applySpy.mock.calls[0][3] as OutboxRow[]
      expect(outbox).toHaveLength(3)
      for (const row of outbox) {
        expect(row.payload.sunday_date).toBe(SUNDAY)
        expect(row.payload.license_plate).toBe(plates.get(row.reservation_id as string))
      }
      // the waiting notice keeps its rank alongside the new context
      const waiting = outbox.find(o => o.template_key === 'reservation_waiting')
      expect(waiting?.payload.rank).toBe(1)
    })

    it('allocates the week as normal when the plate lookup fails', async () => {
      // The plate read happens AFTER the job is claimed, so a throw would land in the catch above
      // and mark the whole week failed. A message detail must never cost the allocation.
      const pending = pendingMix()
      const { repo, applySpy, markFailedSpy } = makeRepo({
        capacity: { total_capacity: 2 },
        pending,
        platesThrow: new Error('db down'),
      })

      const summary = await runFridayAllocation(
        { eventId: EVENT_ID, now: new Date('2026-06-19T10:00:00Z') },
        repo,
      )

      expect(summary.jobStatus).toBe('success')
      expect(summary.plannedApproved).toBe(2)
      expect(markFailedSpy).not.toHaveBeenCalled()
      const outbox = applySpy.mock.calls[0][3] as OutboxRow[]
      expect(outbox).toHaveLength(3)
      for (const row of outbox) {
        expect(row.payload.sunday_date).toBe(SUNDAY)
        expect(row.payload).not.toHaveProperty('license_plate')
      }
    })
  })
})
