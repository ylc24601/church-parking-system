import { maskPhone } from '@/lib/binding'
import type { IdentityCandidate, MemberMaintenanceReason } from '@/lib/memberMaintenanceTypes'
import {
  createParkingRepository,
  type ParkingRepository,
} from '@/server/repositories/parkingRepository'
import { requireAdminActor, type AuditActor } from '@/server/services/auditContext'

// ── Admin member maintenance (Tier 0-2 / 0038) ───────────────────────────────
// Four audited mutations that, before this slice, had no path at all: the CSV import was
// the only way to write member data, it keys members by PHONE, and vehicles were
// insert-only. See 0038's header for what that cost.
//
// This layer is deliberately thin, for the same reason adminAccountService is: each RPC
// owns its guards, its transaction and its audit row. So this service must not
//   * re-implement the name/phone/plate rules — the RPC is the single authority, and a
//     copy here would drift the moment one side changes (the CSV import proves the point:
//     its dry-run and apply agree only because ONE function answers both);
//   * write a second audit row — the app principal cannot execute the audit writer at all;
//   * catch a throw and report success — a throw means the transaction rolled back, audit
//     row included, so nothing happened.
//
// What it DOES own: threading the actor from the session, mapping the RPC's typed reasons
// onto a stable union, and keeping `homonym_requires_confirmation` legible as a step in a
// flow rather than an error.

export type {
  MemberMaintenanceReason,
  IdentityCandidate,
} from '@/lib/memberMaintenanceTypes'

// One HTTP mapping for the whole surface so four routes cannot invent four dialects.
//
//   403 — the ACTOR may not, as they are. Both are race guards: adminAuth deletes a
//         disabled account's session on every request, so neither should be reachable.
//   404 — the TARGET does not exist.
//   422 — the INPUT is malformed; the operator must fix the form. Retrying unchanged
//         fails identically forever.
//   409 — the input is fine and the CURRENT STATE refuses it. This is the honest status
//         for the inert cases too (already_inactive, active_plate_owned_by_self): the
//         request was understood, and the answer is "the world is already like that".
//
// homonym_requires_confirmation is a 409 rather than a 200 ON PURPOSE. It is the first
// step of a two-step flow, but it is NOT a success: nothing was created. Returning 200
// would make "member created" and "please look at these two people first" the same shape
// to any caller that checks only the status — and the browser is not the only caller.
export const MEMBER_MAINTENANCE_STATUS: Record<MemberMaintenanceReason, number> = {
  acting_admin_not_found: 403,
  acting_admin_disabled: 403,
  not_found: 404,
  member_not_found: 404,
  vehicle_not_found: 404,
  invalid_name: 422,
  invalid_phone: 422,
  invalid_plate: 422,
  homonym_requires_confirmation: 409,
  homonym_confirmation_stale: 409,
  phone_in_use: 409,
  active_plate_owned_by_self: 409,
  active_plate_owned_by_other: 409,
  inactive_plate_exists: 409,
  already_active: 409,
  already_inactive: 409,
  unfinished_reservations: 409,
}

// Does this build have a mapping for the reason the DB returned? Sole caller is `reasonOf`
// below, which is where the "no" branch is decided — see that comment for what happens then.
export function isKnownReason(reason: string): reason is MemberMaintenanceReason {
  return Object.prototype.hasOwnProperty.call(MEMBER_MAINTENANCE_STATUS, reason)
}

export type CreateMemberResult =
  | { ok: true; userId: string }
  // `candidates` accompanies the two homonym reasons and nothing else. It is the
  // roster-as-of-now, so the UI must re-render from THIS list rather than the one it
  // showed before — that is the whole point of the stale check.
  | { ok: false; reason: MemberMaintenanceReason; candidates?: IdentityCandidate[] }

export type UpdateMemberIdentityResult =
  | { ok: true; changed: boolean; bindingsInvalidated: number }
  | { ok: false; reason: MemberMaintenanceReason }

export type AddMemberVehicleResult =
  | { ok: true; vehicleId: string }
  // vehicleId accompanies `inactive_plate_exists`: it is the row to reactivate, so the UI
  // can offer that instead of leaving the operator to find it.
  | { ok: false; reason: MemberMaintenanceReason; vehicleId?: string }

export type SetMemberVehicleActiveResult =
  | { ok: true; vehicleId: string; isActive: boolean }
  | { ok: false; reason: MemberMaintenanceReason; unfinished?: number }

// Collapses BOTH degenerate cases onto each action's most conservative reason:
//   * no reason at all — a contract violation, not a business state;
//   * a reason string this build does not know.
//
// The second one only arises if the DB is AHEAD of the app (a migration applied but the
// app not yet promoted — see 0038's header on that window). The operator then gets a
// definite-sounding message that is not the real refusal. That is the deliberate trade:
// a wrong-but-actionable message beats a 500, and the window is minutes long by procedure.
// It is NOT a forward-compatibility contract — a new DB reason must still be added here,
// and to MemberMaintenanceReason, in the same slice that introduces it.
function reasonOf(raw: string | undefined, fallback: MemberMaintenanceReason): MemberMaintenanceReason {
  if (raw === undefined) return fallback
  return isKnownReason(raw) ? raw : fallback
}

// Create ONE member, by hand. The homonym gate is the interesting part: the name key is
// legitimately non-unique (two 王小明 may both attend), so this cannot be an index — it is
// a human decision, and `confirmedCandidateIds` is how the operator records having made it.
//
// null (not []) means "I have not been shown the candidates yet". The distinction is
// load-bearing all the way down to the RPC, so it is never coalesced on the way through.
export async function createMember(
  params: {
    displayName: string
    phone: string
    confirmedCandidateIds: string[] | null
    actor: AuditActor
    requestId: string
  },
  repo: ParkingRepository = createParkingRepository(),
): Promise<CreateMemberResult> {
  const { adminId, sessionId } = requireAdminActor(params.actor)
  const result = await repo.createMember({
    displayName: params.displayName,
    phone: params.phone,
    confirmedCandidateIds: params.confirmedCandidateIds,
    actingAdminId: adminId,
    actingSessionId: sessionId,
    requestId: params.requestId,
  })

  if (result.ok) {
    if (!result.user_id) {
      // ok:true without an id is not a member we can link to. Fail loud rather than
      // reporting a creation the caller cannot act on.
      throw new Error('createMember: RPC returned ok without user_id')
    }
    return { ok: true, userId: result.user_id }
  }
  // The RPC returns each candidate's FULL phone — it has to, since that is what makes two
  // same-named people distinguishable at all. The list is masked here, at the boundary,
  // for the same reason the member search list is: recognising someone you know needs a
  // hint, not the whole number of a person you are about to decide is unrelated. The
  // operator who genuinely needs the full number can open that member's detail page.
  return {
    ok: false,
    reason: reasonOf(result.reason, 'invalid_name'),
    candidates: result.candidates?.map(c => ({
      id: c.id,
      phoneMasked: c.phone === null ? '—' : maskPhone(c.phone),
      evidence: c.evidence,
    })),
  }
}

// Rename and/or re-number a member. The target is users.id — the OLD phone is never used
// to find them, because a system that looks members up by phone is the system that
// duplicates them when a phone changes.
//
// `bindingsInvalidated` is not a statistic: a phone change rejects that member's
// outstanding LINE binding claims, and the operator has to know that the member will need
// to re-submit. The UI says so; it does not quietly swallow the number.
export async function updateMemberIdentity(
  params: {
    userId: string
    displayName: string
    phone: string
    actor: AuditActor
    requestId: string
  },
  repo: ParkingRepository = createParkingRepository(),
  now: Date = new Date(),
): Promise<UpdateMemberIdentityResult> {
  const { adminId, sessionId } = requireAdminActor(params.actor)
  const result = await repo.updateMemberIdentity({
    userId: params.userId,
    displayName: params.displayName,
    phone: params.phone,
    actingAdminId: adminId,
    actingSessionId: sessionId,
    requestId: params.requestId,
    nowIso: now.toISOString(),
  })

  if (result.ok) {
    return {
      ok: true,
      changed: result.changed ?? false,
      bindingsInvalidated: result.bindings_invalidated ?? 0,
    }
  }
  return { ok: false, reason: reasonOf(result.reason, 'not_found') }
}

// Give a member a car. Four distinct refusals, kept distinct because each has a different
// next action for the operator: it is already theirs (nothing to do) / it is someone
// else's current car (a handover has to happen there first) / they had it before
// (reactivate that row, don't stack a second one) / that is not a plate.
export async function addMemberVehicle(
  params: {
    userId: string
    licensePlate: string
    actor: AuditActor
    requestId: string
  },
  repo: ParkingRepository = createParkingRepository(),
): Promise<AddMemberVehicleResult> {
  const { adminId, sessionId } = requireAdminActor(params.actor)
  const result = await repo.addMemberVehicle({
    userId: params.userId,
    licensePlate: params.licensePlate,
    actingAdminId: adminId,
    actingSessionId: sessionId,
    requestId: params.requestId,
  })

  if (result.ok) {
    if (!result.vehicle_id) throw new Error('addMemberVehicle: RPC returned ok without vehicle_id')
    return { ok: true, vehicleId: result.vehicle_id }
  }
  return {
    ok: false,
    reason: reasonOf(result.reason, 'invalid_plate'),
    vehicleId: result.vehicle_id,
  }
}

// Retire a car, or bring one back. Deactivation is what makes a plate re-issuable, and the
// row SURVIVES: reservations reference (vehicle_id, user_id), so deleting or re-owning the
// row would falsify the record of who drove what.
//
// The refusal that matters is `unfinished_reservations`. It is checked in-transaction under
// the vehicle's row lock, not by hiding a button — the failure it prevents is a car
// approved on Friday, retired on Saturday, and a Sunday check-in list that disagrees with
// the member's own screen.
export async function setMemberVehicleActive(
  params: {
    vehicleId: string
    isActive: boolean
    actor: AuditActor
    requestId: string
  },
  repo: ParkingRepository = createParkingRepository(),
): Promise<SetMemberVehicleActiveResult> {
  const { adminId, sessionId } = requireAdminActor(params.actor)
  const result = await repo.setMemberVehicleActive({
    vehicleId: params.vehicleId,
    isActive: params.isActive,
    actingAdminId: adminId,
    actingSessionId: sessionId,
    requestId: params.requestId,
  })

  if (result.ok) {
    return {
      ok: true,
      vehicleId: result.vehicle_id ?? params.vehicleId,
      // The RPC echoes the state it committed. Trust that over the request: if the two
      // ever disagree, the DB is right.
      isActive: result.is_active ?? params.isActive,
    }
  }
  return {
    ok: false,
    reason: reasonOf(result.reason, 'vehicle_not_found'),
    unfinished: result.unfinished,
  }
}
