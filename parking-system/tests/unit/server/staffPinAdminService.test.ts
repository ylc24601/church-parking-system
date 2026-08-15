import { describe, expect, it, vi } from 'vitest'
import { getStaffPinStatus, issueStaffPin, unlockStaffPin } from '@/server/services/staffPinAdminService'
import { asRepo, makeMockRepo } from './mockRepo'
import type { StaffSessionRow, WeeklyEventRow } from '@/server/repositories/parkingRepository'

// Managed window for NOW below (Taipei calendar): current 2026-07-19, next 2026-07-26.
const NOW = new Date('2026-07-13T02:00:00Z')
const ADMIN_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const EVENT_CURRENT = '11111111-aaaa-bbbb-cccc-000000000001'
const EVENT_NEXT = '11111111-aaaa-bbbb-cccc-000000000002'

const eventFor = (sunday: string): WeeklyEventRow | null =>
  sunday === '2026-07-19'
    ? { id: EVENT_CURRENT, sunday_date: sunday, status: 'open' }
    : sunday === '2026-07-26'
      ? { id: EVENT_NEXT, sunday_date: sunday, status: 'open' }
      : null

const pinRow = (over: Partial<StaffSessionRow> = {}): StaffSessionRow => ({
  id: 'ss-1',
  weekly_event_id: EVENT_CURRENT,
  pin_hash: 'scrypt$deadbeef$cafebabe',
  expires_at: new Date('2026-07-19T16:00:00Z'),
  failed_attempts: 0,
  locked_at: null,
  ...over,
})

describe('getStaffPinStatus', () => {
  it('two Taipei-calendar cards; never getActiveEvent; pin_hash never leaves', async () => {
    const repo = makeMockRepo({
      getWeeklyEventBySunday: vi.fn(async (s: string) => eventFor(s)),
      getStaffSessionByEvent: vi.fn(async (id: string) => (id === EVENT_CURRENT ? pinRow() : null)),
    })
    const res = await getStaffPinStatus({ now: NOW }, asRepo(repo))
    expect(repo.getActiveEvent).not.toHaveBeenCalled()
    expect(res.current).toEqual({
      sunday: '2026-07-19', eventId: EVENT_CURRENT, hasPin: true,
      expiresAt: '2026-07-19T16:00:00.000Z', failedAttempts: 0, locked: false,
    })
    expect(res.next).toEqual({
      sunday: '2026-07-26', eventId: EVENT_NEXT, hasPin: false,
      expiresAt: null, failedAttempts: 0, locked: false,
    })
    expect(JSON.stringify(res)).not.toContain('pin_hash')
    expect(JSON.stringify(res)).not.toContain('scrypt')
  })

  it('missing weekly_event row → eventId null card (no crash)', async () => {
    const repo = makeMockRepo({ getWeeklyEventBySunday: vi.fn(async () => null) })
    const res = await getStaffPinStatus({ now: NOW }, asRepo(repo))
    expect(res.current.eventId).toBeNull()
    expect(res.current.hasPin).toBe(false)
  })

  it('locked reflects the lock window relative to now', async () => {
    const repo = makeMockRepo({
      getWeeklyEventBySunday: vi.fn(async (s: string) => eventFor(s)),
      getStaffSessionByEvent: vi.fn(async (id: string) =>
        id === EVENT_CURRENT ? pinRow({ failed_attempts: 5, locked_at: new Date(NOW.getTime() - 60_000) }) : null),
    })
    const res = await getStaffPinStatus({ now: NOW }, asRepo(repo))
    expect(res.current.locked).toBe(true)
    expect(res.current.failedAttempts).toBe(5)
  })
})

describe('issueStaffPin', () => {
  it('issues a uniform 6-digit PIN (leading zeros kept) with the admin-expiry contract', async () => {
    const repo = makeMockRepo({ getWeeklyEventBySunday: vi.fn(async (s: string) => eventFor(s)) })
    const res = await issueStaffPin(
      { eventId: EVENT_NEXT, sunday: '2026-07-26', adminId: ADMIN_ID, now: NOW }, asRepo(repo))
    if (!res.ok) throw new Error('expected ok')
    expect(res.pin).toMatch(/^\d{6}$/)
    // issued 13 days early, still valid through the END of its Sunday (Taipei)
    expect(res.expiresAt).toBe('2026-07-26T16:00:00.000Z')
    expect(repo.upsertStaffSessionPin).toHaveBeenCalledWith(expect.objectContaining({
      eventId: EVENT_NEXT,
      expiresAt: '2026-07-26T16:00:00.000Z',
      createdByAdminId: ADMIN_ID,
    }))
    const arg = (repo.upsertStaffSessionPin as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(arg.pinHash).toMatch(/^scrypt\$/)
    expect(arg.pinHash).not.toContain(res.pin)
  })

  it('double-check matrix: unmanaged sunday / event-sunday mismatch / missing event → typed refusals', async () => {
    const repo = makeMockRepo({ getWeeklyEventBySunday: vi.fn(async (s: string) => eventFor(s)) })
    // past Sunday (not in the managed window)
    expect(await issueStaffPin({ eventId: EVENT_CURRENT, sunday: '2026-07-12', adminId: ADMIN_ID, now: NOW }, asRepo(repo)))
      .toEqual({ ok: false, reason: 'sunday_not_managed' })
    // managed sunday but the submitted eventId is a different event
    expect(await issueStaffPin({ eventId: EVENT_NEXT, sunday: '2026-07-19', adminId: ADMIN_ID, now: NOW }, asRepo(repo)))
      .toEqual({ ok: false, reason: 'sunday_mismatch' })
    // managed sunday without a weekly_event row
    const emptyRepo = makeMockRepo({ getWeeklyEventBySunday: vi.fn(async () => null) })
    expect(await issueStaffPin({ eventId: EVENT_CURRENT, sunday: '2026-07-19', adminId: ADMIN_ID, now: NOW }, asRepo(emptyRepo)))
      .toEqual({ ok: false, reason: 'event_not_found' })
    expect(repo.upsertStaffSessionPin).not.toHaveBeenCalled()
    expect(emptyRepo.upsertStaffSessionPin).not.toHaveBeenCalled()
  })
})

describe('unlockStaffPin', () => {
  it('clears failures on the existing row and returns NO pin material', async () => {
    const repo = makeMockRepo({
      getWeeklyEventBySunday: vi.fn(async (s: string) => eventFor(s)),
      getStaffSessionByEvent: vi.fn(async () => pinRow({ locked_at: new Date() })),
    })
    const res = await unlockStaffPin({ eventId: EVENT_CURRENT, sunday: '2026-07-19', now: NOW }, asRepo(repo))
    expect(res).toEqual({ ok: true, eventId: EVENT_CURRENT, sunday: '2026-07-19' })
    expect(repo.resetStaffSessionFailures).toHaveBeenCalledWith('ss-1')
    expect(JSON.stringify(res)).not.toMatch(/pin/i)
  })

  it('no PIN row → typed no_pin; same double-check as issue', async () => {
    const repo = makeMockRepo({
      getWeeklyEventBySunday: vi.fn(async (s: string) => eventFor(s)),
      getStaffSessionByEvent: vi.fn(async () => null),
    })
    expect(await unlockStaffPin({ eventId: EVENT_CURRENT, sunday: '2026-07-19', now: NOW }, asRepo(repo)))
      .toEqual({ ok: false, reason: 'no_pin' })
    expect(await unlockStaffPin({ eventId: EVENT_CURRENT, sunday: '2020-01-05', now: NOW }, asRepo(repo)))
      .toEqual({ ok: false, reason: 'sunday_not_managed' })
    expect(repo.resetStaffSessionFailures).not.toHaveBeenCalled()
  })
})
