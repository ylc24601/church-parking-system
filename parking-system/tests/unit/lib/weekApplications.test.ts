import { describe, expect, it } from 'vitest'
import { splitWeekApplications, type WeekApplicationRow } from '@/lib/weekApplications'

const row = (over: Partial<WeekApplicationRow>): WeekApplicationRow => ({
  id: 'res-1',
  status: 'pending',
  effective_priority: 3,
  allocation_order: null,
  applied_at: '2026-06-15T01:00:00Z',
  display_name: '王小明',
  license_plate: 'ABC-1234',
  ...over,
})

describe('splitWeekApplications', () => {
  it('splits rows into pending and waiting by status', () => {
    const { pending, waiting } = splitWeekApplications([
      row({ id: 'p1', status: 'pending' }),
      row({ id: 'w1', status: 'waiting', allocation_order: 1 }),
    ])
    expect(pending.map(r => r.id)).toEqual(['p1'])
    expect(waiting.map(r => r.id)).toEqual(['w1'])
  })

  it('sorts pending by applied_at ascending (arrival order, not a predicted rank)', () => {
    const { pending } = splitWeekApplications([
      row({ id: 'late', status: 'pending', applied_at: '2026-06-15T03:00:00Z' }),
      row({ id: 'early', status: 'pending', applied_at: '2026-06-15T01:00:00Z' }),
      row({ id: 'mid', status: 'pending', applied_at: '2026-06-15T02:00:00Z' }),
    ])
    expect(pending.map(r => r.id)).toEqual(['early', 'mid', 'late'])
  })

  it('sorts waiting by allocation_order ascending — the real substitution order', () => {
    const { waiting } = splitWeekApplications([
      row({ id: 'third', status: 'waiting', allocation_order: 3 }),
      row({ id: 'first', status: 'waiting', allocation_order: 1 }),
      row({ id: 'second', status: 'waiting', allocation_order: 2 }),
    ])
    expect(waiting.map(r => r.id)).toEqual(['first', 'second', 'third'])
  })

  // ── waitingRank vs allocation_order (F-001) ─────────────────────────────────
  // The regression this guards: allocation_order is a GLOBAL index over approved +
  // waiting, so with capacity 19 the first waiting member carries 20 while LINE told
  // them 「候補第 1 位」. Every fixture above happens to use 1,2,3 — where the two
  // numbers coincide and the bug is invisible. These use capacity + N.
  it('numbers waitingRank from 1 even though allocation_order starts at capacity + 1', () => {
    const { waiting } = splitWeekApplications([
      row({ id: 'w21', status: 'waiting', allocation_order: 21 }),
      row({ id: 'w20', status: 'waiting', allocation_order: 20 }),
      row({ id: 'w22', status: 'waiting', allocation_order: 22 }),
    ])
    expect(waiting.map(r => [r.id, r.waitingRank])).toEqual([
      ['w20', 1],
      ['w21', 2],
      ['w22', 3],
    ])
    // allocation_order is carried through untouched — the rank is derived, not a rewrite.
    expect(waiting.map(r => r.allocation_order)).toEqual([20, 21, 22])
  })

  it('closes gaps left by substitution, matching the members live ranks', () => {
    // Orders 20 and 22 remain waiting; 21 was offered and is now temp_approved, so it is
    // not in this set. getWaitingRank would report 1 and 2 for these two members — the
    // raw orders (20, 22) would not.
    const { waiting } = splitWeekApplications([
      row({ id: 'w22', status: 'waiting', allocation_order: 22 }),
      row({ id: 'w20', status: 'waiting', allocation_order: 20 }),
    ])
    expect(waiting.map(r => [r.id, r.waitingRank])).toEqual([
      ['w20', 1],
      ['w22', 2],
    ])
  })

  it('pending rows carry no rank at all (no predicted position)', () => {
    const { pending } = splitWeekApplications([row({ id: 'p1', status: 'pending' })])
    expect(pending[0]).not.toHaveProperty('waitingRank')
  })

  // ── null allocation_order (N-005) ───────────────────────────────────────────
  // Defensive: the allocator always stamps an order onto a waiting row. Asserted so
  // "nulls last" holds by construction rather than by SortCompare coercing NaN to +0.
  it('sorts a null allocation_order last instead of relying on NaN coercion', () => {
    const { waiting } = splitWeekApplications([
      row({ id: 'wnull', status: 'waiting', allocation_order: null }),
      row({ id: 'w20', status: 'waiting', allocation_order: 20 }),
    ])
    expect(waiting.map(r => r.id)).toEqual(['w20', 'wnull'])
  })

  it('does not throw when every waiting row has a null allocation_order', () => {
    const { waiting } = splitWeekApplications([
      row({ id: 'a', status: 'waiting', allocation_order: null }),
      row({ id: 'b', status: 'waiting', allocation_order: null }),
    ])
    expect(waiting).toHaveLength(2)
    expect(waiting.map(r => r.waitingRank)).toEqual([1, 2])
  })

  it('does not mutate the input array order', () => {
    const input = [
      row({ id: 'b', status: 'pending', applied_at: '2026-06-15T02:00:00Z' }),
      row({ id: 'a', status: 'pending', applied_at: '2026-06-15T01:00:00Z' }),
    ]
    const before = input.map(r => r.id)
    splitWeekApplications(input)
    expect(input.map(r => r.id)).toEqual(before)
  })

  it('returns empty arrays for an empty input', () => {
    expect(splitWeekApplications([])).toEqual({ pending: [], waiting: [] })
  })
})
