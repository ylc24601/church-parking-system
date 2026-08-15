import { describe, expect, it, vi } from 'vitest'
import { makeMockRepo, asRepo, type MockRepo } from './mockRepo'
import { getWeekOverview } from '@/server/services/adminOverviewService'
import { upcomingSundayISO } from '@/lib/taipeiDate'
import type { WeeklyCapacityAdminRow } from '@/server/repositories/parkingRepository'

const NOW = new Date('2026-07-12T00:00:00Z')
const SUNDAY = upcomingSundayISO(NOW)

const capRow = (over: Partial<WeeklyCapacityAdminRow>): WeeklyCapacityAdminRow => ({
  id: 'event-1',
  sunday_date: SUNDAY,
  status: 'open',
  total_capacity: 30,
  blocked_spaces: 5,
  admin_reserved: 0,
  capacity_version: 0,
  active_full_time_staff_reserved: 3,
  ...over,
})

const noDemand = { total: 0, priority: 0, general: 0 }

describe('getWeekOverview', () => {
  it('no weekly_events row → stage no_event, capacity + demand null (not an error)', async () => {
    const repo: MockRepo = makeMockRepo({ getWeeklyCapacityAdmin: vi.fn(async () => null) })
    const res = await getWeekOverview({ now: NOW }, asRepo(repo))
    expect(res).toEqual({ sunday: SUNDAY, stage: 'no_event', capacity: null, demand: null })
    expect(repo.getWeeklyCapacityAdmin).toHaveBeenCalledWith(SUNDAY) // Taipei calendar, not getActiveEvent
  })

  it('open + allocation not run → application_open; capacity = computeCapacity + blocked + promised', async () => {
    const repo: MockRepo = makeMockRepo({
      getWeeklyCapacityAdmin: vi.fn(async () => capRow({ status: 'open' })),
      hasFridayAllocationRun: vi.fn(async () => false),
      countWeekReservations: vi.fn(async () => ({
        promised: 8,
        pending: { total: 12, priority: 3, general: 9 },
        waiting: { total: 5, priority: 1, general: 4 },
      })),
    })
    const res = await getWeekOverview({ now: NOW }, asRepo(repo))
    expect(res.stage).toBe('application_open')
    // 30 - 5 blocked - 0 admin_reserved - 3 staff = 22
    expect(res.capacity).toEqual({ allocatable: 22, blocked: 5, promised: 8 })
  })

  // promised now rides along on the demand read (one reservations query for all three),
  // so the capacity page's own head-count helper must be left out of this path entirely.
  it('takes promised from countWeekReservations and never calls countPromisedReservations', async () => {
    const repo: MockRepo = makeMockRepo({
      getWeeklyCapacityAdmin: vi.fn(async () => capRow({ status: 'open' })),
      hasFridayAllocationRun: vi.fn(async () => false),
      countWeekReservations: vi.fn(async () => ({
        promised: 7,
        pending: noDemand,
        waiting: noDemand,
      })),
    })
    const res = await getWeekOverview({ now: NOW }, asRepo(repo))
    expect(res.capacity?.promised).toBe(7)
    expect(repo.countWeekReservations).toHaveBeenCalledWith('event-1')
    expect(repo.countPromisedReservations).not.toHaveBeenCalled()
  })

  it('passes the pending / waiting splits through to demand', async () => {
    const repo: MockRepo = makeMockRepo({
      getWeeklyCapacityAdmin: vi.fn(async () => capRow({ status: 'open' })),
      hasFridayAllocationRun: vi.fn(async () => false),
      countWeekReservations: vi.fn(async () => ({
        promised: 0,
        pending: { total: 5, priority: 2, general: 3 },
        waiting: { total: 3, priority: 0, general: 3 },
      })),
    })
    const res = await getWeekOverview({ now: NOW }, asRepo(repo))
    expect(res.demand).toEqual({
      pending: { total: 5, priority: 2, general: 3 },
      waiting: { total: 3, priority: 0, general: 3 },
    })
  })

  it('open + allocation run → allocated', async () => {
    const repo: MockRepo = makeMockRepo({
      getWeeklyCapacityAdmin: vi.fn(async () => capRow({ status: 'open' })),
      hasFridayAllocationRun: vi.fn(async () => true),
    })
    expect((await getWeekOverview({ now: NOW }, asRepo(repo))).stage).toBe('allocated')
  })

  it('finalized / closed map straight through', async () => {
    for (const status of ['finalized', 'closed'] as const) {
      const repo: MockRepo = makeMockRepo({
        getWeeklyCapacityAdmin: vi.fn(async () => capRow({ status })),
      })
      expect((await getWeekOverview({ now: NOW }, asRepo(repo))).stage).toBe(status)
    }
  })
})
