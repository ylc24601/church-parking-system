import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

vi.mock('@/server/services/memberExportService', () => ({ exportMembersCsv: vi.fn() }))
vi.mock('@/server/http/adminAuth', async importOriginal => {
  const actual = await importOriginal<typeof import('@/server/http/adminAuth')>()
  return { ...actual, getAdminSession: vi.fn() }
})

import { POST } from '@/app/api/admin/members/export/route'
import { exportMembersCsv } from '@/server/services/memberExportService'
import { getAdminSession } from '@/server/http/adminAuth'

const SESSION = { sessionId: 's1', adminId: 'admin-1', username: 'alice', role: 'superadmin' as const }
const CLERK = { ...SESSION, role: 'clerk' as const }

const post = (headers: Record<string, string> = {}) =>
  POST(new Request('http://localhost/api/admin/members/export', { method: 'POST', headers }))

describe('POST /api/admin/members/export', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getAdminSession as Mock).mockResolvedValue(SESSION)
    // Body passthrough only (BOM correctness is covered by the csv/service tests; note
    // Response.text() strips a leading BOM on decode even when the bytes carry it).
    ;(exportMembersCsv as Mock).mockResolvedValue({
      ok: true, csv: '姓名,電話\r\n王小明,0912345678\r\n', filename: 'members-20260726.csv', rowCount: 3,
    })
  })

  it('no session → 401, roster export never invoked', async () => {
    ;(getAdminSession as Mock).mockResolvedValue(null)
    const res = await post()
    expect(res.status).toBe(401)
    expect(exportMembersCsv).not.toHaveBeenCalled()
  })

  it('clerk → 403, roster export never invoked (roster never read)', async () => {
    ;(getAdminSession as Mock).mockResolvedValue(CLERK)
    const res = await post()
    expect(res.status).toBe(403)
    expect(exportMembersCsv).not.toHaveBeenCalled()
  })

  it('foreign Origin → 403, roster export never invoked', async () => {
    const res = await post({ origin: 'https://evil.example' })
    expect(res.status).toBe(403)
    expect(exportMembersCsv).not.toHaveBeenCalled()
  })

  it('superadmin → 200 CSV attachment with no-store', async () => {
    const res = await post()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8')
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="members-20260726.csv"')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.text()).toBe('姓名,電話\r\n王小明,0912345678\r\n')
  })

  it('service typed forbidden (demoted mid-request) → 403, not a CSV', async () => {
    ;(exportMembersCsv as Mock).mockResolvedValue({ ok: false, reason: 'forbidden' })
    const res = await post()
    expect(res.status).toBe(403)
    expect(res.headers.get('content-type') ?? '').not.toContain('text/csv')
  })

  it('service throws → generic 500 with no PII / message in the body', async () => {
    ;(exportMembersCsv as Mock).mockRejectedValue(new Error('boom 0912345678'))
    const res = await post()
    expect(res.status).toBe(500)
    const body = await res.text()
    expect(body).not.toContain('0912345678')
    expect(body).not.toContain('boom')
  })
})
