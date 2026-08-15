// Phase — Wave 0 (#20/#21). Client-safe constants + types for member import: NO csv-parse,
// NO node I/O. A client component (app/admin/import/MemberImport.tsx) can import the aliases
// and error copy from here without pulling the CSV parser into the browser bundle. The
// I/O-bearing parser / row validation / phone parsing / eligibility live in lib/memberImport.ts,
// which re-exports P2Reason so existing '@/lib/memberImport' imports keep working.

export type P2Reason = 'mobility_long' | 'mobility_short' | 'pregnancy' | 'elderly_companion' | 'child_companion'

// Two supported CSV shapes, auto-detected from the (aliased) headers — see detectProfile:
//   p2_application — the church P2 application form (numeric 申請原因 1–4 + dependents)
//   roster         — a general member roster (優先序 P1/P2/P3, mostly P3, no dependents)
export type ImportProfile = 'p2_application' | 'roster'

export type RosterPriority = 'P1' | 'P2' | 'P3'

// Structural failure codes for the parser. `ambiguous_profile` is new in Wave 0: a file
// carrying BOTH discriminators (優先序 AND 申請原因) is a mixed/mis-built template and fails
// closed rather than silently picking one shape.
export type CsvImportErrorCode =
  | 'invalid_csv'
  | 'missing_headers'
  | 'duplicate_headers'
  | 'too_many_rows'
  | 'ambiguous_profile'

// Chinese (and legacy English) column headers → the canonical field_name the pipeline reads.
// Both church templates (docs/import-templates/*) use Chinese headers. An unknown header is
// left as-is (canonicalizeHeader returns it unchanged) and ignored downstream.
export const HEADER_ALIASES: Record<string, string> = {
  // identity + shared
  姓名: 'applicant_name',
  申請人姓名: 'applicant_name',
  手機: 'mobile_phone',
  手機號碼: 'mobile_phone',
  車牌: 'license_plate',
  車牌號碼: 'license_plate',
  備註: 'remarks',
  // roster only
  優先序: 'priority',
  P2事由: 'reason_label',
  // p2_application only
  申請日期: 'application_date',
  申請原因: 'reason_type',
  行動不便者姓名: 'impaired_person_name',
  孩童姓名1: 'child_1_name',
  孩童生日1: 'child_1_birthdate',
  孩童姓名2: 'child_2_name',
  孩童生日2: 'child_2_birthdate',
  孩童姓名3: 'child_3_name',
  孩童生日3: 'child_3_birthdate',
  長者姓名: 'elder_1_name',
  長者生日: 'elder_1_birthdate',
}

// Chinese 「P2事由」label (roster profile) → canonical p2_reason. THE single source shared by
// the parser and the UI. The P2 application form instead carries a numeric 申請原因 1–4
// (validateRow handles that path). An unknown label must surface as a per-row validation error
// (never silently mapped). Values verified against DB enum p2_reason (0001) + P2Reason above.
export const REASON_ALIASES: Record<string, P2Reason> = {
  行動不便: 'mobility_long',
  短期不便: 'mobility_short',
  幼兒同行: 'child_companion',
  孕婦: 'pregnancy',
  長者同行: 'elderly_companion',
}

// Required canonical headers per profile — checked AFTER aliasing + profile detection.
export const PROFILE_REQUIRED_HEADERS: Record<ImportProfile, readonly string[]> = {
  p2_application: ['applicant_name', 'mobile_phone', 'license_plate', 'reason_type'],
  roster: ['applicant_name', 'mobile_phone', 'license_plate', 'priority'],
}

// One member (canonical phone) may span several rows — one per vehicle. When those rows disagree on
// a field that decides the member's eligibility, the import fails that member closed rather than
// letting row order pick a winner. This is the single mechanism for BOTH profiles.
export type GroupConflictField =
  | 'priority'            // roster: P1/P2/P3 disagree
  | 'reason_label'        // roster: P2 事由 disagrees
  | 'reason_type'         // p2_application: 申請原因 disagrees
  | 'application_date'    // p2_application: two different (valid) 申請日期
  | 'pregnancy'           // p2_application reason 3: derived isPregnancy() flag disagrees
  | 'dependent_birthdate' // p2_application: one dependent with two different birthdates

// UI labels for the conflict list. UI-only — the CLI just counts conflicts, so it does not import
// this map. Conflict `values` are always CANONICAL (never raw free text such as remarks).
export const GROUP_CONFLICT_FIELD_LABEL: Record<GroupConflictField, string> = {
  priority: '優先序',
  reason_label: 'P2事由',
  reason_type: '申請原因',
  application_date: '申請日期',
  pregnancy: '孕婦判定',
  dependent_birthdate: '眷屬生日',
}

// Normalize one raw header cell → canonical field_name: strip BOM, fold full-width spaces to
// ASCII, trim, then map through HEADER_ALIASES. A header that is already canonical (or truly
// unknown) maps to itself. Pure string logic → safe to run in either a client or the parser.
export function canonicalizeHeader(raw: string): string {
  const cleaned = raw.replace(/﻿/g, '').replace(/　/g, ' ').trim()
  return HEADER_ALIASES[cleaned] ?? cleaned
}

// Decide the CSV shape from its canonical header set. priority-only → roster; reason_type-only
// → p2_application; BOTH → ambiguous_profile (fail closed); NEITHER → missing_headers. The
// profile is a pure function of the headers, so preview and apply (same bytes) always agree.
export function detectProfile(
  headers: Iterable<string>,
): { ok: true; profile: ImportProfile } | { ok: false; code: 'ambiguous_profile' | 'missing_headers' } {
  const set = headers instanceof Set ? headers : new Set(headers)
  const hasPriority = set.has('priority')
  const hasReasonType = set.has('reason_type')
  if (hasPriority && hasReasonType) return { ok: false, code: 'ambiguous_profile' }
  if (hasPriority) return { ok: true, profile: 'roster' }
  if (hasReasonType) return { ok: true, profile: 'p2_application' }
  return { ok: false, code: 'missing_headers' }
}
