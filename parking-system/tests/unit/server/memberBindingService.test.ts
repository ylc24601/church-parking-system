import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeMockRepo, asRepo, type MockRepo } from './mockRepo'
import { submitBindingClaim } from '@/server/services/memberBindingService'
import type { IdTokenVerifier } from '@/server/services/memberAuthService'

const NOW = new Date('2026-07-10T00:00:00Z')
const RAW_LINE_ID = 'Udeadbeefdeadbeefdeadbeefdeadbeef'
const RAW_ID_TOKEN = 'eyJraWQtototallysecret.idtoken.value'
const RAW_PHONE = '0912345678'
const RAW_NAME = '王小明'

const saved = { ...process.env }
afterEach(() => {
  process.env = { ...saved }
})

// Unbound by default: claims come from accounts that are NOT members yet.
function run(over: Partial<MockRepo> = {}) {
  const repo = makeMockRepo({ getUserByLineId: vi.fn(async () => null), ...over })
  return { repo, r: asRepo(repo) }
}

const mockEnv = () => {
  process.env.MEMBER_AUTH_MODE = 'mock'
}

describe('submitBindingClaim (mock mode)', () => {
  it('valid claim → captures name (trimmed) + normalized phone for the verified account', async () => {
    mockEnv()
    const { repo, r } = run()
    const res = await submitBindingClaim(
      { mockLineUserId: RAW_LINE_ID, name: `  ${RAW_NAME}  `, phone: '0912-345-678' },
      r, undefined, NOW,
    )
    expect(res).toEqual({ ok: true })
    expect(repo.captureLiffBindingClaim).toHaveBeenCalledWith({
      lineUserId: RAW_LINE_ID,
      phone: RAW_PHONE,               // normalized: separators stripped
      name: RAW_NAME,                 // trimmed
      nowIso: NOW.toISOString(),
    })
  })

  it('an already-bound LINE account → line_account_already_bound, capture NOT called', async () => {
    mockEnv()
    const { repo, r } = run({ getUserByLineId: vi.fn(async () => ({ id: 'user-1', display_name: RAW_NAME })) })
    expect(await submitBindingClaim({ mockLineUserId: RAW_LINE_ID, name: RAW_NAME, phone: RAW_PHONE }, r, undefined, NOW))
      .toEqual({ ok: false, reason: 'line_account_already_bound' })
    expect(repo.captureLiffBindingClaim).not.toHaveBeenCalled()
  })

  describe('input hardening → invalid_request (capture + verify untouched)', () => {
    it.each([
      ['missing name', { phone: RAW_PHONE }],
      ['empty name after trim', { name: '   ', phone: RAW_PHONE }],
      ['name over 50 code points', { name: '王'.repeat(51), phone: RAW_PHONE }],
      ['raw name over 200 chars', { name: 'x'.repeat(201), phone: RAW_PHONE }],
      ['missing phone', { name: RAW_NAME }],
      ['landline-style phone', { name: RAW_NAME, phone: '021234567' }],
      ['too-short mobile', { name: RAW_NAME, phone: '0912345' }],
      ['raw phone over 30 chars', { name: RAW_NAME, phone: '0'.repeat(31) }],
    ])('%s', async (_label, fields) => {
      mockEnv()
      const { repo, r } = run()
      expect(await submitBindingClaim({ mockLineUserId: RAW_LINE_ID, ...fields }, r, undefined, NOW))
        .toEqual({ ok: false, reason: 'invalid_request' })
      expect(repo.captureLiffBindingClaim).not.toHaveBeenCalled()
      expect(repo.getUserByLineId).not.toHaveBeenCalled()
    })

    it('counts name length in code points: 50 astral chars pass, 51 fail', async () => {
      mockEnv()
      const { r } = run()
      const astral = '𝒳'.repeat(50)   // each is 2 UTF-16 units; .length would be 100
      expect(await submitBindingClaim({ mockLineUserId: RAW_LINE_ID, name: astral, phone: RAW_PHONE }, r, undefined, NOW))
        .toEqual({ ok: true })
      expect(await submitBindingClaim({ mockLineUserId: RAW_LINE_ID, name: '𝒳'.repeat(51), phone: RAW_PHONE }, r, undefined, NOW))
        .toEqual({ ok: false, reason: 'invalid_request' })
    })
  })
})

describe('submitBindingClaim (liff mode)', () => {
  const liffEnv = () => {
    process.env.MEMBER_AUTH_MODE = 'liff'
    process.env.LINE_LOGIN_CHANNEL_ID = '1234567890'
  }

  it('verifies the ID token and claims under the VERIFIED userId (client id is never trusted)', async () => {
    liffEnv()
    const { repo, r } = run()
    const verifier = vi.fn<IdTokenVerifier>(async () => ({ ok: true, lineUserId: RAW_LINE_ID }))
    const res = await submitBindingClaim(
      // A hostile client sending mockLineUserId alongside must be ignored in liff mode.
      { idToken: RAW_ID_TOKEN, mockLineUserId: 'U_attacker', name: RAW_NAME, phone: RAW_PHONE },
      r, verifier, NOW,
    )
    expect(res).toEqual({ ok: true })
    expect(verifier).toHaveBeenCalledWith(RAW_ID_TOKEN, '1234567890')
    expect(repo.captureLiffBindingClaim.mock.calls[0][0].lineUserId).toBe(RAW_LINE_ID)
  })

  it('identity failures pass through typed; capture is never reached', async () => {
    liffEnv()
    const { repo, r } = run()
    const invalid: IdTokenVerifier = async () => ({ ok: false, reason: 'invalid_token' })
    expect(await submitBindingClaim({ idToken: RAW_ID_TOKEN, name: RAW_NAME, phone: RAW_PHONE }, r, invalid, NOW))
      .toEqual({ ok: false, reason: 'invalid_token' })
    const down: IdTokenVerifier = async () => ({ ok: false, reason: 'verify_unreachable' })
    expect(await submitBindingClaim({ idToken: RAW_ID_TOKEN, name: RAW_NAME, phone: RAW_PHONE }, r, down, NOW))
      .toEqual({ ok: false, reason: 'verify_unreachable' })
    expect(repo.captureLiffBindingClaim).not.toHaveBeenCalled()
  })

  it('oversized ID token → invalid_request before any verification', async () => {
    liffEnv()
    const { r } = run()
    const verifier = vi.fn<IdTokenVerifier>(async () => ({ ok: true, lineUserId: RAW_LINE_ID }))
    expect(await submitBindingClaim({ idToken: 'x'.repeat(4097), name: RAW_NAME, phone: RAW_PHONE }, r, verifier, NOW))
      .toEqual({ ok: false, reason: 'invalid_request' })
    expect(verifier).not.toHaveBeenCalled()
  })

  it('never leaks the claim payload, token, or userId through results or repo errors', async () => {
    liffEnv()
    const { r } = run({
      captureLiffBindingClaim: vi.fn(async () => {
        throw new Error('capture_liff_binding_claim failed: connection refused')
      }),
    })
    const verifier: IdTokenVerifier = async () => ({ ok: true, lineUserId: RAW_LINE_ID })
    try {
      await submitBindingClaim({ idToken: RAW_ID_TOKEN, name: RAW_NAME, phone: RAW_PHONE }, r, verifier, NOW)
      expect.unreachable('repo error expected')
    } catch (e) {
      const msg = String(e)
      expect(msg).not.toContain(RAW_PHONE)
      expect(msg).not.toContain(RAW_NAME)
      expect(msg).not.toContain(RAW_ID_TOKEN)
      expect(msg).not.toContain(RAW_LINE_ID)
    }
  })
})
