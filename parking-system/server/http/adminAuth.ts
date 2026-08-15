import { cookies } from 'next/headers'
import { ADMIN_SESSION_TTL_HOURS } from '@/lib/allocation/rules'
import type { AdminRole } from '@/lib/adminRoles'
import { hashSessionToken } from '@/server/http/sessionToken'
import { createParkingRepository } from '@/server/repositories/parkingRepository'

// ── Admin UI auth (Phase 8 Slice 1) ──────────────────────────────────────────
// Mirrors memberAuth (cookie carries the raw opaque token; admin_sessions stores
// only its sha256) with two hardenings for the high-privilege surface:
//   · an EXPIRED session row and a DISABLED account's session row are physically
//     deleted when presented — not just refused. disabled_at is checked on every
//     request, so disabling an admin kills ALL device sessions immediately; each
//     device's DB row is reaped on its own next request. (Proactive revoke-all is
//     the account-management slice.)
//   · malformed cookie values never reach the DB.
//
// Wave 2C-1 (#19): the role rides along on the SAME row this already reads for
// disabled_at, so it costs no extra query and is re-read on every request — a
// demotion takes effect immediately rather than at the next login. The cookie never
// carries it. This value gates HTTP and UI only; every DB write re-derives the role
// inside its own transaction and never trusts one asserted by the caller.

export const ADMIN_SESSION_COOKIE = 'admin_session'

// generateSessionToken() = 32 bytes base64url = exactly 43 chars of this alphabet.
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/

export interface AdminSession {
  sessionId: string
  adminId: string
  username: string
  role: AdminRole
}

export async function getAdminSession(): Promise<AdminSession | null> {
  const store = await cookies()
  const token = store.get(ADMIN_SESSION_COOKIE)?.value
  if (!token || !TOKEN_FORMAT.test(token)) return null

  const repo = createParkingRepository()
  const tokenHash = hashSessionToken(token)
  const row = await repo.getAdminSessionByTokenHash(tokenHash)
  if (!row) return null
  if (new Date() >= row.expires_at || row.account_disabled_at !== null) {
    // Revoke, don't just refuse. (Cookie clearing is only possible in a route
    // handler; the dangling cookie is harmless once this row is gone.)
    await repo.deleteAdminSessionByTokenHash(tokenHash)
    return null
  }
  return { sessionId: row.id, adminId: row.admin_id, username: row.username, role: row.role }
}

export async function setAdminSession(token: string): Promise<void> {
  const store = await cookies()
  store.set(ADMIN_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: ADMIN_SESSION_TTL_HOURS * 3600,
  })
}

export async function clearAdminSession(): Promise<void> {
  const store = await cookies()
  store.delete(ADMIN_SESSION_COOKIE)
}

export function adminUnauthorized(): Response {
  return Response.json(
    { ok: false, error: 'unauthorized' },
    { status: 401, headers: { 'cache-control': 'no-store' } },
  )
}

// Authenticated, but not for this surface. Distinct from 401 on purpose: re-logging in
// would not help, and the client must not treat it as a session expiry.
export function adminForbidden(): Response {
  return Response.json(
    { ok: false, error: 'forbidden' },
    { status: 403, headers: { 'cache-control': 'no-store' } },
  )
}
