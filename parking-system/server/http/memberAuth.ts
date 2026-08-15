import { cookies } from 'next/headers'
import { MEMBER_SESSION_TTL_DAYS } from '@/lib/allocation/rules'
import { hashSessionToken } from '@/server/http/sessionToken'
import { createParkingRepository } from '@/server/repositories/parkingRepository'

// ── Member LIFF auth (Phase 7 Slice 1) ───────────────────────────────────────
// The cookie carries the raw opaque session token; member_sessions stores only its
// sha256 (see sessionToken.ts). Login/verification live in memberAuthService; this
// module owns the cookie and validating a live session, mirroring staffAuth.
//
// Multi-session: several devices may hold live sessions for one member. Logout
// clears this device's cookie and its own row only.

export const MEMBER_SESSION_COOKIE = 'member_session'

export interface MemberSession {
  sessionId: string
  userId: string
}

// Reads the cookie token, hashes it, and confirms a live member_sessions row.
// null = not logged in (no cookie, unknown token, or past expires_at).
export async function getMemberSession(): Promise<MemberSession | null> {
  const store = await cookies()
  const token = store.get(MEMBER_SESSION_COOKIE)?.value
  if (!token) return null

  const row = await createParkingRepository().getMemberSessionByTokenHash(hashSessionToken(token))
  if (!row) return null
  if (new Date() >= row.expires_at) return null
  return { sessionId: row.id, userId: row.user_id }
}

export async function setMemberSession(token: string): Promise<void> {
  const store = await cookies()
  store.set(MEMBER_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',   // the login fetch is same-origin even inside the LIFF in-app browser
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: MEMBER_SESSION_TTL_DAYS * 24 * 60 * 60,
  })
}

export async function clearMemberSession(): Promise<void> {
  const store = await cookies()
  store.delete(MEMBER_SESSION_COOKIE)
}

export function memberUnauthorized(): Response {
  return Response.json(
    { ok: false, error: 'unauthorized' },
    { status: 401, headers: { 'cache-control': 'no-store' } },
  )
}
