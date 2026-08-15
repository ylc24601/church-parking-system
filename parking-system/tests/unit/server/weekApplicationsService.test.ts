import { describe, expect, it, vi } from 'vitest'
import { makeMockRepo, asRepo, type MockRepo } from './mockRepo'
import { getWeekApplications } from '@/server/services/weekApplicationsService'
import { upcomingSundayISO } from '@/lib/taipeiDate'
import type { WeekApplicationRow } from '@/lib/weekApplications'

const NOW = new Date('2026-07-12T00:00:00Z')
const SUNDAY = upcomingSundayISO(NOW)

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

describe('getWeekApplications', () => {
  it('no weekly_events row → empty pending/waiting (not an error)', async () => {
    const repo: MockRepo = makeMockRepo({ getWeeklyEventBySunday: vi.fn(async () => null) })
    const res = await getWeekApplications({ now: NOW }, asRepo(repo))
    expect(res).toEqual({ sunday: SUNDAY, pending: [], waiting: [] })
    expect(repo.listWeekApplications).not.toHaveBeenCalled()
  })

  it('resolves the event by the Taipei calendar upcoming Sunday, not getActiveEvent', async () => {
    const repo: MockRepo = makeMockRepo({
      getWeeklyEventBySunday: vi.fn(async () => ({ id: 'event-9', sunday_date: SUNDAY, status: 'open' })),
    })
    await getWeekApplications({ now: NOW }, asRepo(repo))
    expect(repo.getWeeklyEventBySunday).toHaveBeenCalledWith(SUNDAY)
    expect(repo.getActiveEvent).not.toHaveBeenCalled()
  })

  it('splits and sorts the repo rows via splitWeekApplications', async () => {
    const repo: MockRepo = makeMockRepo({
      getWeeklyEventBySunday: vi.fn(async () => ({ id: 'event-9', sunday_date: SUNDAY, status: 'open' })),
      listWeekApplications: vi.fn(async () => [
        row({ id: 'w2', status: 'waiting', allocation_order: 2 }),
        row({ id: 'p1', status: 'pending', applied_at: '2026-06-15T01:00:00Z' }),
        row({ id: 'w1', status: 'waiting', allocation_order: 1 }),
      ]),
    })
    const res = await getWeekApplications({ now: NOW }, asRepo(repo))
    expect(res.sunday).toBe(SUNDAY)
    expect(res.pending.map(r => r.id)).toEqual(['p1'])
    expect(res.waiting.map(r => r.id)).toEqual(['w1', 'w2'])
    expect(repo.listWeekApplications).toHaveBeenCalledWith('event-9')
  })

  // The service is where waitingRank gets assigned, i.e. over the week's COMPLETE waiting
  // set — before any presentational ?priority= filter in the page. Asserted here (not only
  // in the pure test) because moving the numbering downstream of that filter is the one
  // refactor that would silently re-break F-001.
  it('assigns waitingRank from the full waiting set, independent of allocation_order values', async () => {
    const repo: MockRepo = makeMockRepo({
      getWeeklyEventBySunday: vi.fn(async () => ({ id: 'event-9', sunday_date: SUNDAY, status: 'open' })),
      listWeekApplications: vi.fn(async () => [
        row({ id: 'p2row', status: 'waiting', effective_priority: 2, allocation_order: 20 }),
        row({ id: 'p3row', status: 'waiting', effective_priority: 3, allocation_order: 21 }),
      ]),
    })
    const res = await getWeekApplications({ now: NOW }, asRepo(repo))
    expect(res.waiting.map(r => [r.id, r.waitingRank])).toEqual([['p2row', 1], ['p3row', 2]])
  })
})
