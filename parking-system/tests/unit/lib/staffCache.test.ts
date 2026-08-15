import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  saveStaffCache,
  loadStaffCache,
  clearStaffCache,
  isCacheCurrent,
  currentSundayISO,
  type StaffCache,
} from '@/lib/staffCache'

// Minimal in-memory localStorage for the node test env.
class MemStorage {
  store = new Map<string, string>()
  getItem(k: string) { return this.store.has(k) ? this.store.get(k)! : null }
  setItem(k: string, v: string) { this.store.set(k, String(v)) }
  removeItem(k: string) { this.store.delete(k) }
  clear() { this.store.clear() }
}

const KEY = 'staff_checkin_cache'
const event = { id: 'e1', sunday_date: '2026-06-21' }
const rows = [
  { reservation_id: 'r1', display_name: '會友一', license_plate: 'ABC-1234', walk_in_name: null, walk_in_license_plate: null, is_priority: true, status: 'approved', attended_at: null, owner_notifiable: true },
]

beforeEach(() => {
  ;(globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage()
})
afterEach(() => {
  delete (globalThis as unknown as { localStorage?: MemStorage }).localStorage
})

describe('staffCache save/load round-trip', () => {
  it('round-trips rows + metadata', () => {
    saveStaffCache(event, rows)
    const c = loadStaffCache()
    expect(c).not.toBeNull()
    expect(c!.schemaVersion).toBe(2)
    expect(typeof c!.cachedAt).toBe('string')
    expect(c!.event).toEqual(event)
    expect(c!.rows).toEqual(rows)
  })

  it('clearStaffCache → load returns null', () => {
    saveStaffCache(event, rows)
    clearStaffCache()
    expect(loadStaffCache()).toBeNull()
  })

  it('returns null on schemaVersion mismatch', () => {
    localStorage.setItem(KEY, JSON.stringify({ schemaVersion: 999, cachedAt: new Date().toISOString(), event, rows }))
    expect(loadStaffCache()).toBeNull()
  })

  it('returns null on corrupt JSON', () => {
    localStorage.setItem(KEY, '{not json')
    expect(loadStaffCache()).toBeNull()
  })

  it('returns null when localStorage throws (private mode)', () => {
    ;(globalThis as unknown as { localStorage: unknown }).localStorage = {
      getItem() { throw new Error('denied') },
      setItem() { throw new Error('denied') },
      removeItem() {},
    }
    expect(() => saveStaffCache(event, rows)).not.toThrow()
    expect(loadStaffCache()).toBeNull()
  })
})

describe('isCacheCurrent', () => {
  const now = new Date()
  const base = (): StaffCache => ({
    schemaVersion: 2,
    cachedAt: now.toISOString(),
    event: { id: 'e1', sunday_date: currentSundayISO(now) },
    rows,
  })

  it('true for current schema, recent, current-week Sunday', () => {
    expect(isCacheCurrent(base(), now)).toBe(true)
  })

  it('false when cachedAt is too old (>12h)', () => {
    const old = { ...base(), cachedAt: new Date(now.getTime() - 13 * 3600_000).toISOString() }
    expect(isCacheCurrent(old, now)).toBe(false)
  })

  it('false when sunday_date is a different week', () => {
    const stale = { ...base(), event: { id: 'e1', sunday_date: '2000-01-02' } }
    expect(isCacheCurrent(stale, now)).toBe(false)
  })

  it('false on schemaVersion mismatch', () => {
    expect(isCacheCurrent({ ...base(), schemaVersion: 999 }, now)).toBe(false)
  })
})

describe('currentSundayISO (Asia/Taipei)', () => {
  it('returns the same day when it is Sunday', () => {
    expect(currentSundayISO(new Date('2026-06-21T03:00:00Z'))).toBe('2026-06-21')
  })
  it('returns the upcoming Sunday on a weekday', () => {
    expect(currentSundayISO(new Date('2026-06-24T03:00:00Z'))).toBe('2026-06-28')
  })
})
