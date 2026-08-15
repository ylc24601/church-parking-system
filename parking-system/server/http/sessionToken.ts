import { createHash, randomBytes } from 'node:crypto'

// Opaque member-session token (Phase 7 Slice 1). The cookie carries the raw token;
// the DB stores only sha256(token), so a member_sessions leak alone yields nothing
// usable. 32 random bytes ≈ 256 bits — no need for a slow hash (unlike PINs, the
// token is not guessable/enumerable), sha256 keeps lookups a single indexed read.

export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}
