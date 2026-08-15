import { jobSecretValid, unauthorized } from '@/server/http/jobAuth'
import { resolveOffer } from '@/server/services/offerService'

export async function POST(request: Request): Promise<Response> {
  if (!jobSecretValid(request.headers.get('x-job-secret'))) return unauthorized()

  let body: unknown = null
  try {
    body = await request.json()
  } catch {
    body = null
  }
  const { reservationId, action } = (body as { reservationId?: string; action?: string } | null) ?? {}
  if (!reservationId) {
    return Response.json({ ok: false, error: 'reservationId is required' }, { status: 400 })
  }
  if (action !== 'confirm' && action !== 'decline') {
    return Response.json({ ok: false, error: "action must be 'confirm' or 'decline'" }, { status: 400 })
  }

  try {
    const summary = await resolveOffer({ reservationId, action })
    return Response.json({ ok: true, ...summary })
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
