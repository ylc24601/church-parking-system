import { describe, expect, it } from 'vitest'
import { allocate, computeCapacity, countActiveFullTimeStaffReserved } from '@/lib/allocation/allocate'
import { DEFAULT_TOTAL_CAPACITY } from '@/lib/allocation/rules'
import { makeReservation, makeStaffAllocation, T } from './helpers'

// ── countActiveFullTimeStaffReserved ─────────────────────────────────────────

describe('countActiveFullTimeStaffReserved', () => {
  it('returns 0 for an empty roster', () => {
    expect(countActiveFullTimeStaffReserved([])).toBe(0)
  })

  it('counts only reserved staff', () => {
    const allocations = [
      makeStaffAllocation({ status: 'reserved' }),
      makeStaffAllocation({ status: 'reserved' }),
      makeStaffAllocation({ status: 'skipped' }),
    ]
    expect(countActiveFullTimeStaffReserved(allocations)).toBe(2)
  })

  it('ignores skipped, attended and no_show', () => {
    const allocations = [
      makeStaffAllocation({ status: 'skipped' }),
      makeStaffAllocation({ status: 'attended' }),
      makeStaffAllocation({ status: 'no_show' }),
    ]
    expect(countActiveFullTimeStaffReserved(allocations)).toBe(0)
  })
})

// ── computeCapacity ────────────────────────────────────────────────────────

describe('computeCapacity', () => {
  it('returns total when nothing is reserved', () => {
    expect(computeCapacity({ total_capacity: DEFAULT_TOTAL_CAPACITY, admin_reserved: 0, blocked_spaces: 0 }, 0)).toBe(23)
  })

  it('subtracts guest_reserved (admin_reserved)', () => {
    expect(computeCapacity({ total_capacity: DEFAULT_TOTAL_CAPACITY, admin_reserved: 2, blocked_spaces: 0 }, 0)).toBe(21)
  })

  it('subtracts guest_reserved and blocked_spaces', () => {
    expect(computeCapacity({ total_capacity: DEFAULT_TOTAL_CAPACITY, admin_reserved: 2, blocked_spaces: 3 }, 0)).toBe(18)
  })

  it('subtracts active full-time staff reserved', () => {
    expect(computeCapacity({ total_capacity: DEFAULT_TOTAL_CAPACITY, admin_reserved: 0, blocked_spaces: 0 }, 5)).toBe(18)
  })

  it('subtracts all four terms together', () => {
    // 23 - blocked(3) - guest(2) - staff(4) = 14
    expect(computeCapacity({ total_capacity: DEFAULT_TOTAL_CAPACITY, admin_reserved: 2, blocked_spaces: 3 }, 4)).toBe(14)
  })

  it('returns 0 when fully reserved across all terms', () => {
    expect(computeCapacity({ total_capacity: DEFAULT_TOTAL_CAPACITY, admin_reserved: 13, blocked_spaces: 0 }, 10)).toBe(0)
  })

  it('throws when guest + blocked + staff exceeds total', () => {
    expect(() =>
      computeCapacity({ total_capacity: DEFAULT_TOTAL_CAPACITY, admin_reserved: 10, blocked_spaces: 5 }, 10),
    ).toThrow()
  })

  // ── A P1 who needs no system-managed space leaves one in the public pool ───
  // 'skipped' means "does not need one of the 23 this week" — typically because they
  // use the church-managed staff area, which is outside this system. It is NOT
  // "absent from church" (see WeeklyStaffAllocation in lib/types.ts).

  it('a P1 needing no system space leaves one more in the public pool', () => {
    const event = { total_capacity: DEFAULT_TOTAL_CAPACITY, admin_reserved: 0, blocked_spaces: 0 }
    const allReserved = [
      makeStaffAllocation(),
      makeStaffAllocation(),
      makeStaffAllocation(),
    ]
    const oneSkipped = [
      makeStaffAllocation(),
      makeStaffAllocation(),
      makeStaffAllocation({ status: 'skipped', skip_reason: '停教會自管停車區' }),
    ]
    const capAll     = computeCapacity(event, countActiveFullTimeStaffReserved(allReserved))
    const capSkipped = computeCapacity(event, countActiveFullTimeStaffReserved(oneSkipped))
    expect(capAll).toBe(20)
    expect(capSkipped).toBe(21)
  })
})

// ── allocate ───────────────────────────────────────────────────────────────

describe('allocate', () => {
  it('approves up to capacity and puts the rest in waiting', () => {
    const reservations = Array.from({ length: 5 }, () => makeReservation())
    const { reservations: result } = allocate(reservations, 3, T.FRI_18)

    const approved = result.filter(r => r.status === 'approved')
    const waiting  = result.filter(r => r.status === 'waiting')
    expect(approved).toHaveLength(3)
    expect(waiting).toHaveLength(2)
  })

  it('approves all when capacity exceeds applications', () => {
    const reservations = [makeReservation(), makeReservation()]
    const { reservations: result } = allocate(reservations, 10, T.FRI_18)

    expect(result.every(r => r.status === 'approved')).toBe(true)
  })

  it('puts all in waiting when capacity is 0', () => {
    const reservations = [makeReservation(), makeReservation()]
    const { reservations: result } = allocate(reservations, 0, T.FRI_18)

    expect(result.every(r => r.status === 'waiting')).toBe(true)
  })

  it('emits reservation_approved outbox for each approved', () => {
    const reservations = [makeReservation(), makeReservation()]
    const { outbox } = allocate(reservations, 2, T.FRI_18)

    expect(outbox.filter(o => o.template_key === 'reservation_approved')).toHaveLength(2)
  })

  it('emits reservation_waiting outbox for each waiting', () => {
    const reservations = Array.from({ length: 3 }, () => makeReservation())
    const { outbox } = allocate(reservations, 1, T.FRI_18)

    expect(outbox.filter(o => o.template_key === 'reservation_waiting')).toHaveLength(2)
  })

  it('P1 always ranks before P3', () => {
    const p3 = makeReservation({ effective_priority: 3, applied_at: new Date('2026-06-15T00:00:00Z') })
    const p1 = makeReservation({ effective_priority: 1, applied_at: new Date('2026-06-15T02:00:00Z') })
    const { reservations: result } = allocate([p3, p1], 1, T.FRI_18)

    expect(result.find(r => r.id === p1.id)?.status).toBe('approved')
    expect(result.find(r => r.id === p3.id)?.status).toBe('waiting')
  })

  it('P2 declared this week ranks before P3', () => {
    const p3 = makeReservation({ effective_priority: 3 })
    const p2 = makeReservation({ effective_priority: 2 })
    const { reservations: result } = allocate([p3, p2], 1, T.FRI_18)

    expect(result.find(r => r.id === p2.id)?.status).toBe('approved')
    expect(result.find(r => r.id === p3.id)?.status).toBe('waiting')
  })

  it('P2 NOT declared this week is treated as P3', () => {
    const p2undeclared = makeReservation({ effective_priority: 3 /* caller already set this */ })
    const p3early = makeReservation({
      effective_priority: 3,
      applied_at: new Date('2026-06-15T00:00:00Z'),
    })
    const { reservations: result } = allocate([p2undeclared, p3early], 1, T.FRI_18)
    // p3early applied first, so it wins among P3s
    expect(result.find(r => r.id === p3early.id)?.status).toBe('approved')
  })

  it('lower penalty_score wins within same priority', () => {
    const penalised = makeReservation({ effective_priority: 3, penalty_score: 2 })
    const clean     = makeReservation({ effective_priority: 3, penalty_score: 0 })
    const { reservations: result } = allocate([penalised, clean], 1, T.FRI_18)

    expect(result.find(r => r.id === clean.id)?.status).toBe('approved')
    expect(result.find(r => r.id === penalised.id)?.status).toBe('waiting')
  })

  it('null last_attended beats a date (never-attended has highest rotation priority)', () => {
    const veteran = makeReservation({
      effective_priority: 3,
      penalty_score: 0,
      last_successful_attended_at: new Date('2026-01-05T00:00:00Z'),
    })
    const newcomer = makeReservation({
      effective_priority: 3,
      penalty_score: 0,
      last_successful_attended_at: null,
    })
    const { reservations: result } = allocate([veteran, newcomer], 1, T.FRI_18)
    expect(result.find(r => r.id === newcomer.id)?.status).toBe('approved')
  })

  it('earlier last_attended wins among those who have attended before', () => {
    const recent = makeReservation({
      effective_priority: 3,
      last_successful_attended_at: new Date('2026-06-07T00:00:00Z'),
    })
    const older = makeReservation({
      effective_priority: 3,
      last_successful_attended_at: new Date('2026-05-01T00:00:00Z'),
    })
    const { reservations: result } = allocate([recent, older], 1, T.FRI_18)
    expect(result.find(r => r.id === older.id)?.status).toBe('approved')
  })

  it('earlier applied_at breaks tie when everything else equal', () => {
    const late  = makeReservation({ effective_priority: 3, applied_at: new Date('2026-06-17T02:00:00Z') })
    const early = makeReservation({ effective_priority: 3, applied_at: new Date('2026-06-16T02:00:00Z') })
    const { reservations: result } = allocate([late, early], 1, T.FRI_18)
    expect(result.find(r => r.id === early.id)?.status).toBe('approved')
  })

  // ── allocation_order snapshot ──────────────────────────────────────────────

  it('assigns allocation_order 1..N in fairness-sort order', () => {
    // p2 sorts first (priority 2), p3early second, p3late third
    const p3late  = makeReservation({ effective_priority: 3, applied_at: new Date('2026-06-17T00:00:00Z') })
    const p2       = makeReservation({ effective_priority: 2 })
    const p3early = makeReservation({ effective_priority: 3, applied_at: new Date('2026-06-15T00:00:00Z') })
    const { reservations: result } = allocate([p3late, p2, p3early], 3, T.FRI_18)

    expect(result.find(r => r.id === p2.id)?.allocation_order).toBe(1)
    expect(result.find(r => r.id === p3early.id)?.allocation_order).toBe(2)
    expect(result.find(r => r.id === p3late.id)?.allocation_order).toBe(3)
  })

  it('assigns allocation_order to BOTH approved and waiting', () => {
    const reservations = Array.from({ length: 4 }, () => makeReservation())
    const { reservations: result } = allocate(reservations, 2, T.FRI_18)

    expect(result.every(r => r.allocation_order !== null)).toBe(true)
    const orders = result.map(r => r.allocation_order).sort((a, b) => a! - b!)
    expect(orders).toEqual([1, 2, 3, 4])
  })

  it('allocation_order reflects sort, not input array order', () => {
    const first  = makeReservation({ effective_priority: 3, applied_at: new Date('2026-06-17T00:00:00Z') })
    const second = makeReservation({ effective_priority: 1, applied_at: new Date('2026-06-18T00:00:00Z') })
    const { reservations: result } = allocate([first, second], 2, T.FRI_18)
    // second is P1 → sorts first → allocation_order 1
    expect(result.find(r => r.id === second.id)?.allocation_order).toBe(1)
    expect(result.find(r => r.id === first.id)?.allocation_order).toBe(2)
  })

  it('sets approved_at = now on approved, leaves waiting approved_at null', () => {
    const reservations = [makeReservation(), makeReservation()]
    const { reservations: result } = allocate(reservations, 1, T.FRI_18)

    const approved = result.find(r => r.status === 'approved')
    const waiting  = result.find(r => r.status === 'waiting')
    expect(approved?.approved_at?.getTime()).toBe(T.FRI_18.getTime())
    expect(waiting?.approved_at).toBeNull()
  })

  // ── Idempotency ──────────────────────────────────────────────────────────

  it('is idempotent: running twice produces the same approved set', () => {
    const reservations = Array.from({ length: 5 }, () => makeReservation())
    const { reservations: firstPass }  = allocate(reservations, 3, T.FRI_18)
    const { reservations: secondPass } = allocate(firstPass, 3, T.FRI_18)

    const approvedFirst  = new Set(firstPass .filter(r => r.status === 'approved').map(r => r.id))
    const approvedSecond = new Set(secondPass.filter(r => r.status === 'approved').map(r => r.id))
    expect(approvedFirst).toEqual(approvedSecond)
  })

  it('does not re-emit outbox on second run (no pending left)', () => {
    const reservations = Array.from({ length: 3 }, () => makeReservation())
    const { reservations: firstPass } = allocate(reservations, 2, T.FRI_18)
    const { outbox: secondOutbox }    = allocate(firstPass, 2, T.FRI_18)
    expect(secondOutbox).toHaveLength(0)
  })

  it('rerun does not overwrite existing allocation_order or approved_at', () => {
    const reservations = Array.from({ length: 5 }, () => makeReservation())
    const { reservations: firstPass } = allocate(reservations, 3, T.FRI_18)

    const orderBefore = new Map(firstPass.map(r => [r.id, r.allocation_order]))
    const approvedAtBefore = new Map(firstPass.map(r => [r.id, r.approved_at?.getTime() ?? null]))

    // Rerun with a different `now` and a different capacity — nothing should change.
    const { reservations: secondPass } = allocate(firstPass, 1, T.SUN_1000)

    for (const r of secondPass) {
      expect(r.allocation_order).toBe(orderBefore.get(r.id))
      expect(r.approved_at?.getTime() ?? null).toBe(approvedAtBefore.get(r.id))
    }
  })

  it('does not modify non-pending reservations', () => {
    const already = makeReservation({ status: 'approved' })
    const pending  = makeReservation({ status: 'pending'  })
    const { reservations: result } = allocate([already, pending], 1, T.FRI_18)
    expect(result.find(r => r.id === already.id)?.status).toBe('approved')
  })
})
