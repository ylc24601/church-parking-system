// Phase 6 / Wave 0 — pure helpers for the member-import CLI + Admin UI. No I/O (CSV parsing
// here operates on an in-memory string); unit-tested. See docs/delivery-model-and-roadmap.md.
// Client-safe constants/types (aliases, profiles, reason labels) live in lib/memberImportSchema.ts.

import { parse } from 'csv-parse/sync'
import { taipeiToday } from '@/lib/taipeiDate'
import { childCompanionValidUntil } from '@/lib/eligibilityStatus'
import {
  canonicalizeHeader,
  detectProfile,
  PROFILE_REQUIRED_HEADERS,
  REASON_ALIASES,
  type CsvImportErrorCode,
  type ImportProfile,
  type P2Reason,
  type RosterPriority,
} from '@/lib/memberImportSchema'

// Single entry point: re-export the schema types so existing '@/lib/memberImport' imports work.
export type {
  P2Reason, ImportProfile, RosterPriority, CsvImportErrorCode, GroupConflictField,
} from '@/lib/memberImportSchema'

export type ReasonType = 1 | 2 | 3 | 4
export type DependentKind = 'impaired' | 'child' | 'elder'
export interface Dependent {
  kind: DependentKind
  name: string
  birthdate: string | null // ISO YYYY-MM-DD
}

// mobile phone → digits only (the member identity key). Empty string if none.
export function normalizePhone(raw: string | undefined | null): string {
  return (raw ?? '').replace(/\D/g, '')
}

// A Taiwan mobile number: 09 + 8 digits (10 total), evaluated on the normalized (digits-only) form.
// Guards the phone identity key so junk like "1" / landline-style numbers can't reach users_phone_key.
export function isValidTaiwanMobilePhone(phone: string): boolean {
  return /^09\d{8}$/.test(phone)
}

// Excel scientific notation (e.g. "9.12346E+8"): Excel already ROUNDED the value, so the original
// digits are unrecoverable. Strict single regex (not a loose "contains E+") so odd strings aren't
// mis-flagged. Detected → rejected, never reconstructed.
const SCIENTIFIC_NOTATION = /^[+-]?\d+(?:\.\d+)?[eE][+-]?\d+$/

export type MobilePhoneParse =
  | { ok: true; phone: string }
  | { ok: false; code: 'missing' | 'scientific_notation' | 'invalid' }

// Parse a raw phone cell into the canonical Taiwan-mobile identity key (09XXXXXXXX), tolerating
// two common Excel artifacts (#22):
//   * a 9-digit "9XXXXXXXX" (Excel dropped the leading 0) → prepend a single '0' char
//   * scientific notation → REJECTED with a typed code (rounded, not recoverable)
// +886 / 886 are deliberately NOT supported yet (backlog): after stripping non-digits they read as
// "886…" and fail the FULL-format check below (length alone is not enough to accept them).
export function parseMobilePhone(raw: string | undefined | null): MobilePhoneParse {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return { ok: false, code: 'missing' }
  if (SCIENTIFIC_NOTATION.test(trimmed)) return { ok: false, code: 'scientific_notation' }
  let digits = trimmed.replace(/\D/g, '')
  if (/^9\d{8}$/.test(digits)) digits = '0' + digits // restore the Excel-dropped leading zero
  if (isValidTaiwanMobilePhone(digits)) return { ok: true, phone: digits }
  return { ok: false, code: 'invalid' }
}

// Accept YYYY-MM-DD or YYYY/MM/DD (the form mixes both) → ISO YYYY-MM-DD, else null.
export function parseFormDate(raw: string | undefined | null): string | null {
  const s = (raw ?? '').trim()
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s)
  if (!m) return null
  const [, y, mo, d] = m
  const month = Number(mo), day = Number(d)
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`
}

export function isPregnancy(remarks: string | undefined | null): boolean {
  return /懷孕|pregnan/i.test(remarks ?? '')
}

function addMonthsISO(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1 + months, d)).toISOString().slice(0, 10)
}
// The LATEST birthdate is the YOUNGEST child — the one whose eligibility runs longest.
function maxISO(dates: string[]): string {
  return dates.reduce((a, b) => (b > a ? b : a))
}

const TEMP_MONTHS = 6 // mobility_short / pregnancy validity window from application date

export interface EligibilityInput {
  reasonType: ReasonType
  remarks?: string | null
  applicationDate?: string | null // ISO
  childBirthdates?: string[]       // ISO, present children only
  now?: Date
}
export interface EligibilityResult {
  p2_reason: P2Reason
  valid_until: string | null // null = permanent OR review-required (disambiguate via reviewRequired)
  review_date: string | null
  reviewRequired: boolean
}

// Maps reason_type → p2_reason and computes the eligibility window (decision 3):
//   mobility_long / elderly_companion → permanent
//   mobility_short / pregnancy        → application_date + 6 months; missing date → review_required
//   child_companion                   → the Aug-31 school-year cohort of the YOUNGEST child
//                                       (childCompanionValidUntil); no birthdate → review_required
// The child rule changed in Wave 2B-2a (#10): it used to be the youngest child's 5th
// birthday to the day, which expired a child mid-school-year. It is now anchored to the
// 9/1 school-entry cutoff — see lib/eligibilityStatus.ts for the rule and why 9/1 vs 9/2
// differ by a full year.
export function computeEligibility(input: EligibilityInput): EligibilityResult {
  const { reasonType, remarks, applicationDate, childBirthdates = [], now = new Date() } = input
  const hasChildren = childBirthdates.length > 0
  const today = now.toISOString().slice(0, 10)

  const p2_reason: P2Reason =
    reasonType === 1 ? 'mobility_long'
    : reasonType === 2 ? 'mobility_short'
    : reasonType === 4 ? 'elderly_companion'
    : isPregnancy(remarks) && !hasChildren ? 'pregnancy'
    : 'child_companion'

  if (p2_reason === 'mobility_long' || p2_reason === 'elderly_companion') {
    return { p2_reason, valid_until: null, review_date: null, reviewRequired: false }
  }

  if (p2_reason === 'mobility_short' || p2_reason === 'pregnancy') {
    if (!applicationDate) return { p2_reason, valid_until: null, review_date: today, reviewRequired: true }
    const until = addMonthsISO(applicationDate, TEMP_MONTHS)
    return { p2_reason, valid_until: until, review_date: until, reviewRequired: false }
  }

  // child_companion
  if (!hasChildren) return { p2_reason, valid_until: null, review_date: today, reviewRequired: true }
  const until = childCompanionValidUntil(maxISO(childBirthdates))
  return { p2_reason, valid_until: until, review_date: until, reviewRequired: false }
}

// Roster import (#21) carries no application date or dependents, so a P2 member's eligibility is
// determined by the reason ALONE: the two permanent reasons take effect immediately; the three
// windowed reasons (mobility_short / pregnancy / child_companion) can't get a real end date
// without evidence, so they are flagged review-required (a P2 summary awaiting a human) — we do
// NOT guess a 6-month / age-5 date. `now` is passed in (never new Date() here) so preview/apply
// and unit tests are stable; the review date is the Taipei calendar day of the APPLY.
export function deriveRosterEligibility(p2Reason: P2Reason, now: Date): EligibilityResult {
  if (p2Reason === 'mobility_long' || p2Reason === 'elderly_companion') {
    return { p2_reason: p2Reason, valid_until: null, review_date: null, reviewRequired: false }
  }
  return { p2_reason: p2Reason, valid_until: null, review_date: taipeiToday(now), reviewRequired: true }
}

// Raw CSV row keyed by the form's field_name headers.
export type RawRow = Record<string, string>

export function collectDependents(row: RawRow, reasonType: ReasonType): Dependent[] {
  if (reasonType === 1 || reasonType === 2) {
    const name = (row.impaired_person_name ?? '').trim()
    return name ? [{ kind: 'impaired', name, birthdate: null }] : []
  }
  if (reasonType === 4) {
    const name = (row.elder_1_name ?? '').trim()
    return name ? [{ kind: 'elder', name, birthdate: parseFormDate(row.elder_1_birthdate) }] : []
  }
  // reason 3: children (pregnancy has no dependent)
  const out: Dependent[] = []
  for (const i of [1, 2, 3]) {
    const name = (row[`child_${i}_name`] ?? '').trim()
    if (name) out.push({ kind: 'child', name, birthdate: parseFormDate(row[`child_${i}_birthdate`]) })
  }
  return out
}

// Row-level validation → human-readable errors (operator-facing; the operator runs on the PII file
// locally). Non-fatal: the batch continues and reports. Profile-aware: the P2 application form
// carries a numeric reason_type + dependents; the roster carries a priority + optional 事由.
export type RowValidation =
  | { ok: false; errors: string[] }
  | { ok: true; profile: 'p2_application'; phone: string; reasonType: ReasonType }
  | { ok: true; profile: 'roster'; phone: string; priority: RosterPriority; reason: P2Reason | null }

// Shared name / phone / plate checks. Returns the canonical phone (09XXXXXXXX) or null on error.
function validateIdentity(row: RawRow, errors: string[]): string | null {
  if (!(row.applicant_name ?? '').trim()) errors.push('missing applicant_name')
  if (!(row.license_plate ?? '').trim()) errors.push('missing license_plate')
  const res = parseMobilePhone(row.mobile_phone)
  if (res.ok) return res.phone
  if (res.code === 'missing') errors.push('missing mobile_phone')
  else if (res.code === 'scientific_notation')
    errors.push('mobile_phone is scientific notation (Excel rounded it); set that column to text format and re-export')
  else errors.push(`invalid mobile_phone "${row.mobile_phone ?? ''}" (expect Taiwan mobile 09XXXXXXXX)`)
  return null
}

export function validateRow(row: RawRow, profile: ImportProfile): RowValidation {
  const errors: string[] = []
  const phone = validateIdentity(row, errors)
  return profile === 'roster'
    ? validateRosterRow(row, phone, errors)
    : validateP2ApplicationRow(row, phone, errors)
}

function validateRosterRow(row: RawRow, phone: string | null, errors: string[]): RowValidation {
  const raw = (row.priority ?? '').trim().toUpperCase()
  const priority = (raw === 'P1' || raw === 'P2' || raw === 'P3' ? raw : null) as RosterPriority | null
  if (priority === null) errors.push(`invalid priority "${row.priority ?? ''}" (expect P1/P2/P3)`)

  // Only P2 reads 事由; P1/P3 ignore it. Unknown label → error (never silently mapped).
  let reason: P2Reason | null = null
  if (priority === 'P2') {
    reason = REASON_ALIASES[(row.reason_label ?? '').trim()] ?? null
    if (reason === null) errors.push(`P2 requires a valid P2事由 (got "${row.reason_label ?? ''}")`)
  }

  if (errors.length > 0 || phone === null || priority === null) return { ok: false, errors }
  return { ok: true, profile: 'roster', phone, priority, reason }
}

// An optional date cell that is PRESENT but unparseable is bad input, not a missing value: it must
// surface as a row error (which taints the whole member via row-completeness) rather than silently
// becoming null — otherwise a typo'd date reads as "not provided" and quietly changes eligibility.
function rejectUnparseableDate(raw: string | undefined | null, field: string, errors: string[]): void {
  const s = (raw ?? '').trim()
  if (s && !parseFormDate(s)) errors.push(`invalid ${field} "${s}" (expect YYYY-MM-DD or YYYY/MM/DD)`)
}

function validateP2ApplicationRow(row: RawRow, phone: string | null, errors: string[]): RowValidation {
  const rt = Number(row.reason_type)
  const reasonType = (rt === 1 || rt === 2 || rt === 3 || rt === 4 ? rt : null) as ReasonType | null
  if (reasonType === null) {
    errors.push(`invalid reason_type "${row.reason_type ?? ''}"`)
    return { ok: false, errors }
  }
  rejectUnparseableDate(row.application_date, 'application_date', errors)
  if ((reasonType === 1 || reasonType === 2) && !(row.impaired_person_name ?? '').trim()) {
    errors.push('reason_type 1/2 requires impaired_person_name')
  }
  if (reasonType === 4) {
    if (!(row.elder_1_name ?? '').trim()) errors.push('reason_type 4 requires elder_1_name')
    if (!parseFormDate(row.elder_1_birthdate)) errors.push('reason_type 4 requires a valid elder_1_birthdate')
  }
  if (reasonType === 3) {
    if (!isPregnancy(row.remarks) && !(row.child_1_name ?? '').trim()) {
      errors.push('reason_type 3 requires child_1_name or a pregnancy remark')
    }
    // Only children that are actually collected (name present) carry a birthdate worth validating.
    for (const i of [1, 2, 3]) {
      if ((row[`child_${i}_name`] ?? '').trim()) {
        rejectUnparseableDate(row[`child_${i}_birthdate`], `child_${i}_birthdate`, errors)
      }
    }
  }
  if (errors.length > 0 || phone === null) return { ok: false, errors }
  return { ok: true, profile: 'p2_application', phone, reasonType }
}

// ── CSV structural parsing + limits (Phase 8 Slice 5 / Wave 0) ───────────────
// The upload surface must bound work before touching the DB. These caps apply to
// BOTH the CLI (via importMembersFromCsv) and the Admin UI upload — fail fast on a
// malformed / oversized file with a typed code instead of a giant per-row report.
// Required headers are per-profile (PROFILE_REQUIRED_HEADERS in memberImportSchema),
// checked after aliasing + profile detection.
export const MAX_CSV_BYTES = 2 * 1024 * 1024 // 2 MiB — the upload byte cap (church-scale files are tens of KB)
export const MAX_ROWS = 5000
export const MAX_CELL_CODEPOINTS = 500
export const MAX_REPORT_ITEMS = 500

// Typed structural failure. The message is intentionally generic (no parser output /
// row content) so a route can surface the code without leaking PII fragments.
// CsvImportErrorCode is defined in lib/memberImportSchema.ts (and re-exported above).
export class CsvImportError extends Error {
  constructor(readonly code: CsvImportErrorCode) {
    super(code)
    this.name = 'CsvImportError'
  }
}

// Parse the CSV text into header-keyed rows + the detected profile, enforcing structure
// limits. Headers are canonicalized (Chinese → field_name) BEFORE duplicate detection, so
// a file mixing 姓名 and applicant_name is a duplicate. Throws CsvImportError on any
// structural problem; row-level content validation stays in validateRow (per-row, non-fatal).
export function parseCsv(csvText: string): { rows: RawRow[]; profile: ImportProfile } {
  let headerIssue: CsvImportErrorCode | null = null
  const canonicalHeaders: string[] = []
  let records: RawRow[]
  try {
    records = parse(csvText, {
      bom: true,
      columns: (firstRow: string[]) => {
        const seen = new Set<string>()
        const canonical = firstRow.map(canonicalizeHeader)
        for (const h of canonical) {
          if (seen.has(h)) headerIssue ??= 'duplicate_headers'
          seen.add(h)
          canonicalHeaders.push(h)
        }
        return canonical // RawRow keys are the canonical field_names
      },
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      to: MAX_ROWS + 1, // read one past the cap so we can detect an over-long file
    }) as RawRow[]
  } catch {
    // Malformed CSV (bad quoting, etc.). Never surface the parser's message.
    throw new CsvImportError('invalid_csv')
  }
  if (headerIssue) throw new CsvImportError(headerIssue)

  const detected = detectProfile(canonicalHeaders)
  if (!detected.ok) throw new CsvImportError(detected.code)
  for (const req of PROFILE_REQUIRED_HEADERS[detected.profile]) {
    if (!canonicalHeaders.includes(req)) throw new CsvImportError('missing_headers')
  }

  if (records.length > MAX_ROWS) throw new CsvImportError('too_many_rows')
  return { rows: records, profile: detected.profile }
}

// The longest cell (by code points) across a row's values — used to reject a row
// whose content is implausibly long before it reaches the DB.
export function longestCell(row: RawRow): number {
  let max = 0
  for (const v of Object.values(row)) {
    const len = [...(v ?? '')].length
    if (len > max) max = len
  }
  return max
}
