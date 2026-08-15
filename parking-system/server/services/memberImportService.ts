import { readFileSync } from 'node:fs'
import { maskPhone } from '@/lib/binding'
import { normalizePlate } from '@/lib/plate'
import { createParkingRepository, type ParkingRepository } from '@/server/repositories/parkingRepository'
import {
  collectDependents,
  computeEligibility,
  deriveRosterEligibility,
  isPregnancy,
  longestCell,
  MAX_CELL_CODEPOINTS,
  MAX_REPORT_ITEMS,
  parseCsv,
  parseFormDate,
  parseMobilePhone,
  validateRow,
  type Dependent,
  type DependentKind,
  type EligibilityResult,
  type GroupConflictField,
  type P2Reason,
  type RawRow,
  type ReasonType,
  type RosterPriority,
} from '@/lib/memberImport'

// Phase 6 / Wave 0 — import a member CSV into users + vehicles (+ P2 eligibility + dependents).
// Members are keyed by mobile phone; several rows with the same phone are one member with several
// vehicles. line_id is never touched. Dry-run by default at the CLI.
//
// Two CSV shapes, auto-detected from headers (parseCsv → profile):
//   p2_application — the church P2 application form (numeric 申請原因 + dependents) → eligibility per row
//   roster         — a general member roster (優先序 P1/P2/P3, mostly P3) → P1/P3 write NO eligibility,
//                    P2 writes a review-required eligibility summary (no dates in the roster).
// A P1/P3 roster row NEVER revokes an existing member's P2 (eligibility revocation is the review
// tool, #10); if the member already had P2, it is reported in p2Retained as an untouched warning.
// The converse holds too since 0032: a P2 row NEVER resurrects an eligibility a 幹事 revoked —
// reported in revokedRetained. Import can establish eligibility; it cannot overturn a review.
//
// PII note: this reads a real member file. The report is operator-facing and may contain
// names/plates/phones — it must NOT be logged or persisted.

export interface ImportReport {
  dryRun: boolean
  rows: number
  members: number
  imported: number
  updated: number
  vehiclesAdded: number
  dependentsAdded: number
  phoneNameConflicts: Array<{ phone: string; names: string[]; existingName?: string }>
  // Tier 0-2 (0038) — the CSV's phone is NOT in the DB, but that NAME already belongs to
  // somebody. Kept in its OWN bucket rather than folded into phoneNameConflicts: the two
  // say opposite things and need opposite actions. "同號不同名" means the file is probably
  // wrong; this one usually means the member is right there under a phone they changed —
  // and importing anyway would create a second users.id holding none of their binding,
  // history or eligibility, which this system has no tool to merge back.
  //
  // Candidate phones are MASKED: they belong to members who are not in this file, and the
  // operator needs to recognise a person, not to read a number they were not given.
  identityConflicts: Array<{
    phone: string
    name: string
    candidates: Array<{ phoneMasked: string; evidence: 'same_name' | 'same_name_and_plate' }>
  }>
  plateConflicts: Array<{ phone: string; plates: string[] }>
  // CSV self-contradiction: one plate claimed by >1 phone in THIS file. Distinct from plateConflicts
  // (a plate already owned by another member in the DB) — the whole member is skipped, fail closed.
  batchPlateConflicts: Array<{ plate: string; phones: string[] }>
  // Same phone, rows disagree on a field that decides eligibility — the whole member is skipped
  // (row order must never pick a winner). One mechanism for both profiles; `values` are canonical
  // (never raw free text). Only the FIRST conflict per member is reported — see resolveP2Group.
  groupConflicts: Array<{ phone: string; field: GroupConflictField; subject?: string; values: string[] }>
  reviewRequired: Array<{ phone: string; reason: string }>
  // Existing-P2 member marked P1/P3 in a roster import: eligibility kept, NOT revoked (warning).
  p2Retained: Array<{ phone: string }>
  // The CSV lists this member as P2, but a 幹事 had explicitly REVOKED their eligibility.
  // The row is left untouched — a bulk roster must not overturn an audited human decision
  // (0032). Re-granting is a deliberate act in the review tool, not a side effect of import.
  revokedRetained: Array<{ phone: string }>
  // The CSV lists this member as P2, but their eligibility is hand-maintained by a 幹事
  // (reviewed_at is not null). Frozen and reported (0033) — a silent skip would be as bad as
  // the silent overwrite it replaces: the operator uploads a roster, some members don't
  // update, and nothing says why.
  governedRetained: Array<{ phone: string }>
  validationErrors: Array<{ line: number; errors: string[] }>
  // True if any list was truncated to MAX_REPORT_ITEMS; totals hold the untruncated counts.
  truncated: boolean
  totals: {
    phoneNameConflicts: number
    identityConflicts: number
    plateConflicts: number
    batchPlateConflicts: number
    groupConflicts: number
    reviewRequired: number
    p2Retained: number
    revokedRetained: number
    governedRetained: number
    validationErrors: number
  }
}

// Thrown when an APPLY partially succeeded: some members were written before a later
// repo call failed. Carries a safe report of what completed (no raw DB error) so the
// operator learns the DB is partially written, not that "nothing happened".
export class CsvImportExecutionError extends Error {
  constructor(readonly processedMembers: number, readonly report: ImportReport) {
    super('partial_apply')
    this.name = 'CsvImportExecutionError'
  }
}

interface ParsedRow {
  line: number
  name: string
  phone: string
  plate: string
  // p2_application only
  reasonType: ReasonType | null
  remarks: string
  applicationDate: string | null
  dependents: Dependent[]
  // roster only
  priority: RosterPriority | null
  rosterReason: P2Reason | null
}

// ── Group resolution ─────────────────────────────────────────────────────────
// A member (canonical phone) spans one row per vehicle. These resolvers derive the member's reason
// + eligibility from the WHOLE group and fail closed on any disagreement, so row order can never
// decide eligibility. Each returns at most ONE conflict; the checks run in a fixed order
// (reason_type → pregnancy → application_date → dependent_birthdate), so a member with several
// contradictions surfaces the next one after the first is fixed and re-previewed.

type GroupResolution =
  | { ok: true; reason: string | null; elig: EligibilityResult | null; dependents: Dependent[] }
  | { ok: false; field: GroupConflictField; subject?: string; values: string[] }

function resolveRosterGroup(rows: ParsedRow[], now: Date): GroupResolution {
  const priorities = [...new Set(rows.map(r => r.priority))] as RosterPriority[]
  if (priorities.length > 1) return { ok: false, field: 'priority', values: [...priorities].sort() }
  // P1/P3 = general member: no eligibility, and never revokes an existing P2.
  if (priorities[0] !== 'P2') return { ok: true, reason: null, elig: null, dependents: [] }

  const reasons = [...new Set(rows.map(r => r.rosterReason))].filter(Boolean) as P2Reason[]
  if (reasons.length > 1) return { ok: false, field: 'reason_label', values: [...reasons].sort() }
  return { ok: true, reason: reasons[0], elig: deriveRosterEligibility(reasons[0], now), dependents: [] }
}

function resolveP2Group(rows: ParsedRow[], now: Date): GroupResolution {
  const reasonTypes = [...new Set(rows.map(r => r.reasonType))] as ReasonType[]
  if (reasonTypes.length > 1) {
    return { ok: false, field: 'reason_type', values: reasonTypes.map(String).sort() }
  }
  const reasonType = reasonTypes[0]

  // remarks only ever matters through isPregnancy(), and only for reason 3 — so require the DERIVED
  // flag to agree, not the verbatim text. Report a controlled label, never the raw remarks.
  let pregnancy = false
  if (reasonType === 3) {
    const flags = [...new Set(rows.map(r => isPregnancy(r.remarks)))]
    if (flags.length > 1) return { ok: false, field: 'pregnancy', values: ['孕婦', '非孕婦'] }
    pregnancy = flags[0]
  }

  // Blank is "not provided" and is filled by the single valid value; two different valid dates are a
  // contradiction. A present-but-unparseable date never reaches here — validateRow rejects that row,
  // which taints the whole member via row-completeness.
  const dates = [...new Set(rows.map(r => (r.applicationDate ? parseFormDate(r.applicationDate) : null)).filter(Boolean))] as string[]
  if (dates.length > 1) return { ok: false, field: 'application_date', values: [...dates].sort() }
  const applicationDate = dates[0] ?? null

  const merged = mergeDependents(rows.flatMap(r => r.dependents))
  if (!merged.ok) return merged

  const childBirthdates = merged.dependents.filter(d => d.kind === 'child' && d.birthdate).map(d => d.birthdate as string)
  // Canonical input built from the resolved group — deliberately NOT rows[0].remarks, so it is
  // evident that eligibility is a property of the member, not of whichever row happened to be first.
  const elig = computeEligibility({
    reasonType, remarks: pregnancy ? '懷孕' : '', applicationDate, childBirthdates, now,
  })
  return { ok: true, reason: elig.p2_reason, elig, dependents: merged.dependents }
}

// Merge a member's dependents across rows by (kind, name): a blank birthdate is filled by the single
// valid one; two different birthdates for the same dependent are a contradiction (silently taking
// max() would quietly extend valid_until). Birthdates are already ISO-normalized by collectDependents,
// so 2022-03-01 and 2022/03/01 collapse to one value.
function mergeDependents(all: Dependent[]):
  | { ok: true; dependents: Dependent[] }
  | { ok: false; field: 'dependent_birthdate'; subject: string; values: string[] } {
  const byKey = new Map<string, { kind: DependentKind; name: string; birthdates: Set<string> }>()
  for (const d of all) {
    const name = d.name.trim()
    const key = `${d.kind}|${name}`
    let entry = byKey.get(key)
    if (!entry) { entry = { kind: d.kind, name, birthdates: new Set() }; byKey.set(key, entry) }
    if (d.birthdate) entry.birthdates.add(d.birthdate)
  }
  const dependents: Dependent[] = []
  for (const entry of byKey.values()) {
    if (entry.birthdates.size > 1) {
      return {
        ok: false, field: 'dependent_birthdate',
        subject: `${entry.kind}／${entry.name}`, values: [...entry.birthdates].sort(),
      }
    }
    dependents.push({ kind: entry.kind, name: entry.name, birthdate: [...entry.birthdates][0] ?? null })
  }
  return { ok: true, dependents }
}

// Core pipeline over CSV TEXT. Throws CsvImportError for structural problems (parseCsv),
// and CsvImportExecutionError if an apply fails partway through.
export async function importMembersFromCsvText(
  params: { csvText: string; dryRun: boolean; now?: Date },
  repo: ParkingRepository = createParkingRepository(),
): Promise<ImportReport> {
  const { csvText, dryRun, now = new Date() } = params
  const { rows: records, profile } = parseCsv(csvText)

  const report: ImportReport = {
    dryRun, rows: records.length, members: 0, imported: 0, updated: 0, vehiclesAdded: 0, dependentsAdded: 0,
    phoneNameConflicts: [], identityConflicts: [], plateConflicts: [], batchPlateConflicts: [],
    groupConflicts: [],
    reviewRequired: [], p2Retained: [], revokedRetained: [], governedRetained: [], validationErrors: [],
    truncated: false,
    totals: {
      phoneNameConflicts: 0, identityConflicts: 0, plateConflicts: 0, batchPlateConflicts: 0,
      groupConflicts: 0,
      reviewRequired: 0, p2Retained: 0, revokedRetained: 0, governedRetained: 0, validationErrors: 0,
    },
  }

  // Validate + parse; a row with errors (or an implausibly long cell) is reported and excluded.
  // A failing row whose PHONE is still parseable taints that whole member (row-completeness):
  // we never silently import only the good rows of a member whose other row was rejected.
  const parsed: ParsedRow[] = []
  const invalidPhones = new Set<string>()
  // A rejected row taints its member (by parseable phone) so the group is skipped wholesale —
  // this must happen on EVERY reject path, including the over-long-cell one.
  const rejectRow = (line: number, errors: string[], row: RawRow) => {
    pushCapped(report.validationErrors, { line, errors })
    report.totals.validationErrors++
    const pp = parseMobilePhone(row.mobile_phone)
    if (pp.ok) invalidPhones.add(pp.phone)
  }

  records.forEach((row, i) => {
    const line = i + 2 // header is line 1
    if (longestCell(row) > MAX_CELL_CODEPOINTS) {
      rejectRow(line, [`a field exceeds ${MAX_CELL_CODEPOINTS} characters`], row)
      return
    }
    const v = validateRow(row, profile)
    if (!v.ok) {
      rejectRow(line, v.errors, row)
      return
    }
    const base = {
      line,
      name: (row.applicant_name ?? '').trim(),
      phone: v.phone,
      plate: (row.license_plate ?? '').trim(),
    }
    parsed.push(
      v.profile === 'roster'
        ? { ...base, reasonType: null, remarks: '', applicationDate: null, dependents: [], priority: v.priority, rosterReason: v.reason }
        : {
            ...base,
            reasonType: v.reasonType,
            remarks: row.remarks ?? '',
            applicationDate: row.application_date ? row.application_date.trim() : null,
            dependents: collectDependents(row, v.reasonType),
            priority: null,
            rosterReason: null,
          },
    )
  })

  // Batch-local plate preflight: a plate claimed by >1 phone in THIS file is a human error in the
  // list. Report each such plate once and fail the affected members closed (dry-run == apply). This
  // catches conflicts the per-row DB dry-run cannot see (neither member is written yet).
  const plateOwners = new Map<string, Set<string>>()
  for (const r of parsed) {
    const norm = normalizePlate(r.plate)
    if (!norm) continue
    let owners = plateOwners.get(norm)
    if (!owners) { owners = new Set(); plateOwners.set(norm, owners) }
    owners.add(r.phone)
  }
  const conflictedPlates = new Set<string>()
  for (const [plate, phones] of plateOwners) {
    if (phones.size > 1) {
      conflictedPlates.add(plate)
      pushCapped(report.batchPlateConflicts, { plate, phones: [...phones] })
      report.totals.batchPlateConflicts++
    }
  }

  // Group by phone (several vehicles per member).
  const groups = new Map<string, ParsedRow[]>()
  for (const r of parsed) {
    const g = groups.get(r.phone) ?? []
    g.push(r)
    groups.set(r.phone, g)
  }

  let processedMembers = 0
  for (const [phone, rows] of groups) {
    report.members++

    // Row-completeness: another row for this phone failed validation → skip the whole member.
    if (invalidPhones.has(phone)) {
      pushCapped(report.validationErrors, { line: rows[0].line, errors: ['member skipped: another row for this mobile_phone failed validation'] })
      report.totals.validationErrors++
      continue
    }

    const names = [...new Set(rows.map(r => r.name))]
    if (names.length > 1) {
      pushCapped(report.phoneNameConflicts, { phone, names }) // same phone, different names — ambiguous
      report.totals.phoneNameConflicts++
      continue
    }
    const name = names[0]

    // Resolve reason + eligibility from the WHOLE group (never rows[0]); disagreement fails closed.
    const resolved = profile === 'roster' ? resolveRosterGroup(rows, now) : resolveP2Group(rows, now)
    if (!resolved.ok) {
      const { field, values, subject } = resolved
      pushCapped(report.groupConflicts, { phone, field, ...(subject ? { subject } : {}), values })
      report.totals.groupConflicts++
      continue
    }
    const { reason, elig, dependents } = resolved

    const plates = [...new Set(rows.map(r => r.plate).filter(Boolean))]
    // Batch-local plate conflict → skip the whole member (already reported per-plate above).
    if (plates.some(p => conflictedPlates.has(normalizePlate(p)))) continue

    let res
    try {
      res = await repo.importMember({
        name, phone, plates, reason,
        validUntil: elig?.valid_until ?? null, reviewDate: elig?.review_date ?? null, dependents, dryRun,
      })
    } catch {
      // Per-member RPC is atomic, but the whole CSV is not one transaction. On a write,
      // members processed BEFORE this point are already committed — surface that as a
      // typed partial rather than a generic 500 that reads as "nothing was written".
      finalizeTruncation(report)
      throw new CsvImportExecutionError(processedMembers, report)
    }

    if (res.status === 'phone_name_conflict') {
      // ONE status, two kinds (0038). The discriminant is optional on the wire because a
      // pre-0038 database does not send it — and its absence must mean the ORIGINAL kind,
      // not "unknown": that is what lets an old app keep working against a new DB, and a
      // new app keep working against a DB that has not migrated yet.
      if (res.conflict_kind === 'identity_candidate') {
        pushCapped(report.identityConflicts, {
          phone,
          name,
          candidates: (res.candidates ?? []).map(c => ({
            phoneMasked: c.phone === null ? '—' : maskPhone(c.phone),
            evidence: c.evidence,
          })),
        })
        report.totals.identityConflicts++
        continue
      }
      pushCapped(report.phoneNameConflicts, { phone, names: [name], existingName: res.existing_name })
      report.totals.phoneNameConflicts++
      continue
    }
    if (res.status === 'imported') report.imported++
    else report.updated++
    report.vehiclesAdded += res.vehicles_added ?? 0
    report.dependentsAdded += res.dependents_added ?? 0
    if (res.plate_conflicts && res.plate_conflicts.length > 0) {
      pushCapped(report.plateConflicts, { phone, plates: res.plate_conflicts })
      report.totals.plateConflicts++
    }
    if (reason !== null && elig?.reviewRequired) {
      pushCapped(report.reviewRequired, { phone, reason: elig.p2_reason })
      report.totals.reviewRequired++
    }
    // Roster P1/P3 landing on a member who already had P2: eligibility kept, not revoked.
    if (res.retained_p2) {
      pushCapped(report.p2Retained, { phone })
      report.totals.p2Retained++
    }
    // A P2 row landing on a member a 幹事 revoked: left alone, and said out loud. Silently
    // re-approving them would overturn an audited decision with no record of its own.
    if (res.retained_revoked) {
      pushCapped(report.revokedRetained, { phone })
      report.totals.revokedRetained++
    }
    // A P2 row landing on a member whose eligibility a 幹事 hand-maintains: frozen, and said
    // out loud. The RPC reports only the more specific of revoked/governed, never both.
    if (res.retained_governed) {
      pushCapped(report.governedRetained, { phone })
      report.totals.governedRetained++
    }
    if (!dryRun) processedMembers++
  }

  finalizeTruncation(report)
  return report
}

// Cap a report list so a pathological file can't return a giant payload. The total
// counters keep the real numbers.
function pushCapped<T>(list: T[], item: T): void {
  if (list.length < MAX_REPORT_ITEMS) list.push(item)
}
function finalizeTruncation(report: ImportReport): void {
  report.truncated =
    report.totals.validationErrors > report.validationErrors.length ||
    report.totals.phoneNameConflicts > report.phoneNameConflicts.length ||
    report.totals.identityConflicts > report.identityConflicts.length ||
    report.totals.plateConflicts > report.plateConflicts.length ||
    report.totals.batchPlateConflicts > report.batchPlateConflicts.length ||
    report.totals.groupConflicts > report.groupConflicts.length ||
    report.totals.reviewRequired > report.reviewRequired.length ||
    report.totals.p2Retained > report.p2Retained.length ||
    report.totals.revokedRetained > report.revokedRetained.length ||
    report.totals.governedRetained > report.governedRetained.length
}

// CLI / file-path entry point (unchanged contract): read the file, then run the shared
// text pipeline. Kept so scripts/run-members-import.ts and the file-path integration
// tests work without changes.
export async function importMembersFromCsv(
  params: { filePath: string; dryRun: boolean; now?: Date },
  repo: ParkingRepository = createParkingRepository(),
): Promise<ImportReport> {
  const csvText = readFileSync(params.filePath, 'utf8')
  return importMembersFromCsvText({ csvText, dryRun: params.dryRun, now: params.now }, repo)
}
