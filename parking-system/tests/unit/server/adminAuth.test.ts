import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateSessionToken, hashSessionToken } from '@/server/http/sessionToken'

// getAdminSession reads the cookie token, hashes it, and confirms a live
// admin_sessions row — and REVOKES (deletes) the row when it is expired or the
// account is disabled. Mock next/headers + the repo.
const { cookieGet, cookieSet, cookieDelete, getAdminSessionByTokenHash, deleteAdminSessionByTokenHash } =
  vi.hoisted(() => ({
    cookieGet: vi.fn(),
    cookieSet: vi.fn(),
    cookieDelete: vi.fn(),
    getAdminSessionByTokenHash: vi.fn(),
    deleteAdminSessionByTokenHash: vi.fn(),
  }))

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ get: cookieGet, set: cookieSet, delete: cookieDelete })),
}))
vi.mock('@/server/repositories/parkingRepository', () => ({
  createParkingRepository: vi.fn(() => ({ getAdminSessionByTokenHash, deleteAdminSessionByTokenHash })),
}))

import { clearAdminSession, getAdminSession, setAdminSession } from '@/server/http/adminAuth'

const TOKEN = generateSessionToken()

function sessionRow(over: Record<string, unknown> = {}) {
  return {
    id: 's1',
    admin_id: 'admin-1',
    expires_at: new Date(Date.now() + 3600_000),
    username: 'alice',
    account_disabled_at: null,
    role: 'superadmin',
    ...over,
  }
}

describe('getAdminSession', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns null when there is no cookie', async () => {
    cookieGet.mockReturnValue(undefined)
    expect(await getAdminSession()).toBeNull()
    expect(getAdminSessionByTokenHash).not.toHaveBeenCalled()
  })

  it('a malformed cookie value never reaches the DB', async () => {
    for (const bad of ['short', 'x'.repeat(44), 'has space padding to 43 chars aaaaaaaaaaaa', `${TOKEN}!`]) {
      cookieGet.mockReturnValue({ value: bad })
      expect(await getAdminSession()).toBeNull()
    }
    expect(getAdminSessionByTokenHash).not.toHaveBeenCalled()
  })

  it('looks up by sha256 of the cookie token — never the raw token', async () => {
    cookieGet.mockReturnValue({ value: TOKEN })
    getAdminSessionByTokenHash.mockResolvedValue(sessionRow())
    expect(await getAdminSession()).toEqual({
      sessionId: 's1', adminId: 'admin-1', username: 'alice', role: 'superadmin',
    })
    expect(getAdminSessionByTokenHash).toHaveBeenCalledWith(hashSessionToken(TOKEN))
  })

  it('unknown token → null (nothing to revoke)', async () => {
    cookieGet.mockReturnValue({ value: TOKEN })
    getAdminSessionByTokenHash.mockResolvedValue(null)
    expect(await getAdminSession()).toBeNull()
    expect(deleteAdminSessionByTokenHash).not.toHaveBeenCalled()
  })

  it('expired session → the row is DELETED, then null', async () => {
    cookieGet.mockReturnValue({ value: TOKEN })
    getAdminSessionByTokenHash.mockResolvedValue(sessionRow({ expires_at: new Date(Date.now() - 1000) }))
    expect(await getAdminSession()).toBeNull()
    expect(deleteAdminSessionByTokenHash).toHaveBeenCalledWith(hashSessionToken(TOKEN))
  })

  it('disabled account → this session row is DELETED, then null (disable kills live sessions)', async () => {
    cookieGet.mockReturnValue({ value: TOKEN })
    getAdminSessionByTokenHash.mockResolvedValue(sessionRow({ account_disabled_at: new Date() }))
    expect(await getAdminSession()).toBeNull()
    expect(deleteAdminSessionByTokenHash).toHaveBeenCalledWith(hashSessionToken(TOKEN))
  })
})

describe('setAdminSession / clearAdminSession', () => {
  beforeEach(() => vi.clearAllMocks())

  it('sets the hardened cookie: httpOnly, lax, path=/, 12h maxAge, secure in production', async () => {
    await setAdminSession(TOKEN)
    expect(cookieSet).toHaveBeenCalledWith('admin_session', TOKEN, {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,          // NODE_ENV=test
      path: '/',
      maxAge: 12 * 3600,      // ADMIN_SESSION_TTL_HOURS
    })
  })

  it('clear deletes the cookie', async () => {
    await clearAdminSession()
    expect(cookieDelete).toHaveBeenCalledWith('admin_session')
  })
})

// ── Wave 2C-1 (#19) ────────────────────────────────────────────────────────────
describe('getAdminSession carries the role', () => {
  beforeEach(() => vi.clearAllMocks())

  it.each(['superadmin', 'clerk'] as const)('surfaces %s from the joined account row', async role => {
    cookieGet.mockReturnValue({ value: TOKEN })
    getAdminSessionByTokenHash.mockResolvedValue(sessionRow({ role }))
    // Read from the SAME row that already carries disabled_at, so it costs no extra
    // query and is re-read on every request — a demotion bites immediately rather than
    // at the next login. Nothing role-related is ever read from the cookie.
    expect(await getAdminSession()).toEqual({
      sessionId: 's1', adminId: 'admin-1', username: 'alice', role,
    })
    expect(getAdminSessionByTokenHash).toHaveBeenCalledWith(hashSessionToken(TOKEN))
  })
})
