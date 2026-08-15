import { beforeAll, describe, expect, it } from 'vitest'
import {
  csvDigestHex,
  issueImportConfirmToken,
  verifyImportConfirmToken,
} from '@/server/http/importConfirmToken'

// The signing key is derived from SUPABASE_SERVICE_ROLE_KEY; set a fixed one for the test.
beforeAll(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-role-key-for-hmac'
})

const bytes = new TextEncoder().encode('applicant_name,mobile_phone\n王,0912345678\n')
const DIGEST = csvDigestHex(bytes)
const ADMIN = 'admin-1'
const NOW = new Date('2026-07-12T00:00:00Z')

describe('import confirmation token', () => {
  it('round-trips: a fresh token for the same digest + admin verifies', () => {
    const token = issueImportConfirmToken({ csvDigest: DIGEST, adminId: ADMIN, now: NOW })
    expect(verifyImportConfirmToken(token, { csvDigest: DIGEST, adminId: ADMIN, now: NOW })).toEqual({ ok: true })
  })

  it('rejects a different CSV digest (content changed between preview and apply)', () => {
    const token = issueImportConfirmToken({ csvDigest: DIGEST, adminId: ADMIN, now: NOW })
    const other = csvDigestHex(new TextEncoder().encode('different'))
    expect(verifyImportConfirmToken(token, { csvDigest: other, adminId: ADMIN, now: NOW }))
      .toEqual({ ok: false, reason: 'digest_mismatch' })
  })

  it('rejects a token issued to another admin', () => {
    const token = issueImportConfirmToken({ csvDigest: DIGEST, adminId: 'admin-2', now: NOW })
    expect(verifyImportConfirmToken(token, { csvDigest: DIGEST, adminId: ADMIN, now: NOW }))
      .toEqual({ ok: false, reason: 'admin_mismatch' })
  })

  it('rejects an expired token (past the 30-minute TTL)', () => {
    const token = issueImportConfirmToken({ csvDigest: DIGEST, adminId: ADMIN, now: NOW })
    const later = new Date(NOW.getTime() + 31 * 60_000)
    expect(verifyImportConfirmToken(token, { csvDigest: DIGEST, adminId: ADMIN, now: later }))
      .toEqual({ ok: false, reason: 'expired' })
  })

  it('rejects a tampered signature', () => {
    const token = issueImportConfirmToken({ csvDigest: DIGEST, adminId: ADMIN, now: NOW })
    const [payload] = token.split('.')
    const forged = `${payload}.${Buffer.from('forged-signature').toString('base64url')}`
    expect(verifyImportConfirmToken(forged, { csvDigest: DIGEST, adminId: ADMIN, now: NOW }))
      .toEqual({ ok: false, reason: 'bad_token' })
  })

  it('rejects a tampered payload (digest edited but signature stale)', () => {
    const token = issueImportConfirmToken({ csvDigest: DIGEST, adminId: ADMIN, now: NOW })
    const [, sig] = token.split('.')
    const evilPayload = Buffer.from(`${'0'.repeat(64)}.${ADMIN}.${NOW.getTime() + 60_000}`, 'utf8').toString('base64url')
    expect(verifyImportConfirmToken(`${evilPayload}.${sig}`, { csvDigest: '0'.repeat(64), adminId: ADMIN, now: NOW }))
      .toEqual({ ok: false, reason: 'bad_token' })
  })

  it.each([null, undefined, '', 'nope', 'a.b.c'])('rejects a malformed token (%s)', token => {
    expect(verifyImportConfirmToken(token as string | null, { csvDigest: DIGEST, adminId: ADMIN, now: NOW }))
      .toEqual({ ok: false, reason: 'bad_token' })
  })
})
