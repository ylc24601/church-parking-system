import { describe, expect, it, vi } from 'vitest'
import { makeMockRepo, asRepo, type MockRepo } from './mockRepo'
import { hashPin } from '@/server/http/pinHash'
import { hashSessionToken } from '@/server/http/sessionToken'
import { createAdminAccount, loginAdmin } from '@/server/services/adminAuthService'

const NOW = new Date('2026-07-11T00:00:00Z')
const PASSWORD = 'correct-horse-battery'
const PASSWORD_HASH = hashPin(PASSWORD)

function account(over: Record<string, unknown> = {}) {
  return {
    id: 'admin-1',
    username: 'alice',
    password_hash: PASSWORD_HASH,
    failed_attempts: 0,
    locked_at: null,
    disabled_at: null,
    ...over,
  }
}

function run(over: Partial<MockRepo> = {}) {
  const repo = makeMockRepo(over)
  return { repo, r: asRepo(repo) }
}

describe('loginAdmin', () => {
  it('success: mints an opaque token, stores only its sha256, TTL 12h, lazily cleans expired sessions', async () => {
    const { repo, r } = run({ getAdminAccountByUsername: vi.fn(async () => account()) })
    const result = await loginAdmin({ username: 'Alice ', password: PASSWORD }, r, NOW)
    expect(result.ok).toBe(true)
    const token = (result as { ok: true; token: string }).token
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)

    expect(repo.getAdminAccountByUsername).toHaveBeenCalledWith('alice') // trim+lowercase
    expect(repo.resetAdminLoginFailures).toHaveBeenCalledWith('admin-1')
    expect(repo.deleteExpiredAdminSessions).toHaveBeenCalledWith('admin-1', NOW.toISOString())
    const created = repo.createAdminSession.mock.calls[0][0]
    expect(created.tokenHash).toBe(hashSessionToken(token))       // raw token never stored
    expect(created.expiresAt).toBe('2026-07-11T12:00:00.000Z')    // ADMIN_SESSION_TTL_HOURS
  })

  it.each([
    ['non-string username', { username: 42, password: PASSWORD }],
    ['non-string password', { username: 'alice', password: null }],
    ['empty username', { username: '', password: PASSWORD }],
    ['empty password', { username: 'alice', password: '' }],
    ['over-long username', { username: 'a'.repeat(101), password: PASSWORD }],
    ['over-long password', { username: 'alice', password: 'p'.repeat(513) }],
  ])('input bound (%s) → invalid WITHOUT any DB read', async (_name, input) => {
    const { repo, r } = run()
    expect(await loginAdmin(input as { username?: unknown; password?: unknown }, r, NOW))
      .toEqual({ ok: false, reason: 'invalid' })
    expect(repo.getAdminAccountByUsername).not.toHaveBeenCalled()
  })

  it('unknown username → invalid, no failure applied (nothing to count against)', async () => {
    const { repo, r } = run({ getAdminAccountByUsername: vi.fn(async () => null) })
    expect(await loginAdmin({ username: 'ghost', password: PASSWORD }, r, NOW))
      .toEqual({ ok: false, reason: 'invalid' })
    expect(repo.applyAdminLoginFailure).not.toHaveBeenCalled()
    expect(repo.createAdminSession).not.toHaveBeenCalled()
  })

  it('disabled account → generic invalid even with the correct password', async () => {
    const { repo, r } = run({
      getAdminAccountByUsername: vi.fn(async () => account({ disabled_at: new Date('2026-07-01T00:00:00Z') })),
    })
    expect(await loginAdmin({ username: 'alice', password: PASSWORD }, r, NOW))
      .toEqual({ ok: false, reason: 'invalid' })
    expect(repo.createAdminSession).not.toHaveBeenCalled()
    expect(repo.applyAdminLoginFailure).not.toHaveBeenCalled()
  })

  it('active lock → locked without touching the counter (repeat attempts cannot extend the lock)', async () => {
    const { repo, r } = run({
      getAdminAccountByUsername: vi.fn(async () =>
        account({ failed_attempts: 5, locked_at: new Date('2026-07-10T23:50:00Z') })), // 10 min ago < 15
    })
    expect(await loginAdmin({ username: 'alice', password: PASSWORD }, r, NOW))
      .toEqual({ ok: false, reason: 'locked' })
    expect(repo.applyAdminLoginFailure).not.toHaveBeenCalled()
    expect(repo.createAdminSession).not.toHaveBeenCalled()
  })

  it('EXPIRED lock + correct password → login succeeds and the counter is reset', async () => {
    const { repo, r } = run({
      getAdminAccountByUsername: vi.fn(async () =>
        account({ failed_attempts: 5, locked_at: new Date('2026-07-10T23:40:00Z') })), // 20 min ago > 15
    })
    const result = await loginAdmin({ username: 'alice', password: PASSWORD }, r, NOW)
    expect(result.ok).toBe(true)
    expect(repo.resetAdminLoginFailures).toHaveBeenCalledWith('admin-1')
  })

  it('EXPIRED lock + wrong password → failure RPC decides (new round), passing now/threshold/lock window', async () => {
    const { repo, r } = run({
      getAdminAccountByUsername: vi.fn(async () =>
        account({ failed_attempts: 5, locked_at: new Date('2026-07-10T23:40:00Z') })),
      applyAdminLoginFailure: vi.fn(async () => ({ failed_attempts: 1, locked_at: null })), // RPC restarted the round
    })
    expect(await loginAdmin({ username: 'alice', password: 'wrong-password!' }, r, NOW))
      .toEqual({ ok: false, reason: 'invalid' })
    expect(repo.applyAdminLoginFailure).toHaveBeenCalledWith({
      id: 'admin-1',
      nowIso: NOW.toISOString(),
      threshold: 5,
      lockMinutes: 15,
    })
  })

  it('wrong password reaching the threshold → locked', async () => {
    const { r } = run({
      getAdminAccountByUsername: vi.fn(async () => account({ failed_attempts: 4 })),
      applyAdminLoginFailure: vi.fn(async () => ({ failed_attempts: 5, locked_at: NOW })),
    })
    expect(await loginAdmin({ username: 'alice', password: 'wrong-password!' }, r, NOW))
      .toEqual({ ok: false, reason: 'locked' })
  })

  it('createAdminSession failure propagates (route → 500) and no token escapes', async () => {
    const { r } = run({
      getAdminAccountByUsername: vi.fn(async () => account()),
      createAdminSession: vi.fn(async () => { throw new Error('createAdminSession failed: boom') }),
    })
    await expect(loginAdmin({ username: 'alice', password: PASSWORD }, r, NOW))
      .rejects.toThrow(/createAdminSession failed/)
  })
})

describe('createAdminAccount', () => {
  it('normalizes the username, hashes the password (scrypt format), forwards displayName', async () => {
    const { repo, r } = run()
    expect(await createAdminAccount({ username: ' Alice ', password: 'a-long-password!', displayName: ' 王姐妹 ' }, r))
      .toEqual({ username: 'alice' })
    const arg = repo.insertAdminAccount.mock.calls[0][0]
    expect(arg.username).toBe('alice')
    expect(arg.passwordHash).toMatch(/^scrypt\$[0-9a-f]+\$[0-9a-f]+$/)
    expect(arg.passwordHash).not.toContain('a-long-password!')
    expect(arg.displayName).toBe('王姐妹')
  })

  it.each([
    ['too short', 'ab'],
    ['uppercase-only chars survive lowering but bad chars do not', 'has space'],
    ['too long', 'a'.repeat(33)],
  ])('refuses a bad username (%s)', async (_name, username) => {
    const { r } = run()
    await expect(createAdminAccount({ username, password: 'a-long-password!' }, r)).rejects.toThrow(/username/)
  })

  it('refuses a short password and an over-long display name; empty display name → null', async () => {
    const { repo, r } = run()
    await expect(createAdminAccount({ username: 'alice', password: 'short' }, r)).rejects.toThrow(/at least 12/)
    await expect(createAdminAccount({ username: 'alice', password: 'a-long-password!', displayName: '名'.repeat(81) }, r))
      .rejects.toThrow(/display name/)
    await createAdminAccount({ username: 'alice', password: 'a-long-password!', displayName: '   ' }, r)
    expect(repo.insertAdminAccount.mock.calls[0][0].displayName).toBeNull()
  })

  it('duplicate username → throws', async () => {
    const { r } = run({ insertAdminAccount: vi.fn(async () => ({ inserted: false })) })
    await expect(createAdminAccount({ username: 'alice', password: 'a-long-password!' }, r))
      .rejects.toThrow(/already exists/)
  })
})
