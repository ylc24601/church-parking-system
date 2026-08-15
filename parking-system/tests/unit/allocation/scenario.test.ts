import { describe, expect, it } from 'vitest'
import {
  allocate,
  computeCapacity,
  countActiveFullTimeStaffReserved,
} from '@/lib/allocation/allocate'
import { DEFAULT_TOTAL_CAPACITY } from '@/lib/allocation/rules'
import { makeReservation, makeStaffAllocation, T } from './helpers'

// Full-week allocation scenario tying capacity + Friday allocation + the
// allocation_order snapshot together end to end.
describe('scenario: full-week allocation', () => {
  // ── Setup ────────────────────────────────────────────────────────────────
  // 23 total − 1 blocked − 2 guest_reserved − 2 P1 needing a system space = 18
  // (3 staff on the weekly list: 2 need one of the 23 this week, 1 uses the
  //  church-managed area and therefore consumes nothing here)
  const event = {
    total_capacity: DEFAULT_TOTAL_CAPACITY,  // 23
    blocked_spaces: 1,
    admin_reserved: 2,                        // == guest_reserved
  }
  const staff = [
    makeStaffAllocation({ status: 'reserved' }),
    makeStaffAllocation({ status: 'reserved' }),
    makeStaffAllocation({ status: 'skipped', skip_reason: '停教會自管停車區' }),
  ]

  // 20 public applicants: 5 P2 (declared companion) + 15 P3, each a distinct
  // applied_at so the fairness sort is fully deterministic.
  const base = T.MON_09.getTime()
  const applicants = [
    ...Array.from({ length: 5 }, (_, i) =>
      makeReservation({ effective_priority: 2, applied_at: new Date(base + i * 60_000) }),
    ),
    ...Array.from({ length: 15 }, (_, i) =>
      makeReservation({ effective_priority: 3, applied_at: new Date(base + (100 + i) * 60_000) }),
    ),
  ]

  const capacity = computeCapacity(event, countActiveFullTimeStaffReserved(staff))
  const { reservations: result } = allocate(applicants, capacity, T.FRI_18)
  const approved = result.filter(r => r.status === 'approved')
  const waiting = result.filter(r => r.status === 'waiting')

  it('active P1 reserved is 2 (of 3 on the list, 2 need a system-managed space)', () => {
    expect(countActiveFullTimeStaffReserved(staff)).toBe(2)
  })

  it('public capacity is 18', () => {
    expect(capacity).toBe(18)
  })

  it('approved count does not exceed capacity (== 18 here)', () => {
    expect(approved.length).toBeLessThanOrEqual(18)
    expect(approved.length).toBe(18)
    expect(waiting.length).toBe(2)
  })

  it('all 5 P2 applicants are approved (priority beats P3)', () => {
    const approvedP2 = approved.filter(r => r.effective_priority === 2)
    expect(approvedP2).toHaveLength(5)
  })

  it('allocation_order is continuous 1..20 with no gaps or duplicates', () => {
    const orders = result.map(r => r.allocation_order).sort((a, b) => a! - b!)
    expect(orders).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
    expect(new Set(orders).size).toBe(20)
  })

  it('approved hold orders 1..18, waiting hold the tail 19..20', () => {
    const approvedOrders = approved.map(r => r.allocation_order!).sort((a, b) => a - b)
    const waitingOrders = waiting.map(r => r.allocation_order!).sort((a, b) => a - b)
    expect(approvedOrders).toEqual(Array.from({ length: 18 }, (_, i) => i + 1))
    expect(waitingOrders).toEqual([19, 20])
  })

  it('waiting reservations keep a (non-null) allocation_order', () => {
    expect(waiting.every(r => r.allocation_order !== null)).toBe(true)
  })

  it('approved carry approved_at = Friday allocation time; waiting do not', () => {
    expect(approved.every(r => r.approved_at?.getTime() === T.FRI_18.getTime())).toBe(true)
    expect(waiting.every(r => r.approved_at === null)).toBe(true)
  })
})
