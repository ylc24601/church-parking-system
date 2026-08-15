import { describe, expect, it } from 'vitest'
import { isPriorityBand, matchesBand, parseWeekFilters } from '@/app/admin/week/parseWeekFilters'
import { splitWeekApplications, type WeekApplicationRow } from '@/lib/weekApplications'

// #35 — ?status= / ?priority= are public input (stale bookmarks, hand-typed URLs). The
// property under test is that an unrecognised value means "no filter", never "no rows":
// a page with no sections and no message reads as broken, on the one page an operator
// opens when they already suspect something is wrong.
describe('parseWeekFilters — status', () => {
  it('no status → both sections', () => {
    const f = parseWeekFilters({})
    expect([f.showPending, f.showWaiting]).toEqual([true, true])
  })

  it('status=pending → pending only', () => {
    const f = parseWeekFilters({ status: 'pending' })
    expect([f.showPending, f.showWaiting]).toEqual([true, false])
  })

  it('status=waiting → waiting only', () => {
    const f = parseWeekFilters({ status: 'waiting' })
    expect([f.showPending, f.showWaiting]).toEqual([false, true])
  })

  it.each([
    ['unknown value', 'foo'],
    ['empty string', ''],
    ['wrong case', 'Pending'],
    ['a status this page does not list', 'approved'],
  ])('%s falls back to both sections, never to none', (_label, status) => {
    const f = parseWeekFilters({ status })
    expect([f.showPending, f.showWaiting]).toEqual([true, true])
  })

  it('repeated param (string[]) falls back to both sections', () => {
    const f = parseWeekFilters({ status: ['pending', 'waiting'] })
    expect([f.showPending, f.showWaiting]).toEqual([true, true])
  })
})

describe('parseWeekFilters — priority band', () => {
  it.each([
    ['no priority', undefined, null],
    ['1 (P1 is 優先 too)', '1', 'priority'],
    ['2', '2', 'priority'],
    ['3', '3', 'general'],
    ['unknown', 'foo', null],
    ['empty', '', null],
    ['out of range', '4', null],
  ])('%s → %s', (_label, priority, expected) => {
    expect(parseWeekFilters({ priority }).band).toBe(expected)
  })

  it('repeated param falls back to both bands', () => {
    expect(parseWeekFilters({ priority: ['1', '3'] }).band).toBeNull()
  })
})

describe('isPriorityBand / matchesBand', () => {
  it.each([[1, true], [2, true], [3, false]])('effective_priority %i → priority band %s', (p, expected) => {
    expect(isPriorityBand(p)).toBe(expected)
  })

  it('a null band matches every row', () => {
    expect([1, 2, 3].every(p => matchesBand(p, null))).toBe(true)
  })

  it('priority band keeps 1 and 2, drops 3', () => {
    expect([1, 2, 3].filter(p => matchesBand(p, 'priority'))).toEqual([1, 2])
  })

  it('general band keeps only 3 — never lets a priority row through', () => {
    expect([1, 2, 3].filter(p => matchesBand(p, 'general'))).toEqual([3])
  })
})

// ── The composition the page actually performs (F-001 / N-010) ────────────────
// The service ranks the COMPLETE waiting set, then the page filters. Ranking and
// filtering are correct in isolation and were each tested that way — but that pair of
// tests still passes if someone renumbers the filtered subset, which is the exact way
// F-001 comes back. These exercise splitWeekApplications and matchesBand together, in
// the same order and with the same functions app/admin/week/page.tsx uses.
describe('rank-then-filter composition', () => {
  const waiting = (id: string, effective_priority: 1 | 2 | 3, allocation_order: number): WeekApplicationRow => ({
    id,
    status: 'waiting',
    effective_priority,
    allocation_order,
    applied_at: '2026-06-15T01:00:00Z',
    display_name: id,
    license_plate: 'ABC-1234',
  })

  // Post-allocation shape: orders start at capacity + 1, and the P2 member ahead is the
  // one a ?priority=3 view removes.
  const rows = [waiting('p2row', 2, 20), waiting('p3row', 3, 22)]

  it('a filtered view keeps the members real position, it does not renumber from 1', () => {
    const { waiting: ranked } = splitWeekApplications(rows)
    expect(ranked.map(r => [r.id, r.waitingRank])).toEqual([['p2row', 1], ['p3row', 2]])

    const general = ranked.filter(r => matchesBand(r.effective_priority, 'general'))
    expect(general).toHaveLength(1)
    // The regression: renumbering the subset would make this 1, and the operator would
    // read 「第 1 位」 to a member whom LINE told 「候補第 2 位」.
    expect(general[0].waitingRank).toBe(2)
  })

  it('the priority band view is likewise unrenumbered', () => {
    const { waiting: ranked } = splitWeekApplications(rows)
    const priority = ranked.filter(r => matchesBand(r.effective_priority, 'priority'))
    expect(priority.map(r => [r.id, r.waitingRank])).toEqual([['p2row', 1]])
  })

  it('filtering never rewrites allocation_order either', () => {
    const { waiting: ranked } = splitWeekApplications(rows)
    const general = ranked.filter(r => matchesBand(r.effective_priority, 'general'))
    expect(general[0].allocation_order).toBe(22)
  })
})
