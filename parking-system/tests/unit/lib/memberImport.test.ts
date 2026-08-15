import { describe, expect, it } from 'vitest'
import {
  collectDependents,
  computeEligibility,
  CsvImportError,
  deriveRosterEligibility,
  isPregnancy,
  isValidTaiwanMobilePhone,
  longestCell,
  MAX_ROWS,
  normalizePhone,
  parseCsv,
  parseFormDate,
  parseMobilePhone,
  validateRow,
  type RawRow,
} from '@/lib/memberImport'
import { canonicalizeHeader, detectProfile, REASON_ALIASES } from '@/lib/memberImportSchema'

const NOW = new Date('2026-07-06T00:00:00Z')

describe('normalizePhone', () => {
  it('strips non-digits', () => {
    expect(normalizePhone('0912-345 678')).toBe('0912345678')
    expect(normalizePhone(null)).toBe('')
  })
})

describe('isValidTaiwanMobilePhone', () => {
  it('accepts 09 + 8 digits (on the normalized form)', () => {
    expect(isValidTaiwanMobilePhone(normalizePhone('0912345678'))).toBe(true)
    expect(isValidTaiwanMobilePhone(normalizePhone('0912-345-678'))).toBe(true)
    expect(isValidTaiwanMobilePhone('0955000001')).toBe(true) // fixture range
  })
  it('rejects junk, landline-style, and empty', () => {
    expect(isValidTaiwanMobilePhone('1')).toBe(false)
    expect(isValidTaiwanMobilePhone('123456789')).toBe(false)      // 9 digits, no leading 09
    expect(isValidTaiwanMobilePhone('0223456789')).toBe(false)     // landline-style (02…)
    expect(isValidTaiwanMobilePhone('09123456789')).toBe(false)    // too long
    expect(isValidTaiwanMobilePhone('')).toBe(false)
  })
})

describe('parseFormDate', () => {
  it('accepts YYYY-MM-DD and YYYY/MM/DD → ISO', () => {
    expect(parseFormDate('2026-01-05')).toBe('2026-01-05')
    expect(parseFormDate('2022/3/1')).toBe('2022-03-01')
  })
  it('rejects junk', () => {
    expect(parseFormDate('')).toBeNull()
    expect(parseFormDate('2026/13/40')).toBeNull()
    expect(parseFormDate('nope')).toBeNull()
  })
})

describe('isPregnancy', () => {
  it('detects 懷孕 / pregnant', () => {
    expect(isPregnancy('懷孕')).toBe(true)
    expect(isPregnancy('Pregnant passenger')).toBe(true)
    expect(isPregnancy('一般')).toBe(false)
  })
})

describe('computeEligibility', () => {
  it('mobility_long / elderly are permanent', () => {
    expect(computeEligibility({ reasonType: 1, now: NOW })).toMatchObject({ p2_reason: 'mobility_long', valid_until: null, review_date: null, reviewRequired: false })
    expect(computeEligibility({ reasonType: 4, now: NOW })).toMatchObject({ p2_reason: 'elderly_companion', valid_until: null, reviewRequired: false })
  })

  it('mobility_short = application_date + 6 months', () => {
    expect(computeEligibility({ reasonType: 2, applicationDate: '2026-02-10', now: NOW }))
      .toMatchObject({ p2_reason: 'mobility_short', valid_until: '2026-08-10', review_date: '2026-08-10', reviewRequired: false })
  })

  it('pregnancy (reason 3 + remark, no children) = application_date + 6 months', () => {
    expect(computeEligibility({ reasonType: 3, remarks: '懷孕', applicationDate: '2026-05-01', now: NOW }))
      .toMatchObject({ p2_reason: 'pregnancy', valid_until: '2026-11-01', reviewRequired: false })
  })

  it('child_companion = the YOUNGEST child\'s school-entry cohort, ending 8/31', () => {
    // Changed in Wave 2B-2a (#10). Was max(birthdate) + 5 years to the day, which expired a
    // child mid-school-year; now it runs to the 8/31 before they enter 小一 (see
    // lib/eligibilityStatus.ts childCompanionValidUntil). The two birthdates are here to
    // prove the YOUNGEST wins: 2024-08-15 is before the 9/1 cutoff, so 2024 + 6 → 2030-08-31.
    expect(computeEligibility({ reasonType: 3, childBirthdates: ['2022-03-01', '2024-08-15'], now: NOW }))
      .toMatchObject({ p2_reason: 'child_companion', valid_until: '2030-08-31', reviewRequired: false })
  })

  it('child_companion picks the youngest across the 9/1 cutoff, not the latest expiry', () => {
    // A child born 9/2 belongs to the NEXT cohort, so the youngest child is still the one
    // that decides — the rule must not accidentally become max(derived date).
    expect(computeEligibility({ reasonType: 3, childBirthdates: ['2019-09-02', '2019-09-01'], now: NOW }))
      .toMatchObject({ p2_reason: 'child_companion', valid_until: '2026-08-31' })
  })

  it('reason 3 with children wins over a pregnancy remark', () => {
    expect(computeEligibility({ reasonType: 3, remarks: '懷孕', childBirthdates: ['2023-01-01'], now: NOW }).p2_reason)
      .toBe('child_companion')
  })

  it('missing date → review_required (valid_until null, review_date = today)', () => {
    expect(computeEligibility({ reasonType: 2, applicationDate: null, now: NOW }))
      .toMatchObject({ valid_until: null, review_date: '2026-07-06', reviewRequired: true })
    expect(computeEligibility({ reasonType: 3, childBirthdates: [], now: NOW }))
      .toMatchObject({ p2_reason: 'child_companion', reviewRequired: true })
  })
})

describe('collectDependents', () => {
  it('impaired for reason 1/2', () => {
    expect(collectDependents({ impaired_person_name: '王大明' } as RawRow, 1)).toEqual([{ kind: 'impaired', name: '王大明', birthdate: null }])
  })
  it('elder for reason 4', () => {
    expect(collectDependents({ elder_1_name: '林阿公', elder_1_birthdate: '1945/06/01' } as RawRow, 4))
      .toEqual([{ kind: 'elder', name: '林阿公', birthdate: '1945-06-01' }])
  })
  it('multiple children for reason 3', () => {
    const row = { child_1_name: '張小寶', child_1_birthdate: '2022/03/01', child_2_name: '張小小', child_2_birthdate: '2024/08/15' } as RawRow
    expect(collectDependents(row, 3)).toEqual([
      { kind: 'child', name: '張小寶', birthdate: '2022-03-01' },
      { kind: 'child', name: '張小小', birthdate: '2024-08-15' },
    ])
  })
  it('no dependent for pregnancy-only reason 3', () => {
    expect(collectDependents({ remarks: '懷孕' } as RawRow, 3)).toEqual([])
  })
})

describe('validateRow — p2_application', () => {
  const errs = (row: RawRow) => { const v = validateRow(row, 'p2_application'); return v.ok ? [] : v.errors }
  it('passes a well-formed elderly row', () => {
    const v = validateRow({ applicant_name: '林先生', mobile_phone: '0912000003', license_plate: 'GHI-3003', reason_type: '4', elder_1_name: '林阿公', elder_1_birthdate: '1945/06/01' } as RawRow, 'p2_application')
    expect(v).toMatchObject({ ok: true, profile: 'p2_application', reasonType: 4 })
  })
  it('flags missing conditional fields and bad reason_type', () => {
    expect(errs({ applicant_name: 'x', mobile_phone: '0912345678', license_plate: 'A', reason_type: '9' } as RawRow)).toContain('invalid reason_type "9"')
    expect(errs({ applicant_name: 'x', mobile_phone: '0912345678', license_plate: 'A', reason_type: '1' } as RawRow)).toContain('reason_type 1/2 requires impaired_person_name')
    expect(errs({ applicant_name: 'x', mobile_phone: '0912345678', license_plate: 'A', reason_type: '3' } as RawRow)).toContain('reason_type 3 requires child_1_name or a pregnancy remark')
  })

  it('flags a missing or malformed mobile_phone (the identity key)', () => {
    const base = { applicant_name: 'x', license_plate: 'A', reason_type: '4', elder_1_name: 'e', elder_1_birthdate: '1945/01/01' }
    expect(errs({ ...base, mobile_phone: '' } as RawRow)).toContain('missing mobile_phone')
    expect(errs({ ...base, mobile_phone: '1' } as RawRow).some(e => e.startsWith('invalid mobile_phone'))).toBe(true)
    expect(errs({ ...base, mobile_phone: '123456789' } as RawRow).some(e => e.startsWith('invalid mobile_phone'))).toBe(true)
    // a valid mobile passes (no phone error)
    expect(validateRow({ ...base, mobile_phone: '0912-345-678' } as RawRow, 'p2_application').ok).toBe(true)
  })
})

describe('validateRow — roster', () => {
  const roster = (row: Partial<RawRow>) => validateRow({ applicant_name: '王', mobile_phone: '0912345678', license_plate: 'ABC-1234', ...row } as RawRow, 'roster')
  it('P3 needs no 事由', () => {
    expect(roster({ priority: 'P3' })).toMatchObject({ ok: true, profile: 'roster', priority: 'P3', reason: null })
  })
  it('lowercase priority is accepted', () => {
    expect(roster({ priority: 'p2', reason_label: '長者同行' })).toMatchObject({ ok: true, priority: 'P2', reason: 'elderly_companion' })
  })
  it('P2 maps a Chinese 事由 to canonical p2_reason', () => {
    expect(roster({ priority: 'P2', reason_label: '孕婦' })).toMatchObject({ ok: true, reason: 'pregnancy' })
  })
  it('P2 with a missing/unknown 事由 → error (never silently mapped)', () => {
    const v = roster({ priority: 'P2', reason_label: '亂寫' })
    expect(v.ok).toBe(false)
    expect(!v.ok && v.errors.some(e => e.includes('P2事由'))).toBe(true)
  })
  it('invalid priority → error', () => {
    const v = roster({ priority: 'VIP' })
    expect(!v.ok && v.errors.some(e => e.startsWith('invalid priority'))).toBe(true)
  })
})

describe('parseCsv — structure + limits', () => {
  const HEADER = 'applicant_name,mobile_phone,license_plate,reason_type'
  const goodRow = '王小明,0912345678,ABC-1234,1'

  it('parses header-keyed rows (BOM tolerated) + detects p2_application', () => {
    const { rows, profile } = parseCsv(`﻿${HEADER}\n${goodRow}`)
    expect(profile).toBe('p2_application')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ applicant_name: '王小明', mobile_phone: '0912345678', reason_type: '1' })
  })

  it('header-only or empty-ish input → zero rows (not an error)', () => {
    expect(parseCsv(HEADER).rows).toEqual([])
  })

  it('tolerates CRLF, quoted commas, and quoted newlines', () => {
    const { rows } = parseCsv(`${HEADER},remarks\r\n王,0912345678,"AB,CD",1,"line1\nline2"\r\n`)
    expect(rows).toHaveLength(1)
    expect(rows[0].license_plate).toBe('AB,CD')
    expect(rows[0].remarks).toBe('line1\nline2')
  })

  it('missing a required header → missing_headers', () => {
    expect(() => parseCsv('applicant_name,mobile_phone,license_plate\n王,0912345678,A')).toThrowError(
      expect.objectContaining({ code: 'missing_headers' }),
    )
  })

  it('duplicate headers → duplicate_headers', () => {
    expect(() => parseCsv(`${HEADER},mobile_phone\n${goodRow},0911111111`)).toThrowError(
      expect.objectContaining({ code: 'duplicate_headers' }),
    )
  })

  it('malformed quoting → invalid_csv (parser message not surfaced)', () => {
    let thrown: unknown
    try { parseCsv(`${HEADER}\n"unterminated,0912345678,A,1`) } catch (e) { thrown = e }
    expect(thrown).toBeInstanceOf(CsvImportError)
    expect((thrown as CsvImportError).code).toBe('invalid_csv')
  })

  it('more than MAX_ROWS data rows → too_many_rows', () => {
    const body = Array.from({ length: MAX_ROWS + 1 }, () => goodRow).join('\n')
    expect(() => parseCsv(`${HEADER}\n${body}`)).toThrowError(
      expect.objectContaining({ code: 'too_many_rows' }),
    )
  })

  it('exactly MAX_ROWS rows is allowed', () => {
    const body = Array.from({ length: MAX_ROWS }, () => goodRow).join('\n')
    expect(parseCsv(`${HEADER}\n${body}`).rows).toHaveLength(MAX_ROWS)
  })
})

describe('longestCell', () => {
  it('returns the max cell length by code points', () => {
    expect(longestCell({ a: 'xy', b: '王小明' } as RawRow)).toBe(3)
    expect(longestCell({ a: '', b: undefined as unknown as string } as RawRow)).toBe(0)
  })
})

describe('canonicalizeHeader + duplicate detection (#20)', () => {
  it('maps Chinese headers to canonical field_names', () => {
    expect(canonicalizeHeader('姓名')).toBe('applicant_name')
    expect(canonicalizeHeader(' 手機號碼 ')).toBe('mobile_phone')
    expect(canonicalizeHeader('優先序')).toBe('priority')
    expect(canonicalizeHeader('P2事由')).toBe('reason_label')
  })
  it('leaves an already-canonical / unknown header unchanged', () => {
    expect(canonicalizeHeader('applicant_name')).toBe('applicant_name')
    expect(canonicalizeHeader('unknown_col')).toBe('unknown_col')
  })
  it('a Chinese + English alias colliding on one canonical → duplicate_headers', () => {
    expect(() => parseCsv('姓名,applicant_name,手機,車牌,優先序\n王,王,0912345678,ABC,P3'))
      .toThrowError(expect.objectContaining({ code: 'duplicate_headers' }))
  })
})

describe('detectProfile (#21)', () => {
  it('優先序 only → roster', () => {
    expect(detectProfile(['applicant_name', 'mobile_phone', 'license_plate', 'priority'])).toEqual({ ok: true, profile: 'roster' })
  })
  it('reason_type only → p2_application', () => {
    expect(detectProfile(['applicant_name', 'mobile_phone', 'license_plate', 'reason_type'])).toEqual({ ok: true, profile: 'p2_application' })
  })
  it('both discriminators → ambiguous_profile (fail closed)', () => {
    expect(detectProfile(['priority', 'reason_type'])).toEqual({ ok: false, code: 'ambiguous_profile' })
  })
  it('neither → missing_headers', () => {
    expect(detectProfile(['applicant_name', 'mobile_phone'])).toEqual({ ok: false, code: 'missing_headers' })
  })
  it('parseCsv throws ambiguous_profile when a file has both discriminators', () => {
    expect(() => parseCsv('applicant_name,mobile_phone,license_plate,priority,reason_type\n王,0912345678,ABC,P3,1'))
      .toThrowError(expect.objectContaining({ code: 'ambiguous_profile' }))
  })
  it('parses a Chinese roster template → roster profile with canonical keys', () => {
    const { rows, profile } = parseCsv('姓名,手機,車牌,優先序,P2事由,備註\n王小明,0912345678,ABC1234,P3,,')
    expect(profile).toBe('roster')
    expect(rows[0]).toMatchObject({ applicant_name: '王小明', mobile_phone: '0912345678', license_plate: 'ABC1234', priority: 'P3' })
  })
})

describe('REASON_ALIASES (#20)', () => {
  it('covers the five church labels → canonical p2_reason', () => {
    expect(REASON_ALIASES).toMatchObject({
      行動不便: 'mobility_long', 短期不便: 'mobility_short', 幼兒同行: 'child_companion',
      孕婦: 'pregnancy', 長者同行: 'elderly_companion',
    })
  })
})

describe('parseMobilePhone (#22)', () => {
  it.each([
    ['0912345678', '0912345678'],   // 10-digit accepted
    ['0912-345-678', '0912345678'], // punctuation stripped
    ['912345678', '0912345678'],    // 9-digit → single leading 0 restored
  ])('accepts %s → %s', (raw, canonical) => {
    expect(parseMobilePhone(raw)).toEqual({ ok: true, phone: canonical })
  })
  it.each([
    ['9.12346E+8', 'scientific_notation'], // Excel rounded — rejected, not reconstructed
    ['1.2e3', 'scientific_notation'],
    ['', 'missing'],
    ['   ', 'missing'],
    ['1', 'invalid'],
    ['0212345678', 'invalid'],       // landline-style
    ['+886912345678', 'invalid'],    // +886 not supported yet (backlog)
    ['886912345678', 'invalid'],     // 886 prefix — length alone must not accept it
  ])('rejects %s with code %s', (raw, code) => {
    expect(parseMobilePhone(raw)).toEqual({ ok: false, code })
  })
})

describe('deriveRosterEligibility (#21)', () => {
  const NOW_ = new Date('2026-07-16T20:00:00Z') // 2026-07-17 04:00 Taipei
  it('permanent reasons take effect immediately', () => {
    expect(deriveRosterEligibility('mobility_long', NOW_)).toMatchObject({ reviewRequired: false, valid_until: null, review_date: null })
    expect(deriveRosterEligibility('elderly_companion', NOW_)).toMatchObject({ reviewRequired: false, review_date: null })
  })
  it('windowed reasons are review-required with the Taipei date (never guessing an end date)', () => {
    for (const r of ['mobility_short', 'pregnancy', 'child_companion'] as const) {
      expect(deriveRosterEligibility(r, NOW_)).toEqual({ p2_reason: r, valid_until: null, review_date: '2026-07-17', reviewRequired: true })
    }
  })
})
