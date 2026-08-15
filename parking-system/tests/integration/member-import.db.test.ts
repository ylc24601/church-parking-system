import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CsvImportExecutionError } from '@/server/services/memberImportService'

// Phase 6 — member import end-to-end (synthetic CSV → users/vehicles/eligibility/dependents)
// against local Supabase. Gated: `RUN_DB_TESTS=1` + reachable local DB (prereq: `npm run db:reset`).
try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may already be exported */
}
const RUN = process.env.RUN_DB_TESTS === '1'

type Sb = import('@supabase/supabase-js').SupabaseClient

const FIXTURE = fileURLToPath(new URL('../fixtures/members-sample.csv', import.meta.url))
const PHONES = ['0955000001', '0955000002', '0955000003', '0955000004', '0955000005', '0955000007', '0955000008', '0955000009']

describe.skipIf(!RUN)('member import (Phase 6) — local DB integration', () => {
  let sb: Sb
  let repo: import('@/server/repositories/parkingRepository').ParkingRepository
  let importMembersFromCsv: typeof import('@/server/services/memberImportService').importMembersFromCsv
  let importMembersFromCsvText: typeof import('@/server/services/memberImportService').importMembersFromCsvText

  const userByPhone = async (phone: string) =>
    (await sb.from('users').select('id, display_name').eq('phone_number', phone).maybeSingle()).data as { id: string; display_name: string } | null
  const eligibilityOf = async (userId: string) =>
    (await sb.from('user_eligibility').select('*').eq('user_id', userId).single()).data!
  const vehiclesOf = async (userId: string) =>
    (await sb.from('vehicles').select('license_plate_normalized').eq('user_id', userId)).data as Array<{ license_plate_normalized: string }>
  const dependentsOf = async (userId: string) =>
    (await sb.from('eligibility_dependents').select('dependent_kind, dependent_name').eq('user_id', userId)).data as Array<{ dependent_kind: string; dependent_name: string }>

  const cleanup = async () => {
    const { data: us } = await sb.from('users').select('id').in('phone_number', PHONES)
    for (const u of (us ?? []) as Array<{ id: string }>) {
      await sb.from('vehicles').delete().eq('user_id', u.id) // vehicles have no ON DELETE CASCADE
    }
    await sb.from('users').delete().in('phone_number', PHONES) // cascades eligibility + dependents
  }

  beforeAll(async () => {
    sb = (await import('@/lib/supabase/server')).getServiceClient()
    repo = (await import('@/server/repositories/parkingRepository')).createParkingRepository(sb)
    ;({ importMembersFromCsv, importMembersFromCsvText } = await import('@/server/services/memberImportService'))
    await cleanup()
  })

  afterAll(async () => {
    if (!RUN) return
    await cleanup()
  })

  it('dry-run projects but writes nothing', async () => {
    const report = await importMembersFromCsv({ filePath: FIXTURE, dryRun: true }, repo)
    expect(report.members).toBe(7)                          // 7 distinct phones (2 rows for 04 and 08 collapse)
    expect(report.phoneNameConflicts).toHaveLength(1)       // phone …08, two names
    expect(report.validationErrors).toHaveLength(0)
    // nothing written
    for (const p of PHONES) expect(await userByPhone(p)).toBeNull()
  })

  it('apply writes members/vehicles/eligibility/dependents and reports conflicts', async () => {
    const report = await importMembersFromCsv({ filePath: FIXTURE, dryRun: false }, repo)
    expect(report).toMatchObject({
      members: 7, imported: 6, updated: 0, vehiclesAdded: 7, dependentsAdded: 6,
    })
    expect(report.phoneNameConflicts).toHaveLength(1)       // …08 different names → skipped
    expect(report.plateConflicts).toHaveLength(0)           // no in-file plate collision in the fixture
    expect(report.batchPlateConflicts).toHaveLength(0)
    expect(report.reviewRequired).toHaveLength(0)

    // mobility_short window = application_date + 6 months
    const m2 = (await userByPhone('0955000002'))!
    expect(await eligibilityOf(m2.id)).toMatchObject({ p2_eligible: true, p2_reason: 'mobility_short', p2_valid_until: '2026-08-10' })

    // child_companion: one member, TWO vehicles, 2 dependents. valid_until follows the
    // YOUNGEST child's school-entry cohort since Wave 2B-2a (#10): born 2024-08-15, before
    // the 9/1 cutoff, so 2024 + 6 → 2030-08-31 (was max(birthdate)+5y = 2029-08-15).
    // p2_child_birthdate records the source the date was derived from.
    const m4 = (await userByPhone('0955000004'))!
    expect((await vehiclesOf(m4.id)).map(v => v.license_plate_normalized).sort()).toEqual(['TEST4004', 'TEST4040'])
    expect(await eligibilityOf(m4.id)).toMatchObject({
      p2_reason: 'child_companion', p2_valid_until: '2030-08-31', p2_child_birthdate: '2024-08-15',
    })
    expect((await dependentsOf(m4.id)).filter(d => d.dependent_kind === 'child')).toHaveLength(2)

    // pregnancy: 6-month window, no dependents
    const m5 = (await userByPhone('0955000005'))!
    expect(await eligibilityOf(m5.id)).toMatchObject({ p2_reason: 'pregnancy', p2_valid_until: '2026-11-01' })
    expect(await dependentsOf(m5.id)).toHaveLength(0)

    // mobility_long is permanent
    const m1 = (await userByPhone('0955000001'))!
    expect(await eligibilityOf(m1.id)).toMatchObject({ p2_reason: 'mobility_long', p2_valid_until: null })

    // phone-name conflict member was NOT created
    expect(await userByPhone('0955000008')).toBeNull()

    // …09 is a legitimate elderly member with its own vehicle
    const m7 = (await userByPhone('0955000009'))!
    expect(m7.display_name).toBe('測試庚')
    expect((await vehiclesOf(m7.id)).map(v => v.license_plate_normalized)).toEqual(['TEST9009'])
    expect(await eligibilityOf(m7.id)).toMatchObject({ p2_reason: 'elderly_companion', p2_valid_until: null })
  })

  it('re-apply is idempotent: 0 new users/vehicles/dependents', async () => {
    const report = await importMembersFromCsv({ filePath: FIXTURE, dryRun: false }, repo)
    expect(report).toMatchObject({ imported: 0, updated: 6, vehiclesAdded: 0, dependentsAdded: 0 })
    expect(report.phoneNameConflicts).toHaveLength(1)
    expect(report.plateConflicts).toHaveLength(0)
  })

  it('a plate already owned by another member in the DB is reported as plateConflict (not stolen)', async () => {
    // …01 owns TEST1001 (imported above). A new member claiming it → DB plate_conflict, member kept,
    // vehicle not created, ownership unchanged. (This is the DB-owner path, distinct from a same-file
    // batch collision which the service preflight handles.)
    const csv = 'application_date,applicant_name,license_plate,mobile_phone,reason_type,impaired_person_name\n2026-07-01,測試辛,TEST-1001,0955000007,1,測試辛'
    const report = await importMembersFromCsvText({ csvText: csv, dryRun: false }, repo)
    expect(report.imported).toBe(1)
    expect(report.plateConflicts).toEqual([{ phone: '0955000007', plates: ['TEST1001'] }])
    const m8 = (await userByPhone('0955000007'))!
    expect(await vehiclesOf(m8.id)).toHaveLength(0)
    const owner = (await sb.from('vehicles').select('user_id').eq('license_plate_normalized', 'TEST1001').single()).data as { user_id: string }
    expect(owner.user_id).toBe((await userByPhone('0955000001'))!.id)
  })

  it('the text variant produces the same report as the file-path wrapper (same DB state)', async () => {
    const csvText = readFileSync(FIXTURE, 'utf8')
    const viaText = await importMembersFromCsvText({ csvText, dryRun: true }, repo)
    const viaFile = await importMembersFromCsv({ filePath: FIXTURE, dryRun: true }, repo)
    expect(viaText).toEqual(viaFile)
  })

  it('a mid-apply failure throws typed partial_apply, leaving the members processed so far written', async () => {
    await cleanup()
    const csvText = readFileSync(FIXTURE, 'utf8')

    // Fail the 3rd importMember call; the first two members must already be committed.
    let calls = 0
    const throwingRepo = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === 'importMember') {
          return async (args: Parameters<typeof target.importMember>[0]) => {
            calls++
            if (calls === 3) throw new Error('simulated DB failure')
            return target.importMember(args)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })

    let thrown: unknown
    try {
      await importMembersFromCsvText({ csvText, dryRun: false }, throwingRepo)
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(CsvImportExecutionError)
    expect((thrown as CsvImportExecutionError).processedMembers).toBe(2)

    // Exactly the two members written before the failure exist.
    const { data: written } = await sb.from('users').select('id').in('phone_number', PHONES)
    expect((written ?? []).length).toBe(2)

    await cleanup()
  })
})

// Wave 0 (#21) — general roster import: P1/P3 write user+vehicles with NO eligibility (import_member
// null-reason path, migration 0029); P2 writes a review-required eligibility; a P1/P3 row NEVER
// revokes an existing member's P2 (retained_p2, works the same in dry-run and apply).
describe.skipIf(!RUN)('roster import (Wave 0 #21) — local DB integration', () => {
  let sb: Sb
  let repo: import('@/server/repositories/parkingRepository').ParkingRepository
  let importMembersFromCsvText: typeof import('@/server/services/memberImportService').importMembersFromCsvText

  const ROSTER_PHONES = ['0955001001', '0955001002', '0955001003', '0955001004']
  const userByPhone = async (phone: string) =>
    (await sb.from('users').select('id, display_name').eq('phone_number', phone).maybeSingle()).data as { id: string; display_name: string } | null
  const eligRow = async (userId: string) =>
    (await sb.from('user_eligibility').select('*').eq('user_id', userId).maybeSingle()).data as Record<string, unknown> | null
  const vehiclesOf = async (userId: string) =>
    (await sb.from('vehicles').select('license_plate_normalized').eq('user_id', userId)).data as Array<{ license_plate_normalized: string }>

  const cleanup = async () => {
    const { data: us } = await sb.from('users').select('id').in('phone_number', ROSTER_PHONES)
    for (const u of (us ?? []) as Array<{ id: string }>) {
      await sb.from('vehicles').delete().eq('user_id', u.id)
    }
    await sb.from('users').delete().in('phone_number', ROSTER_PHONES)
  }

  const ROSTER_CSV = [
    '姓名,手機,車牌,優先序,P2事由',
    '甲,0955001001,ROST1001,P3,',
    '乙,0955001002,ROST1002,P2,孕婦',
    '丙,0955001003,ROST1003,P1,',
  ].join('\n')

  beforeAll(async () => {
    sb = (await import('@/lib/supabase/server')).getServiceClient()
    repo = (await import('@/server/repositories/parkingRepository')).createParkingRepository(sb)
    ;({ importMembersFromCsvText } = await import('@/server/services/memberImportService'))
    await cleanup()
  })

  afterAll(async () => {
    if (!RUN) return
    await cleanup()
  })

  it('P3/P1 create user+vehicle with NO eligibility; P2 creates a review-required eligibility', async () => {
    const report = await importMembersFromCsvText({ csvText: ROSTER_CSV, dryRun: false }, repo)
    expect(report).toMatchObject({ members: 3, imported: 3, updated: 0, vehiclesAdded: 3, dependentsAdded: 0 })
    expect(report.reviewRequired).toEqual([{ phone: '0955001002', reason: 'pregnancy' }])

    const p3 = (await userByPhone('0955001001'))!
    expect(await eligRow(p3.id)).toBeNull() // P3: no eligibility row
    expect(await vehiclesOf(p3.id)).toHaveLength(1)

    const p1 = (await userByPhone('0955001003'))!
    expect(await eligRow(p1.id)).toBeNull() // P1: general member only, no eligibility

    const p2 = (await userByPhone('0955001002'))!
    expect(await eligRow(p2.id)).toMatchObject({ p2_eligible: true, p2_reason: 'pregnancy', p2_valid_until: null })
    expect((await eligRow(p2.id))!.p2_review_date).not.toBeNull() // Taipei day of apply
  })

  it('re-importing an existing P2 member as P3 keeps eligibility (retained_p2, not revoked); dry-run == apply', async () => {
    const csv = '姓名,手機,車牌,優先序\n乙,0955001002,ROST1002,P3'
    const dry = await importMembersFromCsvText({ csvText: csv, dryRun: true }, repo)
    expect(dry.p2Retained).toEqual([{ phone: '0955001002' }])

    const report = await importMembersFromCsvText({ csvText: csv, dryRun: false }, repo)
    expect(report.updated).toBe(1)
    expect(report.p2Retained).toEqual([{ phone: '0955001002' }])

    // eligibility is untouched — the roster import never revokes an existing P2.
    const p2 = (await userByPhone('0955001002'))!
    expect(await eligRow(p2.id)).toMatchObject({ p2_eligible: true, p2_reason: 'pregnancy' })
  })

  // ── Wave 2B-2a (#10): the mirror image of retained_p2 ─────────────────────────
  // 0029:9 promised import never REVOKES. It said nothing about import silently
  // RE-GRANTING, and it did: `on conflict do update set p2_eligible = true` flipped a
  // revoked member straight back to eligible, wiping an audited human decision with no
  // audit row of its own. Import may ESTABLISH eligibility; it may not overturn a review.
  it('a CSV cannot resurrect an eligibility a 幹事 revoked (retained_revoked); dry-run == apply', async () => {
    const p2 = (await userByPhone('0955001002'))!
    await sb.from('user_eligibility')
      .update({ review_status: 'revoked', p2_valid_until: '2030-01-01' })
      .eq('user_id', p2.id).throwOnError()

    const csv = '姓名,手機,車牌,優先序,P2事由\n乙,0955001002,ROST1002,P2,孕婦'

    const dry = await importMembersFromCsvText({ csvText: csv, dryRun: true }, repo)
    expect(dry.revokedRetained).toEqual([{ phone: '0955001002' }])
    // The preview must not promise dependent writes that apply won't make.
    expect(dry.dependentsAdded).toBe(0)

    const report = await importMembersFromCsvText({ csvText: csv, dryRun: false }, repo)
    expect(report.revokedRetained).toEqual([{ phone: '0955001002' }])
    expect(report.totals.revokedRetained).toBe(1)

    // The row is untouched — not merely "still revoked". A re-approve that also reset the
    // dates would be just as much an overturned decision.
    const after = (await eligRow(p2.id))!
    expect(after).toMatchObject({ review_status: 'revoked', p2_eligible: false, p2_valid_until: '2030-01-01' })
  })

  it('an UNREVIEWED member listed as P2 is approved normally — only revoke is protected', async () => {
    // The complement, and the reason 0032's enum needed three states: if legacy non-P2
    // rows had been backfilled to 'revoked', this member would be permanently locked out
    // of the roster's reach and a 幹事 would have to re-approve them by hand.
    const p3 = (await userByPhone('0955001001'))!
    await sb.from('user_eligibility')
      .insert({ user_id: p3.id, review_status: 'unreviewed', p2_reason: null }).throwOnError()

    const csv = '姓名,手機,車牌,優先序,P2事由\n甲,0955001001,ROST1001,P2,孕婦'
    const report = await importMembersFromCsvText({ csvText: csv, dryRun: false }, repo)
    expect(report.revokedRetained).toEqual([])
    expect(await eligRow(p3.id)).toMatchObject({ review_status: 'approved', p2_eligible: true, p2_reason: 'pregnancy' })
  })

  it('import never claims a human reviewed anything', async () => {
    // A roster import is not a named review, so reviewed_by/at stay null and 「最近覆核」
    // honestly renders as —. Writing them here would forge a review that never happened.
    const p2 = (await userByPhone('0955001002'))!
    const row = (await eligRow(p2.id))!
    expect(row.reviewed_by).toBeNull()
    expect(row.reviewed_at).toBeNull()
  })

  // ── Wave 2B-2b (#10): import precedence ──────────────────────────────────────
  // 0032 stopped import RESURRECTING a revoked row. This is the broader half: once a 幹事 can
  // hand-set a period, `on conflict do update` would silently reset it — and import writes no
  // audit row of its own. CSV may ESTABLISH an eligibility nobody decided on; it may not
  // OVERWRITE one somebody did. The boundary is `reviewed_at is not null`.
  describe('a hand-reviewed row is frozen against the CSV', () => {
    let adminId: string
    let governed: string

    beforeAll(async () => {
      if (!RUN) return
      const { data } = await sb.from('admin_accounts')
        .insert({ username: `imp-gov-${Date.now().toString(36)}`, password_hash: 'scrypt$notarealhash' })
        .select('id').single()
      adminId = (data as { id: string }).id

      // A member the CSV created (approved, but NOT governed — no human has decided).
      await importMembersFromCsvText({
        csvText: '姓名,手機,車牌,優先序,P2事由\n丁,0955001004,ROST1004,P2,孕婦',
        dryRun: false,
      }, repo)
      governed = (await userByPhone('0955001004'))!.id
    })

    afterAll(async () => {
      if (RUN && adminId) {
        await sb.from('user_eligibility').update({ reviewed_by: null, reviewed_at: null }).eq('user_id', governed)
        await sb.from('admin_accounts').delete().eq('id', adminId)
      }
    })

    it('BEFORE a human reviews it, the CSV still refreshes it', async () => {
      // The complement that makes the freeze meaningful: import is not blanket-blocked, it is
      // blocked only where a human has decided. Without this the rule would just be "import
      // stops working".
      const report = await importMembersFromCsvText({
        csvText: '姓名,手機,車牌,優先序,P2事由\n丁,0955001004,ROST1004,P2,行動不便',
        dryRun: false,
      }, repo)
      expect(report.governedRetained).toEqual([])
      expect(await eligRow(governed)).toMatchObject({ p2_reason: 'mobility_long' })
    })

    it('AFTER a human reviews it, the CSV is refused and says so', async () => {
      const { data: sess } = await sb.from('admin_sessions').select('id').limit(1)
      void sess
      // Cross the governance boundary the way the RPC does.
      const res = await repo.setP2Eligibility({
        userId: governed, expectedVersion: 0, reviewStatus: 'approved', reason: 'elderly_companion',
        validFrom: null, validUntil: '2099-03-03', childBirthdate: null,
        nextReviewDate: '2099-02-02', note: '同工手動核定',
        actingAdminId: adminId, actingSessionId: '22222222-2222-4222-8222-222222222222',
        requestId: randomUUID(),
      })
      expect(res.ok).toBe(true)
      const before = (await eligRow(governed))!

      const csv = '姓名,手機,車牌,優先序,P2事由\n丁,0955001004,ROST1004,P2,孕婦'
      const dry = await importMembersFromCsvText({ csvText: csv, dryRun: true }, repo)
      expect(dry.governedRetained).toEqual([{ phone: '0955001004' }])

      const report = await importMembersFromCsvText({ csvText: csv, dryRun: false }, repo)
      expect(report.governedRetained).toEqual([{ phone: '0955001004' }])
      expect(report.totals.governedRetained).toBe(1)
      expect(report.revokedRetained).toEqual([])   // the more specific bucket must not fire

      // Byte-for-byte: not merely "still approved". A refresh that reset the dates would be
      // just as much an overturned decision as a status flip.
      const after = (await eligRow(governed))!
      expect(after).toMatchObject({
        review_status: before.review_status,
        p2_reason: 'elderly_companion',
        p2_valid_until: '2099-03-03',
        p2_review_date: '2099-02-02',
        review_note: '同工手動核定',
        review_version: before.review_version,
      })
    })

    it('a governed member still gets name and vehicle updates — those are not governance', async () => {
      const report = await importMembersFromCsvText({
        csvText: '姓名,手機,車牌,優先序,P2事由\n丁,0955001004,NEWCAR9,P2,孕婦',
        dryRun: false,
      }, repo)
      expect(report.governedRetained).toEqual([{ phone: '0955001004' }])
      expect((await vehiclesOf(governed)).map(v => v.license_plate_normalized).sort())
        .toEqual(['NEWCAR9', 'ROST1004'])
    })

    it('a governed member\'s dependents are frozen too, and dry-run says so', async () => {
      // eligibility_dependents IS the evidence p2_child_birthdate derives from. Writing
      // dependents while freezing the source would let max(child birthdate) and the stored
      // source disagree — the dual truth #10 exists to kill.
      const csv = [
        '姓名,手機,車牌,申請原因,備註,申請日期,孩童姓名1,孩童生日1',
        '丁,0955001004,ROST1004,3,,2026-01-01,小明,2022-03-01',
      ].join('\n')
      const dry = await importMembersFromCsvText({ csvText: csv, dryRun: true }, repo)
      expect(dry.governedRetained).toEqual([{ phone: '0955001004' }])
      expect(dry.dependentsAdded).toBe(0)   // dry-run must not promise what apply won't do

      const report = await importMembersFromCsvText({ csvText: csv, dryRun: false }, repo)
      expect(report.dependentsAdded).toBe(0)
      const { data: deps } = await sb.from('eligibility_dependents').select('id').eq('user_id', governed)
      expect(deps).toHaveLength(0)
    })
  })
})

// ── Tier 0-2 (0038): the identity guard, end to end through the real RPC ─────────
// The CSV keys members by PHONE. Before this guard, a member whose phone changed came back
// from the next import as a SECOND users.id — holding none of their LINE binding, history,
// penalties or eligibility, and with no merge tool anywhere in the system to undo it.
describe.skipIf(!RUN)('member import — identity guard (Tier 0-2) — local DB integration', () => {
  let sb: Sb
  let repo: import('@/server/repositories/parkingRepository').ParkingRepository
  let importMembersFromCsvText: typeof import('@/server/services/memberImportService').importMembersFromCsvText

  const OLD_PHONE = '0955002001'
  const NEW_PHONE = '0955002002'
  const OTHER = '0955002003'
  const IDENT_PHONES = [OLD_PHONE, NEW_PHONE, OTHER]
  const NAME = '身分守衛甲'

  const cleanup = async () => {
    const { data: us } = await sb.from('users').select('id').in('phone_number', IDENT_PHONES)
    for (const u of (us ?? []) as Array<{ id: string }>) {
      await sb.from('vehicles').delete().eq('user_id', u.id)
    }
    await sb.from('users').delete().in('phone_number', IDENT_PHONES)
  }

  beforeAll(async () => {
    sb = (await import('@/lib/supabase/server')).getServiceClient()
    repo = (await import('@/server/repositories/parkingRepository')).createParkingRepository(sb)
    ;({ importMembersFromCsvText } = await import('@/server/services/memberImportService'))
    await cleanup()
    await sb.from('users').insert({ display_name: NAME, phone_number: OLD_PHONE }).throwOnError()
  })

  afterAll(async () => {
    if (!RUN) return
    await cleanup()
  })

  it('a same-name row with a NEW phone is refused, and reported as an identity question', async () => {
    const report = await importMembersFromCsvText({
      csvText: `姓名,手機,車牌,優先序,P2事由\n${NAME},${NEW_PHONE},IDNT2001,P3,`,
      dryRun: false,
    }, repo)

    expect(report.identityConflicts).toHaveLength(1)
    expect(report.identityConflicts[0]).toMatchObject({ phone: NEW_PHONE, name: NAME })
    // The candidate is a member NOT in this file — the operator gets enough to recognise
    // them, not their full number.
    expect(report.identityConflicts[0].candidates[0].phoneMasked).not.toBe(OLD_PHONE)
    expect(JSON.stringify(report)).not.toContain(OLD_PHONE)
    // Distinct from the OLD conflict kind, whose meaning is the opposite ("this file is
    // probably wrong" vs "this member probably changed their number").
    expect(report.phoneNameConflicts).toHaveLength(0)

    // Nothing written: no second identity, and the original is untouched.
    expect(report.imported).toBe(0)
    const { data: rows } = await sb.from('users').select('id').in('phone_number', IDENT_PHONES)
    expect(rows).toHaveLength(1)
  })

  it('the whitespace/case a spreadsheet adds does not slip past the guard', async () => {
    // The realistic version of this bug: a pasted cell carrying U+3000 or a trailing space.
    // A byte-comparison would let it through and create the duplicate.
    const report = await importMembersFromCsvText({
      csvText: `姓名,手機,車牌,優先序,P2事由\n${NAME[0]}　${NAME.slice(1)} ,${NEW_PHONE},IDNT2002,P3,`,
      dryRun: true,
    }, repo)
    expect(report.identityConflicts).toHaveLength(1)
    expect(report.imported).toBe(0)
  })

  it('a genuinely different name with a new phone still imports', async () => {
    // The guard must not become a wall: it fires on NAME collision, not on "new phone".
    const report = await importMembersFromCsvText({
      csvText: `姓名,手機,車牌,優先序,P2事由\n身分守衛乙,${OTHER},IDNT2003,P3,`,
      dryRun: false,
    }, repo)
    expect(report.identityConflicts).toHaveLength(0)
    expect(report.imported).toBe(1)
  })

  it('the same member under their EXISTING phone still updates in place', async () => {
    // The phone-keyed happy path is untouched: same phone, same name → update, one row.
    const report = await importMembersFromCsvText({
      csvText: `姓名,手機,車牌,優先序,P2事由\n${NAME},${OLD_PHONE},IDNT2004,P3,`,
      dryRun: false,
    }, repo)
    expect(report.updated).toBe(1)
    expect(report.identityConflicts).toHaveLength(0)
    const { data: rows } = await sb.from('users').select('id').eq('phone_number', OLD_PHONE)
    expect(rows).toHaveLength(1)
  })
})
