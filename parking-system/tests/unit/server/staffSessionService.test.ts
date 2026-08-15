import { describe, expect, it, vi } from 'vitest'
import { loginStaff, setStaffPin } from '@/server/services/staffSessionService'
import { hashPin } from '@/server/http/pinHash'
import { STAFF_PIN_MAX_ATTEMPTS } from '@/lib/allocation/rules'
import { asRepo, makeMockRepo } from './mockRepo'

const NOW = new Date('2026-06-21T02:00:00Z')
const FUTURE = new Date(NOW.getTime() + 3600_000)
const PIN = '246810'

function sessionRow(over: Record<string, unknown> = {}) {
  return {
    id: 's1',
    weekly_event_id: 'event-1',
    pin_hash: hashPin(PIN),
    expires_at: FUTURE,
    failed_attempts: 0,
    locked_at: null,
    ...over,
  }
}

describe('loginStaff', () => {
  it('invalid when there is no active event (no leak)', async () => {
    const repo = makeMockRepo({ getActiveEvent: vi.fn(async () => null) })
    expect(await loginStaff(PIN, asRepo(repo), NOW)).toEqual({ ok: false, reason: 'invalid' })
  })

  it('invalid when no PIN row is configured (indistinguishable from wrong PIN)', async () => {
    const repo = makeMockRepo({ getStaffSessionByEvent: vi.fn(async () => null) })
    expect(await loginStaff(PIN, asRepo(repo), NOW)).toEqual({ ok: false, reason: 'invalid' })
  })

  it('invalid when the PIN row is expired (same response as wrong PIN)', async () => {
    const repo = makeMockRepo({
      getStaffSessionByEvent: vi.fn(async () => sessionRow({ expires_at: new Date(NOW.getTime() - 1000) })),
    })
    expect(await loginStaff(PIN, asRepo(repo), NOW)).toEqual({ ok: false, reason: 'invalid' })
  })

  it('locked while within the cooldown window', async () => {
    const repo = makeMockRepo({ getStaffSessionByEvent: vi.fn(async () => sessionRow({ locked_at: NOW })) })
    const res = await loginStaff(PIN, asRepo(repo), new Date(NOW.getTime() + 60_000))
    expect(res).toEqual({ ok: false, reason: 'locked' })
  })

  it('ok on the correct PIN + resets the failure counter', async () => {
    const repo = makeMockRepo({ getStaffSessionByEvent: vi.fn(async () => sessionRow()) })
    expect(await loginStaff(PIN, asRepo(repo), NOW)).toEqual({ ok: true, sessionId: 's1', eventId: 'event-1' })
    expect(repo.resetStaffSessionFailures).toHaveBeenCalledWith('s1')
  })

  it('wrong PIN → invalid + increments the failure counter', async () => {
    const repo = makeMockRepo({
      getStaffSessionByEvent: vi.fn(async () => sessionRow()),
      applyStaffPinFailure: vi.fn(async () => ({ failed_attempts: 1, locked_at: null })),
    })
    expect(await loginStaff('000000', asRepo(repo), NOW)).toEqual({ ok: false, reason: 'invalid' })
    expect(repo.applyStaffPinFailure).toHaveBeenCalledWith('s1', STAFF_PIN_MAX_ATTEMPTS)
  })

  it('wrong PIN that trips the lock → locked', async () => {
    const repo = makeMockRepo({
      getStaffSessionByEvent: vi.fn(async () => sessionRow()),
      applyStaffPinFailure: vi.fn(async () => ({ failed_attempts: 5, locked_at: NOW })),
    })
    expect(await loginStaff('000000', asRepo(repo), NOW)).toEqual({ ok: false, reason: 'locked' })
  })
})

describe('setStaffPin', () => {
  it('rejects non-6-digit PINs without touching the DB', async () => {
    const repo = makeMockRepo()
    await expect(setStaffPin({ sunday: '2026-06-21', pin: '123' }, asRepo(repo), NOW)).rejects.toThrow()
    expect(repo.upsertStaffSessionPin).not.toHaveBeenCalled()
  })

  it('throws when the event does not exist', async () => {
    const repo = makeMockRepo({ getWeeklyEventBySunday: vi.fn(async () => null) })
    await expect(setStaffPin({ sunday: '2099-12-31', pin: '246810' }, asRepo(repo), NOW)).rejects.toThrow()
  })

  it('hashes the PIN (never plaintext) and upserts for the event', async () => {
    const repo = makeMockRepo()
    await setStaffPin({ sunday: '2026-06-21', pin: '246810' }, asRepo(repo), NOW)
    const arg = repo.upsertStaffSessionPin.mock.calls[0][0]
    expect(arg.eventId).toBe('event-1')
    expect(arg.pinHash.startsWith('scrypt$')).toBe(true)
    expect(arg.pinHash).not.toContain('246810')
  })
})
