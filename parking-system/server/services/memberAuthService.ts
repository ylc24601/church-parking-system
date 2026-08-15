import { MEMBER_SESSION_TTL_DAYS } from '@/lib/allocation/rules'
import { generateSessionToken, hashSessionToken } from '@/server/http/sessionToken'
import { isProductionRuntime } from '@/server/services/notification/lineTransport'
import { createParkingRepository, type ParkingRepository } from '@/server/repositories/parkingRepository'

// ── Member LIFF login (Phase 7 Slice 1) ──────────────────────────────────────
// The LIFF page posts its ID token; we verify it against LINE's verify endpoint
// (LINE checks signature/exp/aud — we assert transport outcome + iss + sub) and
// resolve users.line_id. Binding is a prerequisite: an unbound LINE account gets a
// typed `not_bound`, never an auto-bind (delivery-model decision 2026-07-06).
//
// Privacy: the ID token and the LINE userId (`sub`) must never be logged, returned
// to the client, or embedded in error messages. Typed reasons only.

const LINE_VERIFY_URL = 'https://api.line.me/oauth2/v2.1/verify'
const LINE_ISSUER = 'https://access.line.me'
// This is a public login entry point: a connected-but-silent LINE endpoint must not
// hold the request until the platform runtime timeout. Aborts surface through the
// same catch as network errors → verify_unreachable (retryable).
const LINE_VERIFY_TIMEOUT_MS = 8_000

export type MemberAuthMode =
  | { mode: 'mock' }
  | { mode: 'liff'; channelId: string }

// Config faults fail fast (mirrors NOTIFICATION_TRANSPORT posture): a production
// deploy must never silently accept mock identities, and liff mode without the
// LINE Login channel id cannot verify anything.
export class MemberAuthConfigError extends Error {
  constructor(
    readonly code: 'invalid_member_auth_mode' | 'mock_in_production' | 'missing_login_channel_id',
  ) {
    super(code)
    this.name = 'MemberAuthConfigError'
  }
}

export function resolveMemberAuthMode(): MemberAuthMode {
  const mode = process.env.MEMBER_AUTH_MODE
  if (mode === 'mock') {
    if (isProductionRuntime()) throw new MemberAuthConfigError('mock_in_production')
    return { mode: 'mock' }
  }
  if (mode === 'liff') {
    const channelId = process.env.LINE_LOGIN_CHANNEL_ID
    if (!channelId || channelId.trim() === '') {
      throw new MemberAuthConfigError('missing_login_channel_id')
    }
    return { mode: 'liff', channelId }
  }
  throw new MemberAuthConfigError('invalid_member_auth_mode')
}

export type VerifyIdTokenResult =
  | { ok: true; lineUserId: string }
  | { ok: false; reason: 'invalid_token' | 'verify_unreachable' }

export type IdTokenVerifier = (idToken: string, channelId: string) => Promise<VerifyIdTokenResult>

// LINE's verify endpoint validates signature/exp/aud server-side (aud via client_id).
// Outcome mapping (plan §Slice 1): 200 + iss + sub → ok; 4xx or bad body → invalid_token;
// network error / LINE 5xx → verify_unreachable (retryable, surfaced as 503).
export async function verifyLiffIdToken(
  idToken: string,
  channelId: string,
  fetchFn: typeof fetch = fetch,
): Promise<VerifyIdTokenResult> {
  let res: Response
  try {
    res = await fetchFn(LINE_VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: idToken, client_id: channelId }),
      signal: AbortSignal.timeout(LINE_VERIFY_TIMEOUT_MS),
    })
  } catch {
    return { ok: false, reason: 'verify_unreachable' }
  }
  if (res.status >= 500) return { ok: false, reason: 'verify_unreachable' }
  if (!res.ok) return { ok: false, reason: 'invalid_token' }

  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    return { ok: false, reason: 'invalid_token' }
  }
  const claims = body as { iss?: unknown; sub?: unknown }
  if (claims.iss !== LINE_ISSUER) return { ok: false, reason: 'invalid_token' }
  if (typeof claims.sub !== 'string' || claims.sub === '') {
    return { ok: false, reason: 'invalid_token' }
  }
  return { ok: true, lineUserId: claims.sub }
}

// ── Verified LINE identity resolver (shared by login and any sensitive member op) ──
// Owns exactly: auth-mode resolution, mock/liff branching, and ID-token verification.
// Returns a verified LINE userId and nothing else — it knows nothing about members,
// bindings, or sessions, so claim submission (Slice 2) and later member actions
// (Slices 3/4) reuse it without inheriting login semantics.
export type VerifiedLineIdentity =
  | { ok: true; lineUserId: string }
  | { ok: false; reason: 'invalid_request' | 'invalid_token' | 'verify_unreachable' }

export async function resolveVerifiedLineIdentity(
  input: { idToken?: unknown; mockLineUserId?: unknown },
  verifier: IdTokenVerifier = verifyLiffIdToken,
): Promise<VerifiedLineIdentity> {
  const auth = resolveMemberAuthMode()

  if (auth.mode === 'mock') {
    if (typeof input.mockLineUserId !== 'string' || input.mockLineUserId.trim() === '') {
      return { ok: false, reason: 'invalid_request' }
    }
    return { ok: true, lineUserId: input.mockLineUserId.trim() }
  }

  if (typeof input.idToken !== 'string' || input.idToken.trim() === '') {
    return { ok: false, reason: 'invalid_request' }
  }
  const verified = await verifier(input.idToken, auth.channelId)
  if (!verified.ok) return { ok: false, reason: verified.reason }
  return { ok: true, lineUserId: verified.lineUserId }
}

export type LoginResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'invalid_request' | 'invalid_token' | 'verify_unreachable' | 'not_bound' }

// Verify the caller's identity per MEMBER_AUTH_MODE, resolve the member by
// users.line_id, and mint a session (raw token returned once for the cookie; only
// its hash is stored). Expired sessions of the same member are lazily deleted.
export async function loginMember(
  input: { idToken?: unknown; mockLineUserId?: unknown },
  repo: ParkingRepository = createParkingRepository(),
  verifier: IdTokenVerifier = verifyLiffIdToken,
  now: Date = new Date(),
): Promise<LoginResult> {
  const identity = await resolveVerifiedLineIdentity(input, verifier)
  if (!identity.ok) return identity

  const user = await repo.getUserByLineId(identity.lineUserId)
  if (!user) return { ok: false, reason: 'not_bound' }

  await repo.deleteExpiredMemberSessions(user.id, now.toISOString())

  const token = generateSessionToken()
  await repo.createMemberSession({
    userId: user.id,
    tokenHash: hashSessionToken(token),
    expiresAt: new Date(now.getTime() + MEMBER_SESSION_TTL_DAYS * 24 * 3600_000).toISOString(),
  })
  return { ok: true, token }
}
