import { describe, expect, it, vi } from 'vitest'
import { getAdminPrintSheet } from '@/server/services/printSheetService'
import { asRepo, makeMockRepo } from './mockRepo'
import type { StaffCheckInRow } from '@/lib/types'

// Wave 1a (#23) — the printable roster sheet is now an ADMIN page. Two invariants matter:
// the Sunday comes from the Taipei calendar (never getActiveEvent), and the data stays the
// Staff-safe projection.
// NOW is Taipei 2026-07-13 10:00 (Monday) → the upcoming Sunday is 2026-07-19.
const NOW = new Date('2026-07-13T02:00:00Z')
const EVENT_ID = '11111111-aaaa-bbbb-cccc-000000000001'

const viewRow = (over: Partial<StaffCheckInRow> = {}): StaffCheckInRow => ({
  reservation_id: 'r-1',
  weekly_event_id: EVENT_ID,
  display_name: '王小明',
  license_plate: 'ABC-1234',
  walk_in_name: null,
  walk_in_license_plate: null,
  is_priority: true,
  status: 'approved',
  attended_at: new Date('2026-07-19T02:05:00Z'),
  owner_notifiable: true,
  ...over,
})

describe('getAdminPrintSheet', () => {
  it('resolves the event by the Taipei-calendar Sunday, never getActiveEvent', async () => {
    const repo = makeMockRepo({
      getWeeklyEventBySunday: vi.fn(async (s: string) => ({ id: EVENT_ID, sunday_date: s, status: 'open' })),
      getStaffCheckInList: vi.fn(async () => [viewRow()]),
    })
    const sheet = await getAdminPrintSheet({ now: NOW }, asRepo(repo))

    expect(repo.getWeeklyEventBySunday).toHaveBeenCalledWith('2026-07-19')
    expect(repo.getActiveEvent).not.toHaveBeenCalled() // latest-non-finalized would print a stale week
    expect(sheet.event).toEqual({ id: EVENT_ID, sunday_date: '2026-07-19' })
  })

  it('no weekly_event for that Sunday → empty sheet without querying a roster', async () => {
    const repo = makeMockRepo({ getWeeklyEventBySunday: vi.fn(async () => null) })
    const sheet = await getAdminPrintSheet({ now: NOW }, asRepo(repo))

    expect(sheet).toEqual({ event: null, rows: [] })
    expect(repo.getStaffCheckInList).not.toHaveBeenCalled()
  })

  it('maps the Staff-safe view rows to the client shape (attended_at as ISO)', async () => {
    const repo = makeMockRepo({
      getWeeklyEventBySunday: vi.fn(async (s: string) => ({ id: EVENT_ID, sunday_date: s, status: 'open' })),
      getStaffCheckInList: vi.fn(async () => [
        viewRow(),
        viewRow({ reservation_id: 'r-2', display_name: null, license_plate: null, walk_in_name: '現場', walk_in_license_plate: 'WALK-1', is_priority: false, status: 'walk_in', attended_at: null }),
      ]),
    })
    const sheet = await getAdminPrintSheet({ now: NOW }, asRepo(repo))

    expect(repo.getStaffCheckInList).toHaveBeenCalledWith(EVENT_ID)
    expect(sheet.rows).toEqual([
      {
        reservation_id: 'r-1', display_name: '王小明', license_plate: 'ABC-1234',
        walk_in_name: null, walk_in_license_plate: null, is_priority: true,
        status: 'approved', attended_at: '2026-07-19T02:05:00.000Z', owner_notifiable: true,
      },
      {
        reservation_id: 'r-2', display_name: null, license_plate: null,
        walk_in_name: '現場', walk_in_license_plate: 'WALK-1', is_priority: false,
        status: 'walk_in', attended_at: null, owner_notifiable: true,
      },
    ])
  })

  it('reads ONLY the Staff-safe list — no reservation / eligibility / penalty lookups', async () => {
    const repo = makeMockRepo({
      getWeeklyEventBySunday: vi.fn(async (s: string) => ({ id: EVENT_ID, sunday_date: s, status: 'open' })),
      getStaffCheckInList: vi.fn(async () => [viewRow()]),
    })
    await getAdminPrintSheet({ now: NOW }, asRepo(repo))

    expect(repo.getReservation).not.toHaveBeenCalled()
    expect(repo.getPenaltyCountersForUsers).not.toHaveBeenCalled()
    expect(repo.getMemberAdminDetail).not.toHaveBeenCalled()
  })
})
