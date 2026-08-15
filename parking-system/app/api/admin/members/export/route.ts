import { can } from '@/lib/adminRoles'
import { adminForbidden, adminUnauthorized, getAdminSession } from '@/server/http/adminAuth'
import { adminInternalError, guardAdminOrigin } from '@/server/http/adminRequestGuard'
import { adminActor, newRequestId } from '@/server/services/auditContext'
import { exportMembersCsv } from '@/server/services/memberExportService'

// Bulk-PII roster CSV export (Wave 3 3d / #5B-a). Superadmin-only, audited. A body-less POST
// on purpose — never GET: a GET could be prefetched by <Link> or a crawler and would silently
// trigger an export + audit row. guardAdminOrigin gives it the same CSRF protection as logout;
// the CSV response is no-store (full PII must never be cached anywhere). The route's can() is
// the first gate and UX; the service's DB reauth (0037) is authoritative — a mid-request demote
// comes back as a typed forbidden and becomes a 403 here, with no CSV.

export async function POST(request: Request): Promise<Response> {
  const originRefusal = guardAdminOrigin(request)
  if (originRefusal) return originRefusal
  const session = await getAdminSession()
  if (!session) return adminUnauthorized()
  if (!can(session.role, 'export_members')) return adminForbidden()

  let result
  try {
    result = await exportMembersCsv({
      role: session.role,
      actor: adminActor(session),
      requestId: newRequestId(),
      now: new Date(),
    })
  } catch (e) {
    // No PII, no error message — the roster and any exception detail must never reach a log.
    console.error('member roster export error')
    void e
    return adminInternalError()
  }

  if (!result.ok) return adminForbidden()

  return new Response(result.csv, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${result.filename}"`,
      'cache-control': 'no-store',
    },
  })
}
