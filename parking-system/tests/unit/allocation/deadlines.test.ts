import { describe, expect, it } from 'vitest'
import { buildReleaseDeadlines, buildSundayMidnight, computeReleaseDeadline } from '@/lib/allocation/release'
import { computeCapacity } from '@/lib/allocation/allocate'
import { DEFAULT_TOTAL_CAPACITY } from '@/lib/allocation/rules'
import { T } from './helpers'

// Sunday 2026-06-21 as the 'YYYY-MM-DD' string supabase-js returns for a date column.
const SUNDAY = '2026-06-21'

describe('buildReleaseDeadlines', () => {
  it('builds 10:30 / 10:30 / 10:50 Taipei for the given Sunday', () => {
    const d = buildReleaseDeadlines(SUNDAY)
    expect(d.p3.getTime()).toBe(T.SUN_1030.getTime())
    expect(d.p2.getTime()).toBe(T.SUN_1030.getTime())
    expect(d.p2Grace.getTime()).toBe(T.SUN_1050.getTime())
  })

  it('composes with computeReleaseDeadline: P3 → p3', () => {
    const d = buildReleaseDeadlines(SUNDAY)
    expect(computeReleaseDeadline({ effective_priority: 3, p2_on_the_way: false }, d)).toBe(d.p3)
  })

  it('composes with computeReleaseDeadline: P2 not on the way → p2 (10:30, same as p3)', () => {
    const d = buildReleaseDeadlines(SUNDAY)
    expect(computeReleaseDeadline({ effective_priority: 2, p2_on_the_way: false }, d)).toBe(d.p2)
  })

  it('composes with computeReleaseDeadline: P2 on the way → p2Grace (10:50)', () => {
    const d = buildReleaseDeadlines(SUNDAY)
    expect(computeReleaseDeadline({ effective_priority: 2, p2_on_the_way: true }, d)).toBe(d.p2Grace)
  })

  it('throws for an unsupported timezone (MVP supports Asia/Taipei only)', () => {
    expect(() => buildReleaseDeadlines(SUNDAY, 'America/New_York')).toThrow()
  })
})

describe('buildSundayMidnight', () => {
  it('returns Sunday 00:00 Taipei (= Sat 16:00 UTC) for the given Sunday', () => {
    // 2026-06-21 00:00 Taipei = 2026-06-20T16:00:00Z
    expect(buildSundayMidnight('2026-06-21').toISOString()).toBe('2026-06-20T16:00:00.000Z')
  })

  it('throws on a malformed date', () => {
    expect(() => buildSundayMidnight('not-a-date')).toThrow()
  })
})

// Mirrors the v_weekly_capacity_inputs row shape; the SQL view supplies inputs and
// the pure computeCapacity owns the arithmetic (single source of the formula).
describe('capacity composition (view row → computeCapacity)', () => {
  it('23 − 1 blocked − 2 guest − 2 active P1 = 18', () => {
    const row = {
      total_capacity: DEFAULT_TOTAL_CAPACITY,
      blocked_spaces: 1,
      admin_reserved: 2,                  // == guest_reserved
      active_full_time_staff_reserved: 2,
    }
    expect(computeCapacity(row, row.active_full_time_staff_reserved)).toBe(18)
  })
})
