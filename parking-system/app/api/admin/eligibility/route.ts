import { adminUnauthorized, getAdminSession } from '@/server/http/adminAuth'
import { adminInternalError, guardAdminPost } from '@/server/http/adminRequestGuard'
import { adminActor, newRequestId } from '@/server/services/auditContext'
import {
  markP2Reviewed,
  setP2Eligibility,
  type MarkP2ReviewedReason,
  type SetP2EligibilityReason,
} from '@/server/services/p2EligibilityService'
import { P2_REASON_OPTIONS } from '@/lib/p2Reason'

// Write P2 eligibility. The actor comes from the SESSION — never the body.
//
// Two actions on one route because they are one form: `save` (approve/revoke) and `review`
// (「標記已覆核」). They are NOT interchangeable — see 0033. Route Handlers are uncached for
// non-GET methods in Next 16, so no route segment config is needed; NO_STORE is belt-and-braces
// for the response itself.
//
// Audited (0033): the audit row is written inside the RPC's transaction, so a 500 here means
// nothing changed. The refusals below DO leave audit rows and must stay typed returns — a raise
// would roll back the record of the refusal.
const NO_STORE = { 'cache-control': 'no-store' }

const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/
const MAX_NOTE_CHARS = 500

function badRequest(): Response {
  return Response.json({ ok: false, reason: 'invalid_request' }, { status: 400, headers: NO_STORE })
}

// 409 means "someone changed it under you — refresh and retry"; 422 means "fix the form".
// Blurring them would tell a 幹事 to refresh at a form error, which would fail identically
// forever. Only a genuine version race is 409.
const STATUS: Record<SetP2EligibilityReason | MarkP2ReviewedReason, number> = {
  not_found: 404,
  conflict: 409,
  invalid_status: 422,
  nothing_to_revoke: 422,
  reason_required: 422,
  review_date_required: 422,
  review_date_in_past: 422,
  child_birthdate_not_applicable: 422,
  child_birthdate_required: 422,
  child_birthdate_in_future: 422,
  expiry_not_settable: 422,
  window_inverted: 422,
  eligibility_not_approved: 422,
}

const isDate = (v: unknown): v is string => typeof v === 'string' && DATE_FORMAT.test(v)
const isNullableDate = (v: unknown): boolean => v === null || v === undefined || isDate(v)

export async function POST(request: Request): Promise<Response> {
  const guard = await guardAdminPost(request)
  if (!guard.ok) return guard.response
  const session = await getAdminSession()
  if (!session) return adminUnauthorized()

  const body = (guard.body ?? {}) as Record<string, unknown>
  const { action, userId, expectedVersion } = body

  if (typeof userId !== 'string' || !UUID_FORMAT.test(userId)) return badRequest()
  if (typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
    return badRequest()
  }

  try {
    if (action === 'review') {
      const { nextReviewDate } = body
      if (!isDate(nextReviewDate)) return badRequest()
      const result = await markP2Reviewed({
        userId,
        expectedVersion,
        nextReviewDate,
        actor: adminActor(session),
        requestId: newRequestId(),
      })
      if (result.ok) return Response.json(result, { headers: NO_STORE })
      return Response.json(result, { status: STATUS[result.reason] ?? 422, headers: NO_STORE })
    }

    if (action === 'save') {
      const { reviewStatus, reason, validFrom, validUntil, childBirthdate, nextReviewDate, note } = body
      if (reviewStatus !== 'approved' && reviewStatus !== 'revoked') return badRequest()
      if (reason !== null && reason !== undefined
          && !P2_REASON_OPTIONS.includes(reason as (typeof P2_REASON_OPTIONS)[number])) {
        return badRequest()
      }
      for (const d of [validFrom, validUntil, childBirthdate, nextReviewDate]) {
        if (!isNullableDate(d)) return badRequest()
      }
      if (note !== null && note !== undefined
          && (typeof note !== 'string' || [...note].length > MAX_NOTE_CHARS)) {
        return badRequest()
      }

      const result = await setP2Eligibility({
        userId,
        expectedVersion,
        reviewStatus,
        reason: (reason as string | null) ?? null,
        validFrom: (validFrom as string | null) ?? null,
        validUntil: (validUntil as string | null) ?? null,
        childBirthdate: (childBirthdate as string | null) ?? null,
        nextReviewDate: (nextReviewDate as string | null) ?? null,
        // The note never reaches an audit row (0030 exact-key denies note/review_note); it
        // lives only on the eligibility row. Trim to null so "   " is not stored as a note.
        note: typeof note === 'string' && note.trim().length > 0 ? note.trim() : null,
        actor: adminActor(session),
        requestId: newRequestId(),
      })
      if (result.ok) return Response.json(result, { headers: NO_STORE })
      return Response.json(result, { status: STATUS[result.reason] ?? 422, headers: NO_STORE })
    }

    return badRequest()
  } catch (e) {
    // Never echo the error: it can carry the note or a birthdate straight from the RPC.
    console.error('admin eligibility write error')
    void e
    return adminInternalError()
  }
}
