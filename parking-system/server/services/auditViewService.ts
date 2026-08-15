import { isAdminRole } from '@/lib/adminAccountInput'
import { ADMIN_ROLE_LABEL } from '@/lib/adminRoles'
import { fmtTaipeiDateTime } from '@/lib/taipeiDate'
import {
  auditActionLabel,
  renderAuditDetails,
  type AuditDetail,
} from '@/server/services/auditPresentation'
import {
  createParkingRepository,
  type AuditLogRow,
  type ParkingRepository,
} from '@/server/repositories/parkingRepository'

// ── Audit timeline read model (Wave 2A-2 / #15) ──────────────────────────────
// Turns raw audit rows into something a person can read, and is the ONLY place raw
// audit data is touched: the DTO below deliberately has no metadata field, so the
// page cannot reach metadata_redacted even by accident. That is a type-level
// guarantee, not a convention.
//
// Its reader is a 系統管理員, not a 幹事 (Wave 2C-1 / #19 closed /admin/audit to
// superadmins — the log carries every operator's governance actions).
//
// The log stores IDs and never names (0030). Names are resolved HERE, at display
// time, which is why a deleted actor is a normal outcome rather than an error —
// audit rows outlive the rows they point at, by design. Wave 2C-2 also appends the
// actor's role AS OF the action from actor_role_snapshot (see adminRoleSuffix).

const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100

export interface AuditViewItem {
  id: string
  occurredAt: string
  actorLabel: string
  actionLabel: string
  actionCode: string
  entityLabel: string
  result: 'success' | 'denied' | 'conflict'
  details: AuditDetail[]
  detailFallback: string | null
  unsupportedDetailCount: number
  requestId: string
}

// ── Cursor ───────────────────────────────────────────────────────────────────
// base64url(JSON) of {v, createdAt, id}. Opaque to the URL, but NOT a security
// boundary: nothing is authorized by it. It only sets a read offset into a
// timeline this admin can already read in full, so it is not signed — an HMAC
// here would imply a protection that isn't the point.
//
// `v` is near-free and means a later shape change (filters, a different sort) can
// treat old cursors as malformed and fall back to newest, instead of guessing at
// a payload generation.
interface AuditCursorV1 {
  v: 1
  createdAt: string
  id: string
}

const MAX_CURSOR_CHARS = 256
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// PostgREST timestamptz, microsecond precision, e.g. 2026-07-17T01:31:40.355854+00:00
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}:\d{2}|Z)$/

export function encodeAuditCursor(row: { created_at: string; id: string }): string {
  const payload: AuditCursorV1 = { v: 1, createdAt: row.created_at, id: row.id }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

// Malformed/forged/stale => null => newest page. One fixed behaviour, never a
// throw and never a 500: a garbled link should still show the timeline. Same
// spirit as parsePage answering 1 for junk input.
//
// Deliberately NO Date.parse here. It would "work", and that is the problem: it
// teaches the next maintainer that this value is safe to put through a Date, when
// created_at carries microseconds that Date silently truncates — after which the
// cursor's equality arm matches nothing and rows are skipped. The value is
// validated as a STRING and handed to the query as a string.
export function decodeAuditCursor(raw: string | undefined): AuditCursorV1 | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_CURSOR_CHARS) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null

  const { v, createdAt, id } = parsed as Record<string, unknown>
  if (v !== 1) return null
  if (typeof createdAt !== 'string' || !TS_RE.test(createdAt)) return null
  if (typeof id !== 'string' || !UUID_RE.test(id)) return null

  const cursor: AuditCursorV1 = { v: 1, createdAt, id }
  // Canonical round-trip: rejects payloads that decode but aren't what we emit
  // (extra keys, reordered fields, padding tricks).
  if (encodeAuditCursor({ created_at: createdAt, id }) !== raw) return null
  return cursor
}

// ── Labels ───────────────────────────────────────────────────────────────────

// Last 6 hex chars. Enough to tell rows apart far past this system's scale, and
// short enough to read aloud. One helper so actor/entity/request suffixes cannot
// drift apart.
export function idSuffix(id: string): string {
  return id.replaceAll('-', '').slice(-6)
}

// The actor's role AS OF the action (Wave 2C-2 / #19). Read straight off the row —
// actor_role_snapshot was resolved inside the transaction (0035), so this is what they
// WERE, not what they are now. null on rows written before 0035 (roles did not exist —
// an honest gap, not missing data); an unrecognized value shows raw, mirroring how an
// unknown action still shows its code, so a future role that forgets a label cannot
// vanish from the page.
function adminRoleSuffix(snapshot: string | null): string {
  if (snapshot === null) return '（角色制度建立前）'
  if (isAdminRole(snapshot)) return `（當時身分：${ADMIN_ROLE_LABEL[snapshot]}）`
  return `（當時身分：${snapshot}）`
}

function actorLabel(row: AuditLogRow, adminNames: Map<string, string>): string {
  switch (row.actor_type) {
    case 'admin': {
      if (!row.actor_id) return `管理員${adminRoleSuffix(row.actor_role_snapshot)}`
      const name = adminNames.get(row.actor_id)
      // Not an error path. Admin accounts are soft-disabled rather than deleted
      // precisely so this resolves — but the log must survive a hard delete too,
      // which is why actor_id carries no FK.
      const who = name ?? `已刪除管理員（ID 尾碼 ${idSuffix(row.actor_id)}）`
      return `${who}${adminRoleSuffix(row.actor_role_snapshot)}`
    }
    case 'staff_session':
      // NEVER a name, and never a lookup. The on-site PIN is a per-event credential
      // every device shares, so this identifies the session, not a person. Even if
      // some other table happened to hold this UUID, resolving it would invent an
      // accusation. The wording must not imply an individual either.
      return row.actor_id ? `現場同工 session（尾碼 ${idSuffix(row.actor_id)}）` : '現場同工 session'
    case 'member':
      // Name deliberately NOT resolved: that would put member PII on this page as a
      // side effect. #10 must extend this registry on purpose if it needs a masked
      // label. (See the entity note below.)
      return row.actor_id ? `會友（ID 尾碼 ${idSuffix(row.actor_id)}）` : '會友'
    case 'job':
      return row.actor_id ? `系統工作（ID 尾碼 ${idSuffix(row.actor_id)}）` : '系統工作'
    case 'system':
      return '系統'
  }
}

const ENTITY_TYPE_LABEL: Record<string, string> = {
  admin_account: '管理員帳號',
  audit: '稽核記錄',
  member_roster: '會友名冊', // #5B-a export rows; entity_id is null so this renders as the bare label
  // Tier 0-2 (0038). Both render as label + ID suffix, never as a name or a plate —
  // see the note below on why there is no generic entity-name resolver.
  member: '會友',
  vehicle: '車輛',
}

// 2A-2 resolves ONLY admin_account entities to a name. Everything else renders as
// type + ID suffix.
//
// There is deliberately no generic resolveEntityName(type, id): the moment such a
// thing exists, someone extends it to join `users` and member PII appears on this
// page as a default rather than a decision. When #10 needs a masked member label,
// it should have to add it here, on purpose.
function entityLabel(row: AuditLogRow, adminNames: Map<string, string>): string {
  const typeLabel = ENTITY_TYPE_LABEL[row.entity_type] ?? row.entity_type
  if (!row.entity_id) return typeLabel

  if (row.entity_type === 'admin_account') {
    const name = adminNames.get(row.entity_id)
    return name ?? `已刪除管理員（ID 尾碼 ${idSuffix(row.entity_id)}）`
  }
  return `${typeLabel}（ID 尾碼 ${idSuffix(row.entity_id)}）`
}

// Collects the ids this page needs, grouped by kind, and batch-fetches per kind —
// never per row. Only the admin group has a source today; the shape is what #10
// extends when member actors start appearing.
async function resolveAuditActors(
  rows: AuditLogRow[],
  repo: ParkingRepository,
): Promise<Map<string, string>> {
  const needsAdmin =
    rows.some(r => r.actor_type === 'admin' && r.actor_id) ||
    rows.some(r => r.entity_type === 'admin_account' && r.entity_id)
  if (!needsAdmin) return new Map()

  // Reuses the existing list method rather than adding a batch lookup: this
  // system has a handful of admins, so one unfiltered read beats an .in() query
  // and a new repo surface.
  const admins = await repo.listAdminAccounts()
  return new Map(admins.map(a => [a.id, a.display_name ?? a.username]))
}

export interface AuditTimelinePage {
  items: AuditViewItem[]
  nextCursor: string | null
}

export async function listAuditTimeline(
  params: { cursor?: string; limit?: number } = {},
  repo: ParkingRepository = createParkingRepository(),
): Promise<AuditTimelinePage> {
  const limit = Math.min(Math.max(Math.trunc(params.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT)
  const before = decodeAuditCursor(params.cursor) ?? undefined

  // limit + 1 is how "is there an older page?" is answered without a count query.
  // A total would be stale the moment it rendered, and a timeline needs 不漏/不重,
  // not 第 N／M 頁.
  const { rows } = await repo.listAuditLogs({
    limit: limit + 1,
    before: before ? { createdAt: before.createdAt, id: before.id } : undefined,
  })

  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const adminNames = await resolveAuditActors(page, repo)

  const items = page.map(row => {
    const rendered = renderAuditDetails(row.action, row.metadata_redacted)
    return {
      id: row.id,
      occurredAt: fmtTaipeiDateTime(row.created_at),
      actorLabel: actorLabel(row, adminNames),
      actionLabel: auditActionLabel(row.action),
      actionCode: row.action,
      entityLabel: entityLabel(row, adminNames),
      result: row.result,
      details: rendered.details,
      detailFallback: rendered.fallback,
      unsupportedDetailCount: rendered.unsupportedCount,
      requestId: row.request_id,
    }
  })

  const last = page.at(-1)
  return { items, nextCursor: hasMore && last ? encodeAuditCursor(last) : null }
}
