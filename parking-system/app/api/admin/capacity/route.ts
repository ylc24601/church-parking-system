import { adminUnauthorized, getAdminSession } from '@/server/http/adminAuth'
import { adminInternalError, guardAdminPost } from '@/server/http/adminRequestGuard'
import { adminActor, newRequestId } from '@/server/services/auditContext'
import { setCapacity, type SetCapacityReason } from '@/server/services/capacityAdminService'

// Set a week's capacity. The actor comes from the SESSION; the {eventId, sunday} pair is
// re-verified server-side inside the RPC so a stale tab cannot edit a different week.
//
// Audited (0031): the audit row is written inside the RPC's transaction, so a 500 here
// means nothing changed. The governance refusals below (409/422) DO leave audit rows and
// must stay typed returns — a raise would roll back the record of the refusal.
const NO_STORE = { 'cache-control': 'no-store' }

const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SUNDAY_FORMAT = /^\d{4}-\d{2}-\d{2}$/

// The DB constrains these too (non-negative since 0002, blocked <= total since 0031);
// this is the "don't send obvious junk to the DB" layer, not the invariant.
const MAX_CAPACITY = 1000

function badRequest(): Response {
  return Response.json({ ok: false, reason: 'invalid_request' }, { status: 400, headers: NO_STORE })
}

const STATUS: Record<SetCapacityReason, number> = {
  not_found: 404,
  sunday_mismatch: 409,
  conflict: 409,
  event_not_editable: 409,
  allocation_in_progress: 409,
  negative_capacity: 422,
  capacity_below_promised: 422,
}

export async function POST(request: Request): Promise<Response> {
  const guard = await guardAdminPost(request)
  if (!guard.ok) return guard.response
  const session = await getAdminSession()
  if (!session) return adminUnauthorized()

  const { eventId, sunday, totalCapacity, blockedSpaces, expectedVersion } = (guard.body ?? {}) as {
    eventId?: unknown; sunday?: unknown; totalCapacity?: unknown
    blockedSpaces?: unknown; expectedVersion?: unknown
  }
  if (typeof eventId !== 'string' || !UUID_FORMAT.test(eventId)) return badRequest()
  if (typeof sunday !== 'string' || !SUNDAY_FORMAT.test(sunday)) return badRequest()
  for (const n of [totalCapacity, blockedSpaces, expectedVersion]) {
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) return badRequest()
  }
  if ((totalCapacity as number) > MAX_CAPACITY || (blockedSpaces as number) > MAX_CAPACITY) return badRequest()

  let result
  try {
    result = await setCapacity({
      eventId,
      sunday,
      totalCapacity: totalCapacity as number,
      blockedSpaces: blockedSpaces as number,
      expectedVersion: expectedVersion as number,
      actor: adminActor(session),
      requestId: newRequestId(),
    })
  } catch (e) {
    console.error('admin capacity update error')
    void e
    return adminInternalError()
  }

  if (result.ok) return Response.json(result, { headers: NO_STORE })
  return Response.json(result, { status: STATUS[result.reason] ?? 409, headers: NO_STORE })
}
