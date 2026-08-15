import { beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

// Mock only the service function; keep CsvImportError / CsvImportExecutionError real so
// the routes' `instanceof` checks work. csvUpload + importConfirmToken stay REAL, so
// these tests exercise the true upload cap + token binding.
vi.mock('@/server/services/memberImportService', async importOriginal => {
  const actual = await importOriginal<typeof import('@/server/services/memberImportService')>()
  return { ...actual, importMembersFromCsvText: vi.fn() }
})
vi.mock('@/server/http/adminAuth', async importOriginal => {
  const actual = await importOriginal<typeof import('@/server/http/adminAuth')>()
  return { ...actual, getAdminSession: vi.fn() }
})
// Wrap the REAL upload helpers in spies so we can assert call ORDER (auth before the
// body is read) while keeping their real behaviour (bounded read + token still work).
vi.mock('@/server/http/csvUpload', async importOriginal => {
  const actual = await importOriginal<typeof import('@/server/http/csvUpload')>()
  return { ...actual, readCsvBody: vi.fn(actual.readCsvBody), csvUploadPreflight: vi.fn(actual.csvUploadPreflight) }
})

import { POST as previewPOST } from '@/app/api/admin/members/import/preview/route'
import { POST as applyPOST } from '@/app/api/admin/members/import/apply/route'
import { CsvImportExecutionError, importMembersFromCsvText, type ImportReport } from '@/server/services/memberImportService'
import { CsvImportError } from '@/lib/memberImport'
import { getAdminSession } from '@/server/http/adminAuth'
import { readCsvBody } from '@/server/http/csvUpload'
import { csvDigestHex, issueImportConfirmToken } from '@/server/http/importConfirmToken'

const SESSION = { sessionId: 's1', adminId: 'admin-1', username: 'alice' }
const CSV = 'applicant_name,mobile_phone,license_plate,reason_type\n王,0912345678,ABC-1234,1\n'

const emptyReport = (dryRun: boolean): ImportReport => ({
  dryRun, rows: 1, members: 1, imported: 1, updated: 0, vehiclesAdded: 1, dependentsAdded: 0,
  phoneNameConflicts: [], identityConflicts: [], plateConflicts: [], batchPlateConflicts: [],
  groupConflicts: [],
  reviewRequired: [], p2Retained: [], revokedRetained: [], governedRetained: [], validationErrors: [],
  truncated: false,
  totals: {
    phoneNameConflicts: 0, identityConflicts: 0, plateConflicts: 0, batchPlateConflicts: 0,
    groupConflicts: 0,
    reviewRequired: 0, p2Retained: 0, revokedRetained: 0, governedRetained: 0, validationErrors: 0,
  },
})

const post = (
  handler: typeof previewPOST,
  path: string,
  body: BodyInit,
  headers: Record<string, string> = {},
) => handler(new Request(`http://localhost/api/admin/members/import/${path}`, {
  method: 'POST',
  headers: { 'content-type': 'text/csv', ...headers },
  body,
}))

const tokenFor = (csv: string, adminId = SESSION.adminId) =>
  issueImportConfirmToken({ csvDigest: csvDigestHex(new TextEncoder().encode(csv)), adminId })

beforeAll(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-role-key-for-hmac'
})

describe('POST /import/preview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getAdminSession as Mock).mockResolvedValue(SESSION)
    ;(importMembersFromCsvText as Mock).mockResolvedValue(emptyReport(true))
  })

  it('no session → 401, service never called', async () => {
    ;(getAdminSession as Mock).mockResolvedValue(null)
    const res = await post(previewPOST, 'preview', CSV)
    expect(res.status).toBe(401)
    expect(importMembersFromCsvText).not.toHaveBeenCalled()
  })

  it('non-csv content-type → 415', async () => {
    const res = await post(previewPOST, 'preview', CSV, { 'content-type': 'application/json' })
    expect(res.status).toBe(415)
  })

  it('dry-runs and returns report + a confirmation token; neither is logged', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await post(previewPOST, 'preview', CSV)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.confirmationToken).toBeTruthy()
    expect(importMembersFromCsvText).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }))
    for (const c of spy.mock.calls) expect(JSON.stringify(c)).not.toContain(body.confirmationToken)
    spy.mockRestore()
  })

  it('a structural CsvImportError → 400 with its code', async () => {
    ;(importMembersFromCsvText as Mock).mockRejectedValue(new CsvImportError('missing_headers'))
    const res = await post(previewPOST, 'preview', CSV)
    expect(res.status).toBe(400)
    expect((await res.json()).reason).toBe('missing_headers')
  })
})

describe('POST /import/apply', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getAdminSession as Mock).mockResolvedValue(SESSION)
    ;(importMembersFromCsvText as Mock).mockResolvedValue(emptyReport(false))
  })

  it('no session → 401', async () => {
    ;(getAdminSession as Mock).mockResolvedValue(null)
    expect((await post(applyPOST, 'apply', CSV, { 'x-import-confirmation': tokenFor(CSV) })).status).toBe(401)
  })

  it('missing token → 403 bad_confirmation, service never called', async () => {
    const res = await post(applyPOST, 'apply', CSV)
    expect(res.status).toBe(403)
    expect((await res.json()).reason).toBe('bad_confirmation')
    expect(importMembersFromCsvText).not.toHaveBeenCalled()
  })

  it('token bound to a DIFFERENT csv → 409 preview_mismatch', async () => {
    const res = await post(applyPOST, 'apply', CSV, { 'x-import-confirmation': tokenFor('other content') })
    expect(res.status).toBe(409)
    expect((await res.json()).reason).toBe('preview_mismatch')
    expect(importMembersFromCsvText).not.toHaveBeenCalled()
  })

  it('token for another admin → 403 bad_confirmation', async () => {
    const res = await post(applyPOST, 'apply', CSV, { 'x-import-confirmation': tokenFor(CSV, 'admin-2') })
    expect(res.status).toBe(403)
    expect((await res.json()).reason).toBe('bad_confirmation')
  })

  it('valid token → 200 applied report (dryRun false)', async () => {
    const res = await post(applyPOST, 'apply', CSV, { 'x-import-confirmation': tokenFor(CSV) })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect((await res.json()).ok).toBe(true)
    expect(importMembersFromCsvText).toHaveBeenCalledWith(expect.objectContaining({ dryRun: false }))
  })

  it('partial failure → 409 partial_apply + processedMembers, no raw error leaked', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    ;(importMembersFromCsvText as Mock).mockRejectedValue(new CsvImportExecutionError(2, emptyReport(false)))
    const res = await post(applyPOST, 'apply', CSV, { 'x-import-confirmation': tokenFor(CSV) })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body).toMatchObject({ ok: false, reason: 'partial_apply', processedMembers: 2 })
    expect(body.report).toBeTruthy()
    expect(JSON.stringify(body)).not.toMatch(/stack|Error:/)
    spy.mockRestore()
  })

  it('an unexpected throw → 500 generic', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    ;(importMembersFromCsvText as Mock).mockRejectedValue(new Error('boom'))
    const res = await post(applyPOST, 'apply', CSV, { 'x-import-confirmation': tokenFor(CSV) })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ ok: false, error: 'internal' })
    spy.mockRestore()
  })
})

describe('auth runs before the body is read', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(importMembersFromCsvText as Mock).mockResolvedValue(emptyReport(true))
  })

  it('preview: no session → 401 and readCsvBody is never called', async () => {
    ;(getAdminSession as Mock).mockResolvedValue(null)
    const res = await post(previewPOST, 'preview', CSV)
    expect(res.status).toBe(401)
    expect(readCsvBody).not.toHaveBeenCalled()
    expect(importMembersFromCsvText).not.toHaveBeenCalled()
  })

  it('apply: no session → 401 and readCsvBody is never called', async () => {
    ;(getAdminSession as Mock).mockResolvedValue(null)
    const res = await post(applyPOST, 'apply', CSV, { 'x-import-confirmation': tokenFor(CSV) })
    expect(res.status).toBe(401)
    expect(readCsvBody).not.toHaveBeenCalled()
  })

  it('foreign Origin → 403 before session AND before the body is read', async () => {
    ;(getAdminSession as Mock).mockResolvedValue(SESSION)
    const res = await post(previewPOST, 'preview', CSV, { origin: 'https://evil.example' })
    expect(res.status).toBe(403)
    expect(getAdminSession).not.toHaveBeenCalled()
    expect(readCsvBody).not.toHaveBeenCalled()
  })

  it('logged in → readCsvBody IS called', async () => {
    ;(getAdminSession as Mock).mockResolvedValue(SESSION)
    const res = await post(previewPOST, 'preview', CSV)
    expect(res.status).toBe(200)
    expect(readCsvBody).toHaveBeenCalledTimes(1)
  })
})
