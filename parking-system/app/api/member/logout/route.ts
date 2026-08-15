import { cookies } from 'next/headers'
import { MEMBER_SESSION_COOKIE, clearMemberSession } from '@/server/http/memberAuth'
import { hashSessionToken } from '@/server/http/sessionToken'
import { createParkingRepository } from '@/server/repositories/parkingRepository'

// Per-device logout: deletes this device's member_sessions row and clears its
// cookie; the member's other devices stay logged in (multi-session policy).
export async function POST(): Promise<Response> {
  const store = await cookies()
  const token = store.get(MEMBER_SESSION_COOKIE)?.value
  if (token) {
    await createParkingRepository().deleteMemberSessionByTokenHash(hashSessionToken(token))
  }
  await clearMemberSession()
  return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } })
}
