import { adminUnauthorized, getAdminSession } from '@/server/http/adminAuth'
import { adminInternalError } from '@/server/http/adminRequestGuard'
import { csvUploadPreflight, readCsvBody } from '@/server/http/csvUpload'
import { csvDigestHex, verifyImportConfirmToken } from '@/server/http/importConfirmToken'
import { CsvImportExecutionError, importMembersFromCsvText } from '@/server/services/memberImportService'
import { CsvImportError, MAX_CSV_BYTES } from '@/lib/memberImport'

// Write the uploaded member CSV, but only after verifying the confirmation token
// issued at preview binds THIS exact file to THIS admin (and hasn't expired). The
// per-member RPC is atomic; the whole CSV is not one transaction, so a mid-run
// failure surfaces as a typed partial_apply (some members already written) rather
// than a generic 500. The CSV, report, and token are never logged. Authenticate BEFORE
// reading the body so an unauthenticated request can't make us buffer/decode up to the cap.
const NO_STORE = { 'cache-control': 'no-store' }

export async function POST(request: Request): Promise<Response> {
  const preflight = csvUploadPreflight(request, MAX_CSV_BYTES)
  if (!preflight.ok) return preflight.response

  const session = await getAdminSession()
  if (!session) return adminUnauthorized()

  const upload = await readCsvBody(request, MAX_CSV_BYTES)
  if (!upload.ok) return upload.response

  const verdict = verifyImportConfirmToken(request.headers.get('x-import-confirmation'), {
    csvDigest: csvDigestHex(upload.bytes),
    adminId: session.adminId,
  })
  if (!verdict.ok) {
    // digest/expiry mismatches are recoverable (re-preview) → 409; a bad or foreign
    // token is a refusal → 403.
    if (verdict.reason === 'digest_mismatch') {
      return Response.json({ ok: false, reason: 'preview_mismatch' }, { status: 409, headers: NO_STORE })
    }
    if (verdict.reason === 'expired') {
      return Response.json({ ok: false, reason: 'preview_expired' }, { status: 409, headers: NO_STORE })
    }
    return Response.json({ ok: false, reason: 'bad_confirmation' }, { status: 403, headers: NO_STORE })
  }

  let report
  try {
    report = await importMembersFromCsvText({ csvText: upload.text, dryRun: false })
  } catch (e) {
    if (e instanceof CsvImportExecutionError) {
      // Partial write already happened — report it plainly (no raw DB error).
      return Response.json(
        { ok: false, reason: 'partial_apply', processedMembers: e.processedMembers, report: e.report },
        { status: 409, headers: NO_STORE },
      )
    }
    if (e instanceof CsvImportError) {
      return Response.json({ ok: false, reason: e.code }, { status: 400, headers: NO_STORE })
    }
    console.error('member import apply error')
    void e
    return adminInternalError()
  }

  return Response.json({ ok: true, report }, { headers: NO_STORE })
}
