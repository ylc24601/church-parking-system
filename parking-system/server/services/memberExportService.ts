import { can, type AdminRole } from '@/lib/adminRoles'
import { ROLE_LABEL } from '@/lib/memberAdminTypes'
import { toSpreadsheetCsv } from '@/lib/csv'
import { taipeiToday } from '@/lib/taipeiDate'
import { requireAdminActor, type AuditActor } from '@/server/services/auditContext'
import {
  createParkingRepository,
  type MemberExportRow,
  type ParkingRepository,
} from '@/server/repositories/parkingRepository'

// Roster CSV export (Wave 3 3d / #5B-a). Superadmin-only, audited bulk-PII egress.
//
// This is a HUMAN-READABLE admin roster for offline reference / contact — NOT a re-import
// format: roles are Chinese labels (import wants a P1/P2/P3 priority code), plates are joined
// into one cell (import is one vehicle per row), P2 reason / dependents / birthdates are
// omitted, and spreadsheet-injection neutralization mutates dangerous cells. Do not feed it
// back to the importer.
//
// ORDER MATTERS (the audit boundary): read the whole roster via a keyset pager fixed at
// exportStartedAt → serialize the CSV COMPLETELY → only THEN log + DB-reauthorise (0037: is
// the actor STILL an active superadmin?) → return. So a serialization failure can never leave
// a false 'success' audit row, and no CSV is returned unless the audit row committed. The audit
// records "the system authorised and generated a roster export response", not "the user saved a
// file" (unknowable server-side).

const PAGE_SIZE = 200
const HEADERS = ['姓名', '電話', '車牌', '角色', 'LINE綁定']

export type MemberExportResult =
  | { ok: true; csv: string; filename: string; rowCount: number }
  | { ok: false; reason: 'forbidden' }

// Phones are stored canonical (`^09[0-9]{8}$`), i.e. a leading-zero all-digit string.
// Excel, on double-clicking a CSV, coerces numeric text to a number and DROPS the leading
// zero (0912345678 → 912345678) — so every single phone would be corrupted for the exact
// reader (行政同工) this file is for. Since this is a human-readable, non-round-trip export,
// format to 0912-345-678: the dashes make Excel keep it as text and it reads more clearly.
// A non-canonical value (shouldn't exist given the DB constraint) falls through unchanged.
export function formatPhoneForExport(phone: string | null): string {
  if (!phone) return ''
  return phone.replace(/^(\d{4})(\d{3})(\d{3})$/, '$1-$2-$3')
}

function toCsvRow(m: MemberExportRow): string[] {
  return [
    m.display_name,
    formatPhoneForExport(m.phone_number),
    m.plates.join('；'), // active plates only (repo), joined into one cell — NOT a re-import shape
    ROLE_LABEL[m.role] ?? m.role,
    m.line_id !== null ? '是' : '否', // derived flag, never the raw line_id
  ]
}

export async function exportMembersCsv(
  params: { role: AdminRole; actor: AuditActor; requestId: string; now: Date },
  repo: ParkingRepository = createParkingRepository(),
): Promise<MemberExportResult> {
  // App-side defense in depth. The route's can() is the first gate; the DB reauth below is
  // authoritative. Authorisation refusal is a TYPED result, never an exception → route 403.
  if (!can(params.role, 'export_members')) return { ok: false, reason: 'forbidden' }
  // Don't trust the AuditActor plain object at this bulk-PII boundary: require an admin actor
  // with a session (throws on anything else — a threading bug, not a 403). Returns narrowed ids.
  const { adminId, sessionId } = requireAdminActor(params.actor)

  // Cutoff on the DB clock (not the app host's), the same clock users.created_at is set by.
  // It fixes a stable upper bound so keyset pages don't chase a moving tail — NOT a strict
  // transaction snapshot (the pages are separate statements).
  const createdBefore = await repo.getDbNow()

  // Keyset page to completion. The cursor is the RAW created_at string from the DB — never
  // round-tripped through Date, which truncates microseconds and would break sub-millisecond
  // timestamp ties (a bulk import gives many rows the same statement now()).
  const all: MemberExportRow[] = []
  let afterCreatedAt: string | null = null
  let afterId: string | null = null
  for (;;) {
    const page = await repo.listMembersForExportPage({ createdBefore, afterCreatedAt, afterId, limit: PAGE_SIZE })
    all.push(...page)
    if (page.length < PAGE_SIZE) break
    const last = page[page.length - 1]
    afterCreatedAt = last.created_at
    afterId = last.id
  }

  // Human-readable order for the file (the keyset read was in created_at order).
  all.sort((a, b) => a.display_name.localeCompare(b.display_name, 'zh-Hant') || a.id.localeCompare(b.id))

  // Serialize BEFORE auditing so a formatter failure never leaves a false success row.
  const csv = toSpreadsheetCsv(HEADERS, all.map(toCsvRow))

  // DB-authoritative reauth + audit (0037). ok:false = demoted/disabled mid-request → forbidden.
  const logged = await repo.logMemberRosterExport({
    actingAdminId: adminId,
    actingSessionId: sessionId,
    requestId: params.requestId,
    rowCount: all.length,
  })
  if (!logged.ok) return { ok: false, reason: 'forbidden' }

  const filename = `members-${taipeiToday(params.now).replace(/-/g, '')}.csv`
  return { ok: true, csv, filename, rowCount: all.length }
}
