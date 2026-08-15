import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeMockRepo, asRepo, type MockRepo } from './mockRepo'
import {
  MemberAuthConfigError,
  loginMember,
  resolveMemberAuthMode,
  verifyLiffIdToken,
  type IdTokenVerifier,
} from '@/server/services/memberAuthService'
import { hashSessionToken } from '@/server/http/sessionToken'

const NOW = new Date('2026-07-10T00:00:00Z')
const RAW_LINE_ID = 'Udeadbeefdeadbeefdeadbeefdeadbeef'
const RAW_ID_TOKEN = 'eyJraWQtototallysecret.idtoken.value'

const saved = { ...process.env }
afterEach(() => {
  process.env = { ...saved }
})

function run(over: Partial<MockRepo> = {}) {
  const repo = makeMockRepo(over)
  return { repo, r: asRepo(repo) }
}

// ── resolveMemberAuthMode: explicit, fail-fast (NOTIFICATION_TRANSPORT posture) ──

describe('resolveMemberAuthMode', () => {
  it('mock mode resolves outside production', () => {
    process.env.MEMBER_AUTH_MODE = 'mock'
    expect(resolveMemberAuthMode()).toEqual({ mode: 'mock' })
  })

  it('mock mode in production fails fast (mock_in_production)', () => {
    process.env.MEMBER_AUTH_MODE = 'mock'
    process.env.VERCEL_ENV = 'production'
    expect(() => resolveMemberAuthMode()).toThrowError(
      expect.objectContaining({ code: 'mock_in_production' }),
    )
  })

  it('liff mode requires LINE_LOGIN_CHANNEL_ID', () => {
    process.env.MEMBER_AUTH_MODE = 'liff'
    delete process.env.LINE_LOGIN_CHANNEL_ID
    expect(() => resolveMemberAuthMode()).toThrowError(
      expect.objectContaining({ code: 'missing_login_channel_id' }),
    )
    process.env.LINE_LOGIN_CHANNEL_ID = '1234567890'
    expect(resolveMemberAuthMode()).toEqual({ mode: 'liff', channelId: '1234567890' })
  })

  it('unset or unknown mode fails fast rather than guessing', () => {
    delete process.env.MEMBER_AUTH_MODE
    expect(() => resolveMemberAuthMode()).toThrowError(MemberAuthConfigError)
    process.env.MEMBER_AUTH_MODE = 'whatever'
    expect(() => resolveMemberAuthMode()).toThrowError(
      expect.objectContaining({ code: 'invalid_member_auth_mode' }),
    )
  })
})

// ── verifyLiffIdToken: outcome table from the plan ─────────────────────────────

describe('verifyLiffIdToken', () => {
  const jsonResponse = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  it('200 + LINE issuer + sub → ok with the LINE userId', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(200, { iss: 'https://access.line.me', sub: RAW_LINE_ID, aud: '123' }),
    )
    const res = await verifyLiffIdToken(RAW_ID_TOKEN, '123', fetchFn as unknown as typeof fetch)
    expect(res).toEqual({ ok: true, lineUserId: RAW_LINE_ID })
    // The token is passed to LINE as form data — and nowhere else.
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.line.me/oauth2/v2.1/verify')
    expect(String(init.body)).toContain('client_id=123')
  })

  it('HTTP 400 (LINE rejected signature/exp/aud) → invalid_token', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(400, { error: 'invalid_request' }))
    expect(await verifyLiffIdToken(RAW_ID_TOKEN, '123', fetchFn as unknown as typeof fetch)).toEqual({
      ok: false,
      reason: 'invalid_token',
    })
  })

  it('200 but wrong issuer or missing sub → invalid_token', async () => {
    const wrongIss = vi.fn(async () => jsonResponse(200, { iss: 'https://evil.example', sub: RAW_LINE_ID }))
    expect(await verifyLiffIdToken(RAW_ID_TOKEN, '123', wrongIss as unknown as typeof fetch)).toEqual({
      ok: false,
      reason: 'invalid_token',
    })
    const noSub = vi.fn(async () => jsonResponse(200, { iss: 'https://access.line.me', sub: '' }))
    expect(await verifyLiffIdToken(RAW_ID_TOKEN, '123', noSub as unknown as typeof fetch)).toEqual({
      ok: false,
      reason: 'invalid_token',
    })
  })

  it('network error / LINE 5xx → verify_unreachable (retryable)', async () => {
    const netErr = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    expect(await verifyLiffIdToken(RAW_ID_TOKEN, '123', netErr as unknown as typeof fetch)).toEqual({
      ok: false,
      reason: 'verify_unreachable',
    })
    const http500 = vi.fn(async () => jsonResponse(500, {}))
    expect(await verifyLiffIdToken(RAW_ID_TOKEN, '123', http500 as unknown as typeof fetch)).toEqual({
      ok: false,
      reason: 'verify_unreachable',
    })
  })

  it('passes an abort timeout to fetch; a timeout abort → verify_unreachable', async () => {
    // A connected-but-silent LINE endpoint must not hang this public login entry:
    // the request carries AbortSignal.timeout, and its TimeoutError maps retryable.
    const timedOut = vi.fn(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    })
    expect(await verifyLiffIdToken(RAW_ID_TOKEN, '123', timedOut as unknown as typeof fetch)).toEqual({
      ok: false,
      reason: 'verify_unreachable',
    })

    const okFetch = vi.fn(async () =>
      jsonResponse(200, { iss: 'https://access.line.me', sub: RAW_LINE_ID }),
    )
    await verifyLiffIdToken(RAW_ID_TOKEN, '123', okFetch as unknown as typeof fetch)
    const [, init] = okFetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })
})

// ── loginMember ───────────────────────────────────────────────────────────────

describe('loginMember (mock mode)', () => {
  it('bound member → mints a session; DB stores the sha256, never the raw token', async () => {
    process.env.MEMBER_AUTH_MODE = 'mock'
    const { repo, r } = run()
    const res = await loginMember({ mockLineUserId: RAW_LINE_ID }, r, undefined, NOW)
    expect(res.ok).toBe(true)
    const token = (res as { ok: true; token: string }).token

    expect(repo.getUserByLineId).toHaveBeenCalledWith(RAW_LINE_ID)
    expect(repo.createMemberSession).toHaveBeenCalledTimes(1)
    const arg = repo.createMemberSession.mock.calls[0][0]
    expect(arg.userId).toBe('user-1')
    expect(arg.tokenHash).toBe(hashSessionToken(token))
    expect(arg.tokenHash).not.toBe(token)
    // 30-day TTL from `now`
    expect(arg.expiresAt).toBe(new Date('2026-08-09T00:00:00Z').toISOString())
    // Lazy cleanup of the member's expired rows happens on login.
    expect(repo.deleteExpiredMemberSessions).toHaveBeenCalledWith('user-1', NOW.toISOString())
  })

  it('unbound LINE account → typed not_bound, no session row', async () => {
    process.env.MEMBER_AUTH_MODE = 'mock'
    const { repo, r } = run({ getUserByLineId: vi.fn(async () => null) })
    expect(await loginMember({ mockLineUserId: RAW_LINE_ID }, r, undefined, NOW)).toEqual({
      ok: false,
      reason: 'not_bound',
    })
    expect(repo.createMemberSession).not.toHaveBeenCalled()
  })

  it('missing/blank mockLineUserId → invalid_request', async () => {
    process.env.MEMBER_AUTH_MODE = 'mock'
    const { r } = run()
    expect(await loginMember({}, r, undefined, NOW)).toEqual({ ok: false, reason: 'invalid_request' })
    expect(await loginMember({ mockLineUserId: '  ' }, r, undefined, NOW)).toEqual({
      ok: false,
      reason: 'invalid_request',
    })
  })
})

describe('loginMember (liff mode)', () => {
  const withLiffEnv = () => {
    process.env.MEMBER_AUTH_MODE = 'liff'
    process.env.LINE_LOGIN_CHANNEL_ID = '1234567890'
  }

  it('verified token → session for the bound member', async () => {
    withLiffEnv()
    const { repo, r } = run()
    const verifier = vi.fn<IdTokenVerifier>(async () => ({ ok: true, lineUserId: RAW_LINE_ID }))
    const res = await loginMember({ idToken: RAW_ID_TOKEN }, r, verifier, NOW)
    expect(res.ok).toBe(true)
    expect(verifier).toHaveBeenCalledWith(RAW_ID_TOKEN, '1234567890')
    expect(repo.getUserByLineId).toHaveBeenCalledWith(RAW_LINE_ID)
  })

  it('verifier failures pass through typed; no member lookup happens', async () => {
    withLiffEnv()
    const { repo, r } = run()
    const invalid: IdTokenVerifier = async () => ({ ok: false, reason: 'invalid_token' })
    expect(await loginMember({ idToken: RAW_ID_TOKEN }, r, invalid, NOW)).toEqual({
      ok: false,
      reason: 'invalid_token',
    })
    const down: IdTokenVerifier = async () => ({ ok: false, reason: 'verify_unreachable' })
    expect(await loginMember({ idToken: RAW_ID_TOKEN }, r, down, NOW)).toEqual({
      ok: false,
      reason: 'verify_unreachable',
    })
    expect(repo.getUserByLineId).not.toHaveBeenCalled()
  })

  it('missing idToken → invalid_request (mockLineUserId is ignored in liff mode)', async () => {
    withLiffEnv()
    const { repo, r } = run()
    expect(await loginMember({ mockLineUserId: RAW_LINE_ID }, r, undefined, NOW)).toEqual({
      ok: false,
      reason: 'invalid_request',
    })
    expect(repo.getUserByLineId).not.toHaveBeenCalled()
  })

  it('never leaks the raw token or LINE userId in results or thrown errors', async () => {
    withLiffEnv()
    const { r } = run({ getUserByLineId: vi.fn(async () => null) })
    const verifier: IdTokenVerifier = async () => ({ ok: true, lineUserId: RAW_LINE_ID })
    const res = await loginMember({ idToken: RAW_ID_TOKEN }, r, verifier, NOW)
    const dump = JSON.stringify(res)
    expect(dump).not.toContain(RAW_LINE_ID)
    expect(dump).not.toContain(RAW_ID_TOKEN)

    delete process.env.LINE_LOGIN_CHANNEL_ID
    try {
      await loginMember({ idToken: RAW_ID_TOKEN }, r, verifier, NOW)
      expect.unreachable('config error expected')
    } catch (e) {
      expect(String(e)).not.toContain(RAW_ID_TOKEN)
      expect(String(e)).not.toContain(RAW_LINE_ID)
    }
  })
})
