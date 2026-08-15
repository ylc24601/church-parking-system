import { adminUnauthorized, getAdminSession } from '@/server/http/adminAuth'
import { adminInternalError } from '@/server/http/adminRequestGuard'
import { csvUploadPreflight, readCsvBody } from '@/server/http/csvUpload'
import { csvDigestHex, issueImportConfirmToken } from '@/server/http/importConfirmToken'
import { importMembersFromCsvText } from '@/server/services/memberImportService'
import { CsvImportError, MAX_CSV_BYTES } from '@/lib/memberImport'

// Dry-run the uploaded member CSV and return the report + a confirmation token that
// binds this exact file to the operator. Writes nothing. The CSV, report, and token
// are never logged. Authenticate BEFORE reading the body so an unauthenticated request
// can't make us buffer/decode up to the cap.
const NO_STORE = { 'cache-control': 'no-store' }

export async function POST(request: Request): Promise<Response> {
  const preflight = csvUploadPreflight(request, MAX_CSV_BYTES)
  if (!preflight.ok) return preflight.response

  const session = await getAdminSession()
  if (!session) return adminUnauthorized()

  const upload = await readCsvBody(request, MAX_CSV_BYTES)
  if (!upload.ok) return upload.response

  let report
  try {
    report = await importMembersFromCsvText({ csvText: upload.text, dryRun: true })
  } catch (e) {
    if (e instanceof CsvImportError) {
      return Response.json({ ok: false, reason: e.code }, { status: 400, headers: NO_STORE })
    }
    console.error('member import preview error')
    void e
    return adminInternalError()
  }

  const confirmationToken = issueImportConfirmToken({
    csvDigest: csvDigestHex(upload.bytes),
    adminId: session.adminId,
  })
  return Response.json({ ok: true, report, confirmationToken }, { headers: NO_STORE })
}
