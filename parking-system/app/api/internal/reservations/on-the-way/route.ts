import { jobSecretValid, unauthorized } from '@/server/http/jobAuth'
import { markOnTheWay } from '@/server/services/onTheWayService'

export async function POST(request: Request): Promise<Response> {
  if (!jobSecretValid(request.headers.get('x-job-secret'))) return unauthorized()

  let body: unknown = null
  try {
    body = await request.json()
  } catch {
    body = null
  }
  const reservationId = (body as { reservationId?: string } | null)?.reservationId
  if (!reservationId) {
    return Response.json({ ok: false, error: 'reservationId is required' }, { status: 400 })
  }

  try {
    const summary = await markOnTheWay({ reservationId })
    return Response.json({ ok: true, ...summary })
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
