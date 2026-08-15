import { maskPhone } from '@/lib/binding'
import type { MemberSearchItem } from '@/lib/memberAdminTypes'
import { issueBindingCode } from '@/server/services/bindingAdminService'
import { createParkingRepository, type ParkingRepository } from '@/server/repositories/parkingRepository'

// ── Admin member management (Phase 8 Slice 2) ────────────────────────────────
// Search (masked list) + full detail (session-gated page only) + issue a binding
// code for an unbound member. The search query carries PII (name/phone/plate) and
// is never logged; the route uses POST so it never lands in a URL/access log.

const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100
// Per-branch fetch cap. Each ilike branch pulls at most this many candidate ids
// BEFORE the merge/distinct + slice(limit+1), so a broad match can never drag the
// whole table into memory, and hasMore stays correct after the merge.
const CANDIDATE_CAP = 250

// Minimum cleaned length per branch. Below these, the branch is skipped entirely —
// this is what prevents an empty cleaned value from becoming `ilike '%%'` (whole table).
const MIN_NAME = 1
const MIN_PHONE_DIGITS = 3
const MIN_PLATE_ALNUM = 2

// Defined in lib/memberAdminTypes (client-safe) so the UI never imports this module — which
// reaches lib/supabase/server and its service-role client. Re-exported so existing importers of
// '@/server/services/memberAdminService' keep working.
export type { MemberSearchItem } from '@/lib/memberAdminTypes'

export async function searchMembers(
  params: { query: string; limit?: number },
  repo: ParkingRepository = createParkingRepository(),
): Promise<{ items: MemberSearchItem[]; hasMore: boolean }> {
  const limit = Math.min(Math.max(Math.trunc(params.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT)

  const raw = typeof params.query === 'string' ? params.query : ''
  // Strip LIKE wildcards: `.ilike()` parameterizes the value against filter-syntax
  // injection, but %/_ would still be interpreted as wildcards → strip them so a
  // query of "%" or "_" cannot match every row.
  const sanitized = raw.replace(/[%_]/g, '')

  // Name branch only fires when the query holds at least one letter or number (any
  // script, incl. CJK). Pure punctuation / symbols / emoji don't identify a member and
  // must not reach the DB — a lone `ilike '%!!!%'` isn't whole-table, but it's wasted work.
  const nameClean = sanitized.trim()
  const nameQuery =
    [...nameClean].length >= MIN_NAME && /[\p{L}\p{N}]/u.test(nameClean) ? nameClean : null

  const phoneDigits = sanitized.replace(/\D/g, '')
  const phoneQuery = phoneDigits.length >= MIN_PHONE_DIGITS ? phoneDigits : null

  const plateAlnum = sanitized.toUpperCase().replace(/[^A-Z0-9]/g, '')
  const plateQuery = plateAlnum.length >= MIN_PLATE_ALNUM ? plateAlnum : null

  // Every branch empty (e.g. punctuation/emoji only, or too short) → no DB hit.
  if (nameQuery === null && phoneQuery === null && plateQuery === null) {
    return { items: [], hasMore: false }
  }

  const rows = await repo.searchMembers({ nameQuery, phoneQuery, plateQuery, candidateCap: CANDIDATE_CAP })
  const hasMore = rows.length > limit
  const items = rows.slice(0, limit).map(r => ({
    id: r.id,
    displayName: r.display_name,
    phoneMasked: r.phone_number === null ? '—' : maskPhone(r.phone_number),
    plateSummary: summarizePlates(r.plates),
    role: r.role,
    bound: r.line_id !== null,
  }))
  return { items, hasMore }
}

// Wave 1c (#5A) — browse the whole roster, no query. Same masked item shape as search, so the two
// lists can never disagree about what an admin may see.
//
// `page` is driven by a public query param, so it is validated here too rather than trusted from
// the caller: a non-safe integer would produce a fractional/overflowing offset and a broken range.
// Out-of-range pages are NOT rewritten here — the page component redirects to the canonical last
// page, which keeps this a single repository call and keeps that behaviour visible/testable.
export async function listMembersPage(
  params: { page?: number; limit?: number } = {},
  repo: ParkingRepository = createParkingRepository(),
): Promise<{ items: MemberSearchItem[]; page: number; totalPages: number; total: number }> {
  const limit = Math.min(Math.max(Math.trunc(params.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT)
  const requested =
    Number.isSafeInteger(params.page) && (params.page as number) >= 1 ? (params.page as number) : 1

  // `requested` is a safe integer, but (requested - 1) * limit can still leave the safe range.
  // Fall back to page 1 as a PAIR — returning page N with page-1's rows would be a lie.
  const rawOffset = (requested - 1) * limit
  const usable = Number.isSafeInteger(rawOffset)
  const page = usable ? requested : 1
  const offset = usable ? rawOffset : 0

  const { rows, total } = await repo.listMembers({ limit, offset })
  const items = rows.map(r => ({
    id: r.id,
    displayName: r.display_name,
    phoneMasked: r.phone_number === null ? '—' : maskPhone(r.phone_number),
    plateSummary: summarizePlates(r.plates),
    role: r.role,
    bound: r.line_id !== null,
  }))
  // An empty roster is one empty page, not zero pages — the UI never renders "第 1／0 頁".
  const totalPages = total === 0 ? 1 : Math.ceil(total / limit)
  return { items, page, totalPages, total }
}

function summarizePlates(plates: string[]): string {
  if (plates.length === 0) return ''
  if (plates.length === 1) return plates[0]
  return `${plates[0]} ＋${plates.length - 1}`
}

export interface MemberDetail {
  displayName: string
  phone: string | null       // FULL — session-gated detail page only
  role: string
  bound: boolean             // derived; the raw line_id never reaches the client
  // Tier 0-2 (0038): ACTIVE and RETIRED rows, in that order, each with the id the
  // maintenance actions target. Retired rows are shown, not hidden — a plate that stops
  // appearing entirely leaves an operator unable to tell "never had it" from "sold it",
  // and the reactivate path needs the row anyway.
  vehicles: Array<{ id: string; plate: string; nickname: string | null; isActive: boolean }>
  eligibility: {
    p2Eligible: boolean       // DERIVED from review_status; carries no date — see 0032
    reviewStatus: string      // the authority
    p2Reason: string | null
    p2ValidFrom: string | null
    p2ValidUntil: string | null
    p2ReviewDate: string | null
    // Minor-dependent PII. Reaches this session-gated detail page because the form derives
    // the expiry from it; it must never enter an audit row, a log, or a list DTO (0032).
    p2ChildBirthdate: string | null
    reviewNote: string | null
    // reviewedAt is not just display: `reviewed_at is not null` IS the governance boundary
    // import_member checks (0033), so the page uses it to say whether the row is still
    // CSV-managed.
    reviewedAt: string | null
    reviewVersion: number     // optimistic lock the form echoes back as expectedVersion
  } | null
  dependents: Array<{ kind: string; name: string; birthdate: string | null }>
}

export async function getMemberDetail(
  userId: string,
  repo: ParkingRepository = createParkingRepository(),
): Promise<MemberDetail | null> {
  const row = await repo.getMemberAdminDetail(userId)
  if (!row) return null
  return {
    displayName: row.display_name,
    phone: row.phone_number,
    role: row.role,
    bound: row.line_id !== null,   // drop the raw line_id; the client only needs the flag
    vehicles: row.vehicles.map(v => ({
      id: v.id,
      plate: v.license_plate,
      nickname: v.nickname,
      isActive: v.is_active,
    })),
    eligibility: row.eligibility
      ? {
          p2Eligible: row.eligibility.p2_eligible,
          reviewStatus: row.eligibility.review_status,
          p2Reason: row.eligibility.p2_reason,
          p2ValidFrom: row.eligibility.p2_valid_from,
          p2ValidUntil: row.eligibility.p2_valid_until,
          p2ReviewDate: row.eligibility.p2_review_date,
          p2ChildBirthdate: row.eligibility.p2_child_birthdate,
          reviewNote: row.eligibility.review_note,
          reviewedAt: row.eligibility.reviewed_at,
          reviewVersion: row.eligibility.review_version,
        }
      : null,
    dependents: row.dependents.map(d => ({ kind: d.kind, name: d.name, birthdate: d.birthdate })),
  }
}

const MIN_TTL_DAYS = 1
const MAX_TTL_DAYS = 90

export type IssueMemberCodeResult =
  | { ok: true; code: string; expiresAt: string; displayName: string }
  | { ok: false; reason: 'member_not_found' | 'already_bound' }

// Issue a one-time binding code for an UNBOUND member (wraps issueBindingCode).
//
// The bound check is a UX PRECHECK, not an atomic guarantee: between this read and
// the binding_codes insert, another flow could complete the member's binding. That
// is acceptable — the authoritative gate is approve_pending_binding's
// `member_already_bound`, which refuses to bind an already-bound member. A successful
// issue only means a code row exists; it does NOT promise the code will approve later.
export async function issueMemberBindingCode(
  params: { userId: string; ttlDays?: number; note?: string | null; createdBy: string },
  repo: ParkingRepository = createParkingRepository(),
): Promise<IssueMemberCodeResult> {
  const ttlDays = params.ttlDays ?? 14
  if (!Number.isSafeInteger(ttlDays) || ttlDays < MIN_TTL_DAYS || ttlDays > MAX_TTL_DAYS) {
    throw new Error(`ttlDays must be an integer in ${MIN_TTL_DAYS}..${MAX_TTL_DAYS}`)
  }

  const detail = await repo.getMemberAdminDetail(params.userId)
  if (!detail) return { ok: false, reason: 'member_not_found' }
  if (detail.line_id !== null) return { ok: false, reason: 'already_bound' }

  const issued = await issueBindingCode(
    { userId: params.userId, ttlDays, createdBy: params.createdBy, note: params.note ?? null },
    repo,
  )
  return { ok: true, code: issued.code, expiresAt: issued.expiresAt, displayName: issued.displayName }
}
