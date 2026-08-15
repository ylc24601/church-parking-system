import { jobSecretValid, unauthorized } from '@/server/http/jobAuth'
import { resolveJobEventId } from '@/server/http/jobEventResolver'
import { runFridayAllocation } from '@/server/services/fridayAllocationService'

// Thin entry point: validate the shared job secret, then delegate to the service.
// Compatible with an external scheduler / manual POST (both send the x-job-secret
// header). Unsupported HTTP methods auto-return 405 in Next.

export async function POST(request: Request): Promise<Response> {
  if (!jobSecretValid(request.headers.get('x-job-secret'))) return unauthorized()

  let body: unknown = null
  try {
    body = await request.json()
  } catch {
    body = null
  }

  try {
    // Phase 9 Slice 1 — omitted eventId resolves to the upcoming Sunday's event so a
    // static external scheduler can drive this route; explicit eventId (manual ops)
    // behaves exactly as before. See server/http/jobEventResolver.ts for the contract.
    const resolved = await resolveJobEventId(body)
    if (!resolved.ok) return resolved.response
    const summary = await runFridayAllocation({ eventId: resolved.eventId })
    return Response.json({ ok: true, ...summary })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
}
