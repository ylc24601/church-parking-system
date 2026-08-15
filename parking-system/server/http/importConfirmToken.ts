// Signs with the service-role key — machine-enforced server boundary (build-time error
// if a Client Component ever pulls this in). See lib/supabase/server.ts.
import 'server-only'

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

// ── Member-import confirmation token (Phase 8 Slice 5) ───────────────────────
// The two-step upload (preview → apply) must guarantee the applied CSV is the exact
// one the operator previewed. Rather than store the (PII-bearing) upload server-side,
// preview issues a short-lived HMAC-signed token binding sha256(csv bytes) + admin id
// + expiry. Apply re-hashes its body and verifies the token, so a swapped file,
// a skipped preview, a stale preview, or another admin's token all fail closed.
//
// The signing key is derived from SUPABASE_SERVICE_ROLE_KEY (always present
// server-side, never sent to the browser) with domain separation, so we don't reuse
// the raw key and need no new env var.

const TOKEN_TTL_MS = 30 * 60_000 // 30 minutes
const DOMAIN = 'member-import-confirm-v1'

export type ImportTokenFailure = 'bad_token' | 'expired' | 'admin_mismatch' | 'digest_mismatch'

export function csvDigestHex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function signingKey(): Buffer {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!secret) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY (server-only)')
  // Domain-separated subkey so this HMAC purpose is distinct from the raw service key.
  return createHmac('sha256', secret).update(DOMAIN).digest()
}

function sign(payload: string): string {
  return createHmac('sha256', signingKey()).update(payload, 'utf8').digest('base64url')
}

export function issueImportConfirmToken(args: { csvDigest: string; adminId: string; now?: Date }): string {
  const expiresAt = (args.now ?? new Date()).getTime() + TOKEN_TTL_MS
  const payload = `${args.csvDigest}.${args.adminId}.${expiresAt}`
  return `${Buffer.from(payload, 'utf8').toString('base64url')}.${sign(payload)}`
}

export function verifyImportConfirmToken(
  token: string | null | undefined,
  expected: { csvDigest: string; adminId: string; now?: Date },
): { ok: true } | { ok: false; reason: ImportTokenFailure } {
  if (!token) return { ok: false, reason: 'bad_token' }
  const parts = token.split('.')
  if (parts.length !== 2) return { ok: false, reason: 'bad_token' }
  const [payloadB64, providedSig] = parts

  let payload: string
  try {
    payload = Buffer.from(payloadB64, 'base64url').toString('utf8')
  } catch {
    return { ok: false, reason: 'bad_token' }
  }

  // Constant-time signature check before trusting any field.
  const expectedSig = Buffer.from(sign(payload), 'utf8')
  const providedSigBuf = Buffer.from(providedSig, 'utf8')
  if (providedSigBuf.length !== expectedSig.length || !timingSafeEqual(providedSigBuf, expectedSig)) {
    return { ok: false, reason: 'bad_token' }
  }

  const segments = payload.split('.')
  if (segments.length !== 3) return { ok: false, reason: 'bad_token' }
  const [digest, adminId, expiresAtRaw] = segments
  const expiresAt = Number(expiresAtRaw)
  if (!Number.isFinite(expiresAt)) return { ok: false, reason: 'bad_token' }

  const nowMs = (expected.now ?? new Date()).getTime()
  if (nowMs >= expiresAt) return { ok: false, reason: 'expired' }
  if (adminId !== expected.adminId) return { ok: false, reason: 'admin_mismatch' }
  if (digest !== expected.csvDigest) return { ok: false, reason: 'digest_mismatch' }
  return { ok: true }
}
