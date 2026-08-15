import { adminUnauthorized, getAdminSession } from '@/server/http/adminAuth'
import { adminInternalError, guardAdminPost } from '@/server/http/adminRequestGuard'
import { adminActor, newRequestId } from '@/server/services/auditContext'
import {
  addMemberVehicle,
  MEMBER_MAINTENANCE_STATUS,
  setMemberVehicleActive,
} from '@/server/services/memberMaintenanceService'

// A member's cars (Tier 0-2 / 0038). Two actions on one route because they are one panel
// and one decision — "which cars does this member drive right now" — and because the
// refusals cross-reference each other: adding a plate this member already has in history
// answers `inactive_plate_exists`, whose remedy is the OTHER action here.
//
// `is_active` has existed since 0001 and every reader already honours it; before 0038
// nothing could ever set it false, so a sold car's plate stayed active forever — and that
// is precisely what Staff check-in matches against.
//
// Deactivation is never a delete. Reservations reference (vehicle_id, user_id): that car
// AND who drove it at the time. Removing or re-owning the row would falsify the record.
const NO_STORE = { 'cache-control': 'no-store' }

const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function badRequest(): Response {
  return Response.json({ ok: false, reason: 'invalid_request' }, { status: 400, headers: NO_STORE })
}

export async function POST(request: Request): Promise<Response> {
  const guard = await guardAdminPost(request)
  if (!guard.ok) return guard.response
  const session = await getAdminSession()
  if (!session) return adminUnauthorized()

  const body = (guard.body ?? {}) as Record<string, unknown>
  const action = body.action
  const actor = adminActor(session)
  const requestId = newRequestId()

  if (action === 'add') {
    const { userId, licensePlate } = body
    if (typeof userId !== 'string' || !UUID_FORMAT.test(userId)) return badRequest()
    // Shape only; what counts as a plate is the RPC's call (and it normalises the same way
    // the generated column does, so the import and this form cannot disagree).
    if (typeof licensePlate !== 'string') return badRequest()

    let result
    try {
      result = await addMemberVehicle({ userId, licensePlate, actor, requestId })
    } catch (e) {
      console.error('admin member vehicle add error')
      void e
      return adminInternalError()
    }
    if (result.ok) {
      return Response.json({ ok: true, vehicleId: result.vehicleId }, { headers: NO_STORE })
    }
    // vehicleId rides along with inactive_plate_exists: it is the row to reactivate, so
    // the UI can offer that in place of a dead end.
    return Response.json(
      { ok: false, reason: result.reason, vehicleId: result.vehicleId },
      { status: MEMBER_MAINTENANCE_STATUS[result.reason], headers: NO_STORE },
    )
  }

  if (action === 'set_active') {
    const { vehicleId, isActive } = body
    if (typeof vehicleId !== 'string' || !UUID_FORMAT.test(vehicleId)) return badRequest()
    if (typeof isActive !== 'boolean') return badRequest()

    let result
    try {
      result = await setMemberVehicleActive({ vehicleId, isActive, actor, requestId })
    } catch (e) {
      console.error('admin member vehicle active error')
      void e
      return adminInternalError()
    }
    if (result.ok) {
      return Response.json(
        { ok: true, vehicleId: result.vehicleId, isActive: result.isActive },
        { headers: NO_STORE },
      )
    }
    // `unfinished` is how many live reservations still point at the car — the operator
    // needs the number to know what to go and settle.
    return Response.json(
      { ok: false, reason: result.reason, unfinished: result.unfinished },
      { status: MEMBER_MAINTENANCE_STATUS[result.reason], headers: NO_STORE },
    )
  }

  return badRequest()
}
