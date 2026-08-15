import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateSessionToken, hashSessionToken } from '@/server/http/sessionToken'

const { cookieGet, cookieDelete, deleteAdminSessionByTokenHash } = vi.hoisted(() => ({
  cookieGet: vi.fn(),
  cookieDelete: vi.fn(),
  deleteAdminSessionByTokenHash: vi.fn(),
}))

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ get: cookieGet, set: vi.fn(), delete: cookieDelete })),
}))
vi.mock('@/server/repositories/parkingRepository', () => ({
  createParkingRepository: vi.fn(() => ({ deleteAdminSessionByTokenHash })),
}))

import { POST } from '@/app/api/admin/logout/route'

const TOKEN = generateSessionToken()
const post = (headers: Record<string, string> = {}) =>
  POST(new Request('http://localhost/api/admin/logout', { method: 'POST', headers }))

describe('POST /api/admin/logout', () => {
  beforeEach(() => vi.clearAllMocks())

  it('deletes this device\'s session row (by token hash) and clears the cookie', async () => {
    cookieGet.mockReturnValue({ value: TOKEN })
    const res = await post()
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(deleteAdminSessionByTokenHash).toHaveBeenCalledWith(hashSessionToken(TOKEN))
    expect(cookieDelete).toHaveBeenCalledWith('admin_session')
  })

  it('no cookie → still 200, nothing to delete', async () => {
    cookieGet.mockReturnValue(undefined)
    const res = await post()
    expect(res.status).toBe(200)
    expect(deleteAdminSessionByTokenHash).not.toHaveBeenCalled()
    expect(cookieDelete).toHaveBeenCalled()
  })

  it('DB delete failure → cookie is STILL cleared and the response stays 200', async () => {
    cookieGet.mockReturnValue({ value: TOKEN })
    deleteAdminSessionByTokenHash.mockRejectedValue(new Error('boom'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await post()
    expect(res.status).toBe(200)
    expect(cookieDelete).toHaveBeenCalledWith('admin_session')
    spy.mockRestore()
  })

  it('foreign Origin → 403, no logout side effects', async () => {
    cookieGet.mockReturnValue({ value: TOKEN })
    const res = await post({ origin: 'https://evil.example' })
    expect(res.status).toBe(403)
    expect(deleteAdminSessionByTokenHash).not.toHaveBeenCalled()
    expect(cookieDelete).not.toHaveBeenCalled()
  })
})
