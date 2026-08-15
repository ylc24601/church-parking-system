import {
  ADMIN_LOGIN_LOCK_MINUTES,
  ADMIN_LOGIN_MAX_ATTEMPTS,
  ADMIN_SESSION_TTL_HOURS,
} from '@/lib/allocation/rules'
import {
  normalizeAdminDisplayName,
  normalizeAdminUsername,
  validateAdminPassword,
} from '@/lib/adminAccountInput'
import { hashPin, verifyPin } from '@/server/http/pinHash'
import { generateSessionToken, hashSessionToken } from '@/server/http/sessionToken'
import { createParkingRepository, type ParkingRepository } from '@/server/repositories/parkingRepository'

// ── Admin UI login (Phase 8 Slice 1) ─────────────────────────────────────────
// Per-admin username + scrypt password (admin_accounts), member-style opaque-token
// session (admin_sessions stores sha256 only). Privacy posture: unknown username,
// wrong password, disabled account, and an active lock are all externally the same
// 401 `invalid` (the route collapses `locked` too) — and every one of those paths
// burns one scrypt verify so response TIMING can't distinguish them either.
// An expired lock starts a NEW counting round (apply_admin_login_failure, 0025).

// Raw input bounds: anything beyond these is rejected before any DB read.
const MAX_USERNAME_RAW = 100
const MAX_PASSWORD_RAW = 512

// Fixed scrypt target for the no-account / disabled / locked paths. Computed once at
// module load; the password compared against it is the caller's, so the work factor
// matches a real verify.
const DUMMY_HASH = hashPin('admin-timing-equalizer')

export type AdminLoginResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'invalid' | 'locked' }

function isLocked(lockedAt: Date | null, now: Date): boolean {
  if (!lockedAt) return false
  return now.getTime() < lockedAt.getTime() + ADMIN_LOGIN_LOCK_MINUTES * 60_000
}

export async function loginAdmin(
  input: { username?: unknown; password?: unknown },
  repo: ParkingRepository = createParkingRepository(),
  now: Date = new Date(),
): Promise<AdminLoginResult> {
  const { username, password } = input
  if (typeof username !== 'string' || typeof password !== 'string') {
    return { ok: false, reason: 'invalid' }
  }
  if (username.length === 0 || username.length > MAX_USERNAME_RAW) {
    return { ok: false, reason: 'invalid' }
  }
  if (password.length === 0 || password.length > MAX_PASSWORD_RAW) {
    return { ok: false, reason: 'invalid' }
  }
  const normalized = username.trim().toLowerCase()
  if (normalized.length === 0) return { ok: false, reason: 'invalid' }

  const account = await repo.getAdminAccountByUsername(normalized)
  if (!account) {
    verifyPin(password, DUMMY_HASH)
    return { ok: false, reason: 'invalid' }
  }
  if (account.disabled_at !== null) {
    verifyPin(password, DUMMY_HASH)
    return { ok: false, reason: 'invalid' }
  }
  // Active lock: no verify against the real hash, no counter bump (repeated attempts
  // must not extend the lock) — but still one scrypt so timing stays flat.
  if (isLocked(account.locked_at, now)) {
    verifyPin(password, DUMMY_HASH)
    return { ok: false, reason: 'locked' }
  }

  if (verifyPin(password, account.password_hash)) {
    // Clears failed_attempts AND a stale (expired) locked_at.
    await repo.resetAdminLoginFailures(account.id)
    await repo.deleteExpiredAdminSessions(account.id, now.toISOString())

    const token = generateSessionToken()
    // Must throw on failure (route → 500): the cookie is only set after this row
    // exists, and the raw token is never logged.
    await repo.createAdminSession({
      adminId: account.id,
      tokenHash: hashSessionToken(token),
      expiresAt: new Date(now.getTime() + ADMIN_SESSION_TTL_HOURS * 3600_000).toISOString(),
    })
    return { ok: true, token }
  }

  // Lock-cycle semantics live in the RPC (atomic): expired lock → this failure is #1.
  const after = await repo.applyAdminLoginFailure({
    id: account.id,
    nowIso: now.toISOString(),
    threshold: ADMIN_LOGIN_MAX_ATTEMPTS,
    lockMinutes: ADMIN_LOGIN_LOCK_MINUTES,
  })
  return { ok: false, reason: isLocked(after.locked_at, now) ? 'locked' : 'invalid' }
}

// CLI provisioning (scripts/run-admin-create.ts). The plaintext password is hashed
// here and never stored or logged.
//
// Wave 2C-1 (#19): the CLI always provisions a 系統管理員. It is the recovery path —
// the way back in when every UI account is locked out — so it necessarily carries full
// power, and there is deliberately no --role flag to make that a per-invocation choice.
// The safety is at the caller (CONFIRM_CREATE_SUPERADMIN, see the script), not here.
//
// This path writes NO audit row, and that is honest rather than lazy: it runs with the
// service-role key, and anyone holding that key can already bypass the whole audit
// substrate (0030 — it raises the cost of FORGING a row, not of skipping one). Grants
// made through the UI are audited; this one is governed by who holds the key.
export async function createAdminAccount(
  args: { username: string; password: string; displayName?: string | null },
  repo: ParkingRepository = createParkingRepository(),
): Promise<{ username: string }> {
  // Same validation the UI path uses (lib/adminAccountInput.ts), so the CLI and the
  // back office agree on what a legal account is.
  const username = normalizeAdminUsername(args.username)
  if (username === null) throw new Error('username must be 3–32 chars of a-z 0-9 _ . - after trim+lowercase')
  const passwordError = validateAdminPassword(args.password)
  if (passwordError) throw new Error(passwordError)
  const name = normalizeAdminDisplayName(args.displayName)
  if (!name.ok) throw new Error('display name must be at most 80 characters')

  const { inserted } = await repo.insertAdminAccount({
    username,
    passwordHash: hashPin(args.password),
    displayName: name.value,
    role: 'superadmin',
  })
  if (!inserted) throw new Error('username already exists')
  return { username }
}
