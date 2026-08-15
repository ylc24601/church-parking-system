import type { StaffRow } from '@/lib/staffRow'

// Offline read-only cache for the Staff on-site list (v2 P2). Stores only the
// Staff-safe view rows already shown on screen — never penalty/contact data.
// Written ONLY after server-confirmed data; pending/optimistic state is never cached.

const KEY = 'staff_checkin_cache'
// Bump when the cached StaffRow shape changes so old caches are treated stale.
// v2: added owner_notifiable (Phase 4 Slice B move-car).
const SCHEMA_VERSION = 2
const MAX_AGE_MS = 12 * 60 * 60 * 1000 // 12h — a cache older than this is not "today"
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000

export interface CachedEvent {
  id: string
  sunday_date: string
}

export interface StaffCache {
  schemaVersion: number
  cachedAt: string // ISO
  event: CachedEvent
  rows: StaffRow[]
}

export function saveStaffCache(event: CachedEvent, rows: StaffRow[]): void {
  try {
    const payload: StaffCache = {
      schemaVersion: SCHEMA_VERSION,
      cachedAt: new Date().toISOString(),
      event: { id: event.id, sunday_date: event.sunday_date },
      rows,
    }
    localStorage.setItem(KEY, JSON.stringify(payload))
  } catch {
    /* localStorage unavailable / quota / private mode — caching is best-effort */
  }
}

// Returns a structurally valid cache (right schema version), or null. Whether the
// cache is fresh enough to SHOW is a separate decision — see isCacheCurrent.
export function loadStaffCache(): StaffCache | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const c = JSON.parse(raw) as Partial<StaffCache>
    if (
      !c ||
      c.schemaVersion !== SCHEMA_VERSION ||
      typeof c.cachedAt !== 'string' ||
      !c.event ||
      typeof c.event.id !== 'string' ||
      typeof c.event.sunday_date !== 'string' ||
      !Array.isArray(c.rows)
    ) {
      return null
    }
    return c as StaffCache
  } catch {
    return null
  }
}

export function clearStaffCache(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
}

// The Sunday of "this week" in Asia/Taipei: today if today is Sunday, else the
// upcoming Sunday. Mirrors how getActiveEvent surfaces the current event.
export function currentSundayISO(now: Date = new Date()): string {
  const taipei = new Date(now.getTime() + TAIPEI_OFFSET_MS)
  const daysUntilSunday = (7 - taipei.getUTCDay()) % 7
  const sunday = new Date(taipei.getTime() + daysUntilSunday * 86_400_000)
  return sunday.toISOString().slice(0, 10)
}

// True only if the cache is safe to show as "this week's list": current schema,
// recent, and for the current week's Sunday. Stale week / old cache → false, so
// the UI tells the user to reconnect instead of showing an old list.
export function isCacheCurrent(cache: StaffCache, now: Date = new Date()): boolean {
  if (cache.schemaVersion !== SCHEMA_VERSION) return false
  const cachedAt = new Date(cache.cachedAt).getTime()
  if (Number.isNaN(cachedAt) || now.getTime() - cachedAt > MAX_AGE_MS) return false
  return cache.event.sunday_date === currentSundayISO(now)
}
