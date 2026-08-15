import { cookies } from 'next/headers'
import { STAFF_SESSION_TTL_HOURS } from '@/lib/allocation/rules'
import { createParkingRepository } from '@/server/repositories/parkingRepository'

// ── Staff on-site auth (Phase 3 v2: real PIN session) ────────────────────────
// The cookie carries the staff_sessions row id (one shared PIN row per
// weekly_event). PIN verification + lockout live in staffSessionService.loginStaff;
// this module owns the cookie and validating a live session.
//
// Model: per-event shared credential + per-device cookie marker. This is NOT
// per-device session management — single-device revocation is deferred.
//
// locked_at semantics: lockout blocks NEW logins (see loginStaff) but does NOT
// invalidate an already-issued cookie. So getStaffSession() validates only the
// row's existence + expires_at, never locked_at.

export const STAFF_SESSION_COOKIE = 'staff_session'

export interface StaffSession {
  sessionId: string
  eventId: string
}

// Reads the cookie session id and confirms the staff_sessions row exists and is
// not past expires_at. Returns the bound event so Staff routes use the event the
// PIN was issued for (replacing the old getActiveEvent() stub). null = not logged in.
export async function getStaffSession(): Promise<StaffSession | null> {
  const store = await cookies()
  const id = store.get(STAFF_SESSION_COOKIE)?.value
  if (!id) return null

  const row = await createParkingRepository().getStaffSessionById(id)
  if (!row) return null
  if (new Date() >= row.expires_at) return null
  return { sessionId: row.id, eventId: row.weekly_event_id }
}

export async function staffAuthed(): Promise<boolean> {
  return (await getStaffSession()) !== null
}

export async function setStaffSession(sessionId: string): Promise<void> {
  const store = await cookies()
  store.set(STAFF_SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: STAFF_SESSION_TTL_HOURS * 60 * 60,
  })
}

// Per-device logout: clears this device's cookie only. The shared event PIN row
// stays (other on-site devices remain logged in).
export async function clearStaffSession(): Promise<void> {
  const store = await cookies()
  store.delete(STAFF_SESSION_COOKIE)
}

export function staffUnauthorized(): Response {
  return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
}
