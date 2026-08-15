import { describe, expect, it, vi } from 'vitest'
import { importMembersFromCsvText } from '@/server/services/memberImportService'
import type { ParkingRepository } from '@/server/repositories/parkingRepository'

// Wave 0 (#20/#21/#22) — the service pipeline over a mock repo: profile branch (roster P1/P3 →
// reason=null, P2 → canonical reason), group consistency, row-completeness, batch-local plate
// preflight, and the p2Retained warning. importMembersFromCsvText only ever calls repo.importMember.

type ImportArgs = Parameters<ParkingRepository['importMember']>[0]

function mockRepo(override?: ParkingRepository['importMember']): { repo: ParkingRepository; calls: ImportArgs[] } {
  const calls: ImportArgs[] = []
  const importMember: ParkingRepository['importMember'] =
    override ??
    (async (args: ImportArgs) => {
      calls.push(args)
      return { status: 'imported', vehicles_added: args.plates.length, dependents_added: 0, plate_conflicts: [] }
    })
  return { repo: { importMember } as unknown as ParkingRepository, calls }
}

const NOW = new Date('2026-07-16T20:00:00Z') // 2026-07-17 Taipei

describe('importMembersFromCsvText — profiles', () => {
  it('roster: P3 and P1 pass reason=null (no eligibility); P2 passes a canonical reason', async () => {
    const csv = [
      '姓名,手機,車牌,優先序,P2事由',
      '甲,0912345678,AAA1111,P3,',
      '乙,0922333444,BBB2222,P2,長者同行',
      '丙,0933555777,CCC3333,P1,',
    ].join('\n')
    const { repo, calls } = mockRepo()
    const report = await importMembersFromCsvText({ csvText: csv, dryRun: false, now: NOW }, repo)
    expect(report.imported).toBe(3)
    const byPhone = Object.fromEntries(calls.map(c => [c.phone, c]))
    expect(byPhone['0912345678'].reason).toBeNull() // P3
    expect(byPhone['0933555777'].reason).toBeNull() // P1
    expect(byPhone['0922333444'].reason).toBe('elderly_companion') // P2
  })

  it('roster P2 with a windowed reason is review-required', async () => {
    const csv = '姓名,手機,車牌,優先序,P2事由\n甲,0912345678,AAA1111,P2,孕婦'
    const { repo } = mockRepo()
    const report = await importMembersFromCsvText({ csvText: csv, dryRun: true, now: NOW }, repo)
    expect(report.reviewRequired).toEqual([{ phone: '0912345678', reason: 'pregnancy' }])
  })

  it('p2_application coexists: numeric 申請原因 + eligibility computed', async () => {
    const csv = '申請日期,申請人姓名,車牌號碼,手機號碼,申請原因,長者姓名,長者生日\n2026-01-05,林,DEF5678,0912345678,4,林母,1945/06/01'
    const { repo, calls } = mockRepo()
    const report = await importMembersFromCsvText({ csvText: csv, dryRun: true, now: NOW }, repo)
    expect(report.imported).toBe(1)
    expect(calls[0].reason).toBe('elderly_companion')
  })

  it('9-digit phone is restored to the canonical key and used for grouping', async () => {
    const csv = '姓名,手機,車牌,優先序\n甲,912345678,AAA1111,P3\n甲,912345678,BBB2222,P3'
    const { repo, calls } = mockRepo()
    const report = await importMembersFromCsvText({ csvText: csv, dryRun: true, now: NOW }, repo)
    expect(report.members).toBe(1) // grouped on the restored 0912345678
    expect(calls[0].phone).toBe('0912345678')
    expect([...calls[0].plates].sort()).toEqual(['AAA1111', 'BBB2222'])
  })

  it('batch-local plate conflict: same plate, two phones → both skipped, reported separately', async () => {
    const csv = '姓名,手機,車牌,優先序\n甲,0912345678,SAME1,P3\n乙,0922333444,SAME1,P3'
    const { repo, calls } = mockRepo()
    const report = await importMembersFromCsvText({ csvText: csv, dryRun: true, now: NOW }, repo)
    expect(calls).toHaveLength(0) // neither imported (fail closed)
    expect(report.imported).toBe(0)
    expect(report.batchPlateConflicts).toHaveLength(1)
    expect(report.batchPlateConflicts[0].plate).toBe('SAME1')
    expect([...report.batchPlateConflicts[0].phones].sort()).toEqual(['0912345678', '0922333444'])
    expect(report.plateConflicts).toHaveLength(0) // distinct from the DB-conflict list
  })

  it('same phone with inconsistent priority → whole member skipped (groupConflicts)', async () => {
    const csv = '姓名,手機,車牌,優先序,P2事由\n甲,0912345678,AAA1111,P2,長者同行\n甲,0912345678,BBB2222,P3,'
    const { repo, calls } = mockRepo()
    const report = await importMembersFromCsvText({ csvText: csv, dryRun: true, now: NOW }, repo)
    expect(calls).toHaveLength(0)
    expect(report.groupConflicts).toEqual([{ phone: '0912345678', field: 'priority', values: ['P2', 'P3'] }])
  })

  it('same phone with inconsistent roster 事由 → groupConflicts field reason_label', async () => {
    const csv = '姓名,手機,車牌,優先序,P2事由\n甲,0912345678,AAA1111,P2,長者同行\n甲,0912345678,BBB2222,P2,孕婦'
    const { repo, calls } = mockRepo()
    const report = await importMembersFromCsvText({ csvText: csv, dryRun: true, now: NOW }, repo)
    expect(calls).toHaveLength(0)
    expect(report.groupConflicts).toEqual([
      { phone: '0912345678', field: 'reason_label', values: ['elderly_companion', 'pregnancy'] },
    ])
  })

  it('row-completeness: one valid + one invalid row for a phone → whole member skipped', async () => {
    const csv = '姓名,手機,車牌,優先序,P2事由\n甲,0912345678,AAA1111,P2,長者同行\n甲,0912345678,BBB2222,P2,亂寫'
    const { repo, calls } = mockRepo()
    const report = await importMembersFromCsvText({ csvText: csv, dryRun: true, now: NOW }, repo)
    expect(calls).toHaveLength(0) // never silently import only the valid row
    expect(report.validationErrors.length).toBeGreaterThanOrEqual(1)
  })

  it('row-completeness also holds for an over-long-cell row (every reject path taints the member)', async () => {
    const long = 'x'.repeat(600) // > MAX_CELL_CODEPOINTS
    const csv = `姓名,手機,車牌,優先序,備註\n甲,0912345678,AAA1111,P3,ok\n甲,0912345678,BBB2222,P3,${long}`
    const { repo, calls } = mockRepo()
    const report = await importMembersFromCsvText({ csvText: csv, dryRun: true, now: NOW }, repo)
    expect(calls).toHaveLength(0) // the valid row must NOT import on its own
    expect(report.validationErrors.length).toBeGreaterThanOrEqual(1)
  })

  it('roster P1/P3 landing on an existing P2 member surfaces p2Retained (not revoked)', async () => {
    const csv = '姓名,手機,車牌,優先序\n甲,0912345678,AAA1111,P3'
    const { repo } = mockRepo(vi.fn(async () => ({
      status: 'updated' as const, vehicles_added: 0, dependents_added: 0, plate_conflicts: [], retained_p2: true,
    })))
    const report = await importMembersFromCsvText({ csvText: csv, dryRun: false, now: NOW }, repo)
    expect(report.p2Retained).toEqual([{ phone: '0912345678' }])
    expect(report.updated).toBe(1)
  })

  it('a P2 row landing on a REVOKED member surfaces revokedRetained (Wave 2B-2a)', async () => {
    // The RPC decides and reports; the service must SURFACE it. A refusal the operator
    // never sees is the same as a silent overwrite from their side of the screen.
    const csv = '姓名,手機,車牌,優先序,P2事由\n甲,0912345678,AAA1111,P2,孕婦'
    const { repo } = mockRepo(vi.fn(async () => ({
      status: 'updated' as const, vehicles_added: 0, dependents_added: 0, plate_conflicts: [],
      retained_revoked: true,
    })))
    const report = await importMembersFromCsvText({ csvText: csv, dryRun: false, now: NOW }, repo)
    expect(report.revokedRetained).toEqual([{ phone: '0912345678' }])
    expect(report.totals.revokedRetained).toBe(1)
    expect(report.p2Retained).toEqual([])   // the other direction must not fire
  })
})

// Wave 0.1 — a p2_application member spanning several rows (one per vehicle) must derive its
// eligibility from the WHOLE group; rows[0] must never decide, and bad input must never be
// silently swallowed as a missing value.
describe('importMembersFromCsvText — p2_application group consistency', () => {
  const HEAD = '申請日期,申請人姓名,車牌號碼,手機號碼,申請原因,行動不便者姓名,備註,孩童姓名1,孩童生日1'
  // date,name,plate,phone,reason,impaired,remarks,child1,child1bd
  const row = (o: Partial<Record<'date' | 'plate' | 'reason' | 'impaired' | 'remarks' | 'child' | 'childBd', string>>) =>
    [o.date ?? '2026-01-05', '王', o.plate ?? 'AAA1111', '0912345678', o.reason ?? '2',
      o.impaired ?? '王', o.remarks ?? '', o.child ?? '', o.childBd ?? ''].join(',')
  const csvOf = (...rows: string[]) => [HEAD, ...rows].join('\n')

  it('inconsistent 申請原因 → groupConflicts reason_type, member skipped', async () => {
    const { repo, calls } = mockRepo()
    const report = await importMembersFromCsvText(
      { csvText: csvOf(row({ reason: '2' }), row({ plate: 'BBB2222', reason: '1' })), dryRun: true, now: NOW }, repo)
    expect(calls).toHaveLength(0)
    expect(report.groupConflicts).toEqual([{ phone: '0912345678', field: 'reason_type', values: ['1', '2'] }])
  })

  it('申請日期 present but unparseable → row error and the WHOLE member is skipped', async () => {
    const { repo, calls } = mockRepo()
    const report = await importMembersFromCsvText(
      { csvText: csvOf(row({ date: '2026-01-05' }), row({ plate: 'BBB2222', date: '2026-99-99' })), dryRun: true, now: NOW }, repo)
    expect(calls).toHaveLength(0) // must NOT silently fall back to the valid row's date
    expect(report.validationErrors.some(v => v.errors.some(e => e.startsWith('invalid application_date')))).toBe(true)
  })

  it('the same day written two ways is consistent → imported with that date (+6 months)', async () => {
    const { repo, calls } = mockRepo()
    await importMembersFromCsvText(
      { csvText: csvOf(row({ date: '2026-01-05' }), row({ plate: 'BBB2222', date: '2026/01/05' })), dryRun: true, now: NOW }, repo)
    expect(calls).toHaveLength(1)
    expect(calls[0].validUntil).toBe('2026-07-05') // mobility_short = application_date + 6 months
  })

  it('blank 申請日期 is filled by the single valid one', async () => {
    const { repo, calls } = mockRepo()
    await importMembersFromCsvText(
      { csvText: csvOf(row({ date: '' }), row({ plate: 'BBB2222', date: '2026-01-05' })), dryRun: true, now: NOW }, repo)
    expect(calls).toHaveLength(1)
    expect(calls[0].validUntil).toBe('2026-07-05')
  })

  it('two different valid 申請日期 → groupConflicts application_date', async () => {
    const { repo, calls } = mockRepo()
    const report = await importMembersFromCsvText(
      { csvText: csvOf(row({ date: '2026-01-05' }), row({ plate: 'BBB2222', date: '2026-02-01' })), dryRun: true, now: NOW }, repo)
    expect(calls).toHaveLength(0)
    expect(report.groupConflicts).toEqual([
      { phone: '0912345678', field: 'application_date', values: ['2026-01-05', '2026-02-01'] },
    ])
  })

  it('reason 3: derived pregnancy flag disagrees → conflict reporting only controlled labels', async () => {
    const { repo, calls } = mockRepo()
    const report = await importMembersFromCsvText({
      csvText: csvOf(
        row({ reason: '3', remarks: '懷孕', impaired: '' }),
        row({ plate: 'BBB2222', reason: '3', remarks: '', impaired: '', child: '小明', childBd: '2022-03-01' }),
      ), dryRun: true, now: NOW,
    }, repo)
    expect(calls).toHaveLength(0)
    expect(report.groupConflicts).toEqual([{ phone: '0912345678', field: 'pregnancy', values: ['孕婦', '非孕婦'] }])
    // the raw remarks must never leak into the report values
    expect(JSON.stringify(report.groupConflicts)).not.toContain('懷孕')
  })

  it('reason 3: remarks differing verbatim but both non-pregnancy is NOT a conflict', async () => {
    const { repo, calls } = mockRepo()
    const report = await importMembersFromCsvText({
      csvText: csvOf(
        row({ reason: '3', remarks: '第一台車', impaired: '', child: '小明', childBd: '2022-03-01' }),
        row({ plate: 'BBB2222', reason: '3', remarks: '第二台車', impaired: '', child: '小明', childBd: '2022-03-01' }),
      ), dryRun: true, now: NOW,
    }, repo)
    expect(report.groupConflicts).toHaveLength(0)
    expect(calls).toHaveLength(1)
    expect(calls[0].reason).toBe('child_companion')
  })

  it('a dependent with a blank birthdate on one row is filled by the valid one', async () => {
    const { repo, calls } = mockRepo()
    await importMembersFromCsvText({
      csvText: csvOf(
        row({ reason: '3', impaired: '', child: '小明', childBd: '' }),
        row({ plate: 'BBB2222', reason: '3', impaired: '', child: '小明', childBd: '2022-03-01' }),
      ), dryRun: true, now: NOW,
    }, repo)
    expect(calls[0].dependents).toEqual([{ kind: 'child', name: '小明', birthdate: '2022-03-01' }])
    // The merged birthdate must actually reach the derivation, not just the dependent list:
    // born 2022-03-01 → before the 9/1 cutoff → enters school Sept 2028 → 2028-08-31.
    expect(calls[0].validUntil).toBe('2028-08-31')
  })

  it('the same dependent birthday written two ways collapses to one', async () => {
    const { repo, calls } = mockRepo()
    await importMembersFromCsvText({
      csvText: csvOf(
        row({ reason: '3', impaired: '', child: '小明', childBd: '2022-03-01' }),
        row({ plate: 'BBB2222', reason: '3', impaired: '', child: '小明', childBd: '2022/03/01' }),
      ), dryRun: true, now: NOW,
    }, repo)
    expect(calls[0].dependents).toEqual([{ kind: 'child', name: '小明', birthdate: '2022-03-01' }])
  })

  it('one dependent with two different birthdates → conflict naming the dependent', async () => {
    const { repo, calls } = mockRepo()
    const report = await importMembersFromCsvText({
      csvText: csvOf(
        row({ reason: '3', impaired: '', child: '小明', childBd: '2022-03-01' }),
        row({ plate: 'BBB2222', reason: '3', impaired: '', child: '小明', childBd: '2023-05-02' }),
      ), dryRun: true, now: NOW,
    }, repo)
    expect(calls).toHaveLength(0) // must not silently take max() and extend valid_until
    expect(report.groupConflicts).toEqual([{
      phone: '0912345678', field: 'dependent_birthdate', subject: 'child／小明',
      values: ['2022-03-01', '2023-05-02'],
    }])
  })

  it('a dependent birthdate present but unparseable → whole member skipped', async () => {
    const { repo, calls } = mockRepo()
    const report = await importMembersFromCsvText({
      csvText: csvOf(
        row({ reason: '3', impaired: '', child: '小明', childBd: '2022-03-01' }),
        row({ plate: 'BBB2222', reason: '3', impaired: '', child: '小明', childBd: '2022-99-99' }),
      ), dryRun: true, now: NOW,
    }, repo)
    expect(calls).toHaveLength(0)
    expect(report.validationErrors.some(v => v.errors.some(e => e.startsWith('invalid child_1_birthdate')))).toBe(true)
  })

  it('regression: a consistent multi-vehicle member still imports with deduped dependents', async () => {
    const { repo, calls } = mockRepo()
    const report = await importMembersFromCsvText({
      csvText: csvOf(
        row({ reason: '3', impaired: '', child: '小明', childBd: '2022-03-01' }),
        row({ plate: 'BBB2222', reason: '3', impaired: '', child: '小明', childBd: '2022-03-01' }),
      ), dryRun: true, now: NOW,
    }, repo)
    expect(report.groupConflicts).toHaveLength(0)
    expect(calls).toHaveLength(1)
    expect([...calls[0].plates].sort()).toEqual(['AAA1111', 'BBB2222'])
    expect(calls[0].dependents).toHaveLength(1) // one child, not two
  })
})

// ── Tier 0-2 (0038): the identity guard, seen from the import report ─────────────
// One status ('phone_name_conflict'), two kinds. They are separate report buckets because
// they demand opposite actions from the operator, and because folding them together would
// have made the new one invisible in an existing summary.
describe('importMembersFromCsvText — identity conflicts', () => {
  const csv = '姓名,手機,車牌,優先序,P2事由\n甲,0912345678,AAA1111,P3,\n'

  it('identity_candidate goes to its own bucket, with candidate phones MASKED', async () => {
    const { repo } = mockRepo(async () => ({
      status: 'phone_name_conflict' as const,
      conflict_kind: 'identity_candidate' as const,
      candidates: [
        { id: 'u-1', phone: '0955000111', evidence: 'same_name' as const },
        { id: 'u-2', phone: null, evidence: 'same_name_and_plate' as const },
      ],
    }))
    const report = await importMembersFromCsvText({ csvText: csv, dryRun: true, now: NOW }, repo)

    expect(report.phoneNameConflicts).toHaveLength(0)
    expect(report.identityConflicts).toEqual([{
      phone: '0912345678',   // the CSV's own number — the operator supplied this one
      name: '甲',
      candidates: [
        { phoneMasked: expect.not.stringContaining('0955000111'), evidence: 'same_name' },
        { phoneMasked: '—', evidence: 'same_name_and_plate' },
      ],
    }])
    expect(report.totals.identityConflicts).toBe(1)
    // The candidates are members who are NOT in this file. Their numbers were never in the
    // operator's hands, and the report must not put them there.
    expect(JSON.stringify(report)).not.toContain('0955000111')
    // Nothing was counted as written.
    expect(report.imported).toBe(0)
    expect(report.updated).toBe(0)
  })

  it('a MISSING conflict_kind means the original kind — an un-migrated DB still works', async () => {
    // Deployment case B (new app, old DB) for this one field: pre-0038 the RPC sends no
    // discriminant, and treating its absence as "unknown" would strand the conflict in
    // neither bucket.
    const { repo } = mockRepo(async () => ({
      status: 'phone_name_conflict' as const,
      existing_name: '既有姓名',
    }))
    const report = await importMembersFromCsvText({ csvText: csv, dryRun: true, now: NOW }, repo)

    expect(report.identityConflicts).toHaveLength(0)
    expect(report.phoneNameConflicts).toEqual([
      { phone: '0912345678', names: ['甲'], existingName: '既有姓名' },
    ])
    expect(report.totals.phoneNameConflicts).toBe(1)
  })
})
