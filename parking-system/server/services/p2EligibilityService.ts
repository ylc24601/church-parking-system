import { requireAdminActor, type AuditActor } from '@/server/services/auditContext'
import { createParkingRepository, type ParkingRepository } from '@/server/repositories/parkingRepository'

// ── P2 eligibility writes (Wave 2B-2b / #10) ─────────────────────────────────
// The audited write path 幹事 use instead of re-importing a CSV. Two deliberately separate
// actions — 「標記已覆核」≠「核准」:
//
//   setP2Eligibility  — approve / revoke, and set the reason, window and note.
//                       A genuine no-op writes nothing and does NOT record a review:
//                       opening the form and changing nothing is not a review.
//   markP2Reviewed    — record that a human looked and decided nothing needed changing,
//                       plus WHEN to look next. NEVER inert (see 0033).
//
// Both are thin: the RPC owns the guards, the audit row and the transaction. This service
// must not build metadata, must not write a second row, and must not catch an audit failure
// and report success (the rule capacityAdminService.ts:83-85 states).

export type SetP2EligibilityReason =
  | 'not_found'
  | 'invalid_status'
  | 'conflict'
  | 'nothing_to_revoke'
  | 'reason_required'
  | 'review_date_required'
  | 'review_date_in_past'
  | 'child_birthdate_not_applicable'
  | 'child_birthdate_required'
  | 'child_birthdate_in_future'
  | 'expiry_not_settable'
  | 'window_inverted'

export type MarkP2ReviewedReason =
  | 'not_found'
  | 'conflict'
  | 'eligibility_not_approved'
  | 'review_date_required'
  | 'review_date_in_past'

export type SetP2EligibilityResult =
  | { ok: true; noop: boolean; reviewVersion: number }
  | { ok: false; reason: SetP2EligibilityReason; actualVersion?: number }

export type MarkP2ReviewedResult =
  | { ok: true; reviewVersion: number }
  | { ok: false; reason: MarkP2ReviewedReason; actualVersion?: number }

export async function setP2Eligibility(
  params: {
    userId: string
    expectedVersion: number
    reviewStatus: 'approved' | 'revoked'
    reason: string | null
    validFrom: string | null
    validUntil: string | null
    childBirthdate: string | null
    nextReviewDate: string | null
    note: string | null
    actor: AuditActor
    requestId: string
  },
  repo: ParkingRepository = createParkingRepository(),
): Promise<SetP2EligibilityResult> {
  // The audit row is written inside the RPC's transaction, so a write that cannot be pinned
  // on a named admin must not happen at all.
  const { adminId, sessionId } = requireAdminActor(params.actor)

  const res = await repo.setP2Eligibility({
    userId: params.userId,
    expectedVersion: params.expectedVersion,
    reviewStatus: params.reviewStatus,
    reason: params.reason,
    validFrom: params.validFrom,
    // Passed through UNCHANGED, deliberately. child_companion's expiry is derived, and the RPC
    // refuses `expiry_not_settable` rather than ignoring a supplied one — a caller who sends a
    // value believes they set it. If this service "helpfully" nulled it out for them, the guard
    // would be unreachable through the route and the caller would get a silent success with
    // their value discarded: the exact behaviour the guard exists to prevent. The form already
    // omits it for child_companion; anything else deserves the 422.
    validUntil: params.validUntil,
    childBirthdate: params.childBirthdate,
    nextReviewDate: params.nextReviewDate,
    note: params.note,
    actingAdminId: adminId,
    actingSessionId: sessionId,
    requestId: params.requestId,
  })

  if (!res.ok) {
    return {
      ok: false,
      reason: (res.reason ?? 'not_found') as SetP2EligibilityReason,
      ...(res.actual_version !== undefined ? { actualVersion: res.actual_version } : {}),
    }
  }
  return { ok: true, noop: res.noop ?? false, reviewVersion: res.review_version! }
}

export async function markP2Reviewed(
  params: {
    userId: string
    expectedVersion: number
    nextReviewDate: string
    actor: AuditActor
    requestId: string
  },
  repo: ParkingRepository = createParkingRepository(),
): Promise<MarkP2ReviewedResult> {
  const { adminId, sessionId } = requireAdminActor(params.actor)

  const res = await repo.markP2Reviewed({
    userId: params.userId,
    expectedVersion: params.expectedVersion,
    nextReviewDate: params.nextReviewDate,
    actingAdminId: adminId,
    actingSessionId: sessionId,
    requestId: params.requestId,
  })

  if (!res.ok) {
    return {
      ok: false,
      reason: (res.reason ?? 'not_found') as MarkP2ReviewedReason,
      ...(res.actual_version !== undefined ? { actualVersion: res.actual_version } : {}),
    }
  }
  return { ok: true, reviewVersion: res.review_version! }
}
