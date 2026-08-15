import { jobSecretValid, unauthorized } from '@/server/http/jobAuth'
import { settle } from '@/server/services/settlementService'

export async function POST(request: Request): Promise<Response> {
  if (!jobSecretValid(request.headers.get('x-job-secret'))) return unauthorized()

  let body: unknown = null
  try {
    body = await request.json()
  } catch {
    body = null
  }
  const eventId = (body as { eventId?: string } | null)?.eventId
  if (!eventId) {
    return Response.json({ ok: false, error: 'eventId is required' }, { status: 400 })
  }

  try {
    const summary = await settle({ eventId })
    return Response.json({ ok: true, ...summary })
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
