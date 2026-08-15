import { ADMIN_SESSION_COOKIE, clearAdminSession } from '@/server/http/adminAuth'
import { guardAdminOrigin } from '@/server/http/adminRequestGuard'
import { hashSessionToken } from '@/server/http/sessionToken'
import { createParkingRepository } from '@/server/repositories/parkingRepository'
import { cookies } from 'next/headers'

// Per-device admin logout: delete this device's session row (by token hash) and
// clear the cookie. Always 200 — logout must not fail visibly; even if the DB
// delete errors, the cookie is cleared (the orphan row dies at expires_at).
const NO_STORE = { 'cache-control': 'no-store' }

export async function POST(request: Request): Promise<Response> {
  const originRefusal = guardAdminOrigin(request)
  if (originRefusal) return originRefusal

  const store = await cookies()
  const token = store.get(ADMIN_SESSION_COOKIE)?.value
  if (token) {
    try {
      await createParkingRepository().deleteAdminSessionByTokenHash(hashSessionToken(token))
    } catch (e) {
      console.error('admin logout: session row delete failed', e)
    }
  }
  await clearAdminSession()
  return Response.json({ ok: true }, { headers: NO_STORE })
}
