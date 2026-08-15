import { ADMIN_ROLES, type AdminRole } from '@/lib/adminRoles'

// Admin account input rules (Wave 2C-2 / #19), in one client-safe module.
//
// It lives in lib/ rather than in adminAuthService so both the CLI and the UI-facing
// route can share one definition without pulling in server code. adminAuthService runs
// `const DUMMY_HASH = hashPin('admin-timing-equalizer')` at module load (the login
// timing equalizer); importing it just to reuse a regex would run that scrypt on every
// account-management request. Keeping the rules here avoids that entirely.
//
// The DB is still the final authority — admin_accounts_username_ck and the unique index
// (0025) enforce the same shape and uniqueness. These functions exist so a bad value is
// a typed 400 at the edge, not a 500 from a raised DB exception.

// Mirrors admin_accounts_username_ck (0025): lowercase, 3–32 of [a-z0-9_.-].
const USERNAME_FORMAT = /^[a-z0-9_.-]{3,32}$/
const MIN_PASSWORD_LENGTH = 12
const MAX_DISPLAY_NAME_CODEPOINTS = 80

// trim + lowercase, then validate. Returns null when the result is not a legal username
// so callers can map that to one typed outcome (400 / thrown, per caller).
export function normalizeAdminUsername(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const username = raw.trim().toLowerCase()
  return USERNAME_FORMAT.test(username) ? username : null
}

// Empty/whitespace → null (the column is nullable). Over-length → null so the caller
// rejects rather than silently truncating. A valid name is returned trimmed.
export function normalizeAdminDisplayName(raw: unknown): { ok: true; value: string | null } | { ok: false } {
  if (raw === null || raw === undefined) return { ok: true, value: null }
  if (typeof raw !== 'string') return { ok: false }
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: true, value: null }
  if ([...trimmed].length > MAX_DISPLAY_NAME_CODEPOINTS) return { ok: false }
  return { ok: true, value: trimmed }
}

// For the CLI path only — the UI never accepts an operator-supplied password (it is
// server-generated). Returns an error string or null.
export function validateAdminPassword(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `password must be at least ${MIN_PASSWORD_LENGTH} characters`
  }
  return null
}

// Runtime guard so a role from an HTTP body or an audit row is checked, never cast with
// `as AdminRole`. The audit viewer's unknown-role display shares this.
export function isAdminRole(value: unknown): value is AdminRole {
  return typeof value === 'string' && (ADMIN_ROLES as readonly string[]).includes(value)
}
