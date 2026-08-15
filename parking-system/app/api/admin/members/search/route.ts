import { adminUnauthorized, getAdminSession } from '@/server/http/adminAuth'
import { adminInternalError, guardAdminPost } from '@/server/http/adminRequestGuard'
import { searchMembers } from '@/server/services/memberAdminService'

// Admin member search. POST (not GET) so the query — which carries PII (name/phone/
// plate) — never lands in a URL or access log. The query is never logged here, and
// the response phone is masked.
const NO_STORE = { 'cache-control': 'no-store' }
const MAX_QUERY_LEN = 50

export async function POST(request: Request): Promise<Response> {
  const guard = await guardAdminPost(request)
  if (!guard.ok) return guard.response
  if (!(await getAdminSession())) return adminUnauthorized()

  const { query } = (guard.body ?? {}) as { query?: unknown }
  if (typeof query !== 'string') {
    return Response.json({ ok: false, reason: 'invalid_request' }, { status: 400, headers: NO_STORE })
  }
  const trimmed = query.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_QUERY_LEN) {
    return Response.json({ ok: false, reason: 'invalid_request' }, { status: 400, headers: NO_STORE })
  }

  try {
    const { items, hasMore } = await searchMembers({ query: trimmed })
    return Response.json({ ok: true, items, hasMore }, { headers: NO_STORE })
  } catch (e) {
    // Never echo the query (it holds PII) into the log.
    console.error('admin member search error')
    void e
    return adminInternalError()
  }
}
