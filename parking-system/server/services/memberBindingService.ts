import { isValidTaiwanMobilePhone, normalizePhone } from '@/lib/memberImport'
import {
  resolveVerifiedLineIdentity,
  verifyLiffIdToken,
  type IdTokenVerifier,
} from '@/server/services/memberAuthService'
import { createParkingRepository, type ParkingRepository } from '@/server/repositories/parkingRepository'

// ── LIFF binding claim (Phase 7 Slice 2) ─────────────────────────────────────
// An UNBOUND member submits name + mobile phone from the LIFF page; the server
// verifies their LINE identity (never trusting a client-sent userId) and records a
// pending claim for admin approval. NO auto-bind, and NO membership oracle: the
// response never reveals whether the phone matches a member — matching happens only
// at admin approval time.
//
// Privacy: the claimed name/phone go to pending_binding and nowhere else — never
// into logs, errors, or responses.

// Raw input caps (pre-validation) keep pathological payloads out of the parse path;
// the DB constraints (0022) are the final guard.
const MAX_RAW_NAME = 200
const MAX_RAW_PHONE = 30
const MAX_RAW_ID_TOKEN = 4096
export const MAX_CLAIM_NAME_CODEPOINTS = 50

export type BindingClaimResult =
  | { ok: true }
  | {
      ok: false
      reason: 'invalid_request' | 'invalid_token' | 'verify_unreachable' | 'line_account_already_bound'
    }

export async function submitBindingClaim(
  input: { idToken?: unknown; mockLineUserId?: unknown; name?: unknown; phone?: unknown },
  repo: ParkingRepository = createParkingRepository(),
  verifier: IdTokenVerifier = verifyLiffIdToken,
  now: Date = new Date(),
): Promise<BindingClaimResult> {
  // Input hardening BEFORE identity verification — malformed submissions never
  // reach the LINE verify endpoint or the capture RPC.
  if (typeof input.name !== 'string' || input.name.length > MAX_RAW_NAME) {
    return { ok: false, reason: 'invalid_request' }
  }
  // Count code points (Array.from), not UTF-16 units, so surrogate-pair characters
  // aren't double-counted against the 50 limit.
  const name = input.name.trim()
  const nameLength = Array.from(name).length
  if (nameLength < 1 || nameLength > MAX_CLAIM_NAME_CODEPOINTS) {
    return { ok: false, reason: 'invalid_request' }
  }

  if (typeof input.phone !== 'string' || input.phone.length > MAX_RAW_PHONE) {
    return { ok: false, reason: 'invalid_request' }
  }
  const phone = normalizePhone(input.phone)
  if (!isValidTaiwanMobilePhone(phone)) {
    return { ok: false, reason: 'invalid_request' }
  }

  if (typeof input.idToken === 'string' && input.idToken.length > MAX_RAW_ID_TOKEN) {
    return { ok: false, reason: 'invalid_request' }
  }

  const identity = await resolveVerifiedLineIdentity(input, verifier)
  if (!identity.ok) return identity

  // A bound account has no business claiming again — steer it back to login (the
  // caller learns only their own binding state, no third-party information).
  const existing = await repo.getUserByLineId(identity.lineUserId)
  if (existing) return { ok: false, reason: 'line_account_already_bound' }

  await repo.captureLiffBindingClaim({
    lineUserId: identity.lineUserId,
    phone,
    name,
    nowIso: now.toISOString(),
  })
  return { ok: true }
}
