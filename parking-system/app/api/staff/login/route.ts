import { setStaffSession } from '@/server/http/staffAuth'
import { loginStaff } from '@/server/services/staffSessionService'

// Staff PIN login. Verifies the submitted PIN against the active event's
// staff_sessions row (scrypt + lockout/expiry, in loginStaff). Privacy: a wrong
// PIN, no active event, no configured PIN, and an expired PIN all return the same
// 401 invalid_pin — only a locked PIN returns 423 so the UI can ask the user to wait.
export async function POST(request: Request): Promise<Response> {
  let body: unknown = null
  try {
    body = await request.json()
  } catch {
    body = null
  }
  const pin = (body as { pin?: string } | null)?.pin
  if (typeof pin !== 'string') {
    return Response.json({ ok: false, error: 'invalid_pin' }, { status: 401 })
  }

  const result = await loginStaff(pin)
  if (result.ok) {
    await setStaffSession(result.sessionId)
    return Response.json({ ok: true })
  }
  if (result.reason === 'locked') {
    return Response.json({ ok: false, error: 'locked' }, { status: 423 })
  }
  return Response.json({ ok: false, error: 'invalid_pin' }, { status: 401 })
}
