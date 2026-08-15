import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from 'pg'
import { childCompanionValidUntil } from '@/lib/eligibilityStatus'

// Wave 2B-2b (#10) — the audited write path: 幹事 can approve/revoke P2 without a CSV, and a
// CSV can no longer overturn what they decided.
//
// Gated: `RUN_DB_TESTS=1` + reachable local Supabase (prereq: `npm run db:reset`).
try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may already be exported */
}
const RUN = process.env.RUN_DB_TESTS === '1'

const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const TAG = 'P2W-'
const SESSION = '22222222-2222-4222-8222-222222222222'
type Sb = import('@supabase/supabase-js').SupabaseClient

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

describe.skipIf(!RUN)('P2 eligibility writes (Wave 2B-2b / #10)', () => {
  let sb: Sb
  let pg: Client
  let admin: string
  const ids: string[] = []
  const adminIds: string[] = []

  const mkMember = async (label: string) => {
    const id = randomUUID()
    await sb.from('users').insert({ id, display_name: `${TAG}${label}` }).throwOnError()
    ids.push(id)
    return id
  }
  const eligOf = async (userId: string) =>
    (await sb.from('user_eligibility').select('*').eq('user_id', userId).maybeSingle()).data as Record<string, unknown> | null
  const auditOf = async (userId: string) =>
    (await sb.from('audit_logs').select('action, result, metadata_redacted')
      .eq('entity_id', userId).order('created_at', { ascending: true })).data as
      Array<{ action: string; result: string; metadata_redacted: Record<string, unknown> }>

  const setElig = (over: Record<string, unknown> = {}) => {
    const a = {
      userId: null as string | null, expectedVersion: 0, status: 'approved',
      reason: 'pregnancy', validFrom: null, validUntil: '2099-01-01',
      childBirthdate: null, nextReviewDate: '2098-12-01', note: null, ...over,
    }
    return pg.query(
      `select set_p2_eligibility($1,$2,$3,$4::p2_reason,$5,$6,$7,$8,$9,$10,$11,gen_random_uuid()) as r`,
      [a.userId, a.expectedVersion, a.status, a.reason, a.validFrom, a.validUntil,
       a.childBirthdate, a.nextReviewDate, a.note, admin, SESSION],
    ).then(r => r.rows[0].r as Record<string, unknown>)
  }
  const markReviewed = (userId: string, version: number, next: string) =>
    pg.query(`select mark_p2_reviewed($1,$2,$3,$4,$5,gen_random_uuid()) as r`, [userId, version, next, admin, SESSION])
      .then(r => r.rows[0].r as Record<string, unknown>)

  beforeAll(async () => {
    sb = (await import('@/lib/supabase/server')).getServiceClient()
    pg = new Client({ connectionString: DB_URL })
    await pg.connect()
    admin = (await pg.query(
      `insert into admin_accounts (username, password_hash) values ($1,'scrypt$notarealhash') returning id`,
      [`p2w-admin-${randomUUID().slice(0, 8)}`],
    )).rows[0].id
    adminIds.push(admin)
  })

  afterAll(async () => {
    if (RUN) {
      for (const id of ids) {
        await sb.from('user_eligibility').delete().eq('user_id', id)
        await sb.from('eligibility_dependents').delete().eq('user_id', id)
        await sb.from('users').delete().eq('id', id)
      }
      for (const id of adminIds) await sb.from('admin_accounts').delete().eq('id', id)
    }
    await pg?.end()
  })

  // ── The gap that would have sunk the slice ───────────────────────────────────
  describe('creating eligibility for a member who has none', () => {
    it('approves a GENERAL member — the whole point of #10', async () => {
      // A general member is a users row with NO user_eligibility row; that IS the
      // representation. An RPC that answered not_found here could only edit people a CSV had
      // already made P2 — i.e. 幹事 would still need the CSV, and the delivery blocker would
      // not have lifted at all.
      const id = await mkMember('Create')
      expect(await eligOf(id)).toBeNull()

      const r = await setElig({ userId: id })
      expect(r).toMatchObject({ ok: true, noop: false, review_version: 1 })

      const row = (await eligOf(id))!
      expect(row).toMatchObject({
        review_status: 'approved', p2_eligible: true, p2_reason: 'pregnancy',
        p2_valid_until: '2099-01-01', p2_review_date: '2098-12-01', review_version: 1,
      })
      // Governed in the SAME transaction: an approve IS a review, so import must not be able
      // to overwrite it a moment later.
      expect(row.reviewed_by).toBe(admin)
      expect(row.reviewed_at).not.toBeNull()

      const audit = await auditOf(id)
      expect(audit).toHaveLength(1)
      expect(audit[0]).toMatchObject({ action: 'p2_eligibility.review_update', result: 'success' })
      expect(audit[0].metadata_redacted).toMatchObject({ created: true, review_status_to: 'approved' })
    })

    it('refuses to revoke an eligibility that never existed', async () => {
      // Would otherwise mint a 'revoked' row asserting a human took away something nobody
      // ever granted — the same fabrication 0032's three-state enum refused to make.
      const id = await mkMember('RevokeNone')
      expect(await setElig({ userId: id, status: 'revoked', reason: null, validUntil: null, nextReviewDate: null }))
        .toMatchObject({ ok: false, reason: 'nothing_to_revoke' })
      expect(await eligOf(id)).toBeNull()
    })

    it('two 幹事 first-approving the same member: exactly one wins, the loser gets a typed conflict', async () => {
      // Without the users-row lock both read "no row" and one hits user_eligibility_pkey — a
      // unique violation RAISES, which means a 500 AND the audit row recording it rolled back.
      // This proves the lock turns that into a business-layer answer.
      const id = await mkMember('Race')
      const b = new Client({ connectionString: DB_URL })
      await b.connect()
      try {
        await pg.query('begin')
        const first = await setElig({ userId: id })
        expect(first).toMatchObject({ ok: true, review_version: 1 })

        // B must BLOCK on the users lock rather than race past it.
        let settled = false
        const second = b.query(
          `select set_p2_eligibility($1,0,'approved','mobility_long'::p2_reason,null,null,null,'2098-11-11',null,$2,$3,gen_random_uuid()) as r`,
          [id, admin, SESSION],
        ).then(r => { settled = true; return r.rows[0].r })

        await wait(300)
        expect(settled).toBe(false)

        await pg.query('commit')
        const r = await second
        expect(r).toMatchObject({ ok: false, reason: 'conflict', actual_version: 1 })

        // A's approve stands; B did not clobber it and did not crash.
        expect(await eligOf(id)).toMatchObject({ p2_reason: 'pregnancy', review_version: 1 })
      } finally {
        await b.end()
      }
    })
  })

  // ── set_p2_eligibility ───────────────────────────────────────────────────────
  describe('set_p2_eligibility', () => {
    it('a true no-op writes nothing AND does not record a review', async () => {
      // Deliberate: opening the form and changing nothing is not a review. reviewed_at staying
      // null is what keeps the row CSV-refreshable — the boundary is exactly right, and the UI
      // must offer 「標記已覆核」 separately for the 幹事 who really did check it.
      const id = await mkMember('Noop')
      await sb.from('user_eligibility')
        .insert({ user_id: id, review_status: 'approved', p2_reason: 'pregnancy',
                  p2_valid_until: '2099-01-01', p2_review_date: '2098-12-01' }).throwOnError()

      const r = await setElig({ userId: id })
      expect(r).toMatchObject({ ok: true, noop: true })

      const row = (await eligOf(id))!
      expect(row.review_version).toBe(0)
      expect(row.reviewed_at).toBeNull()   // ⇒ import may still refresh it
      expect(await auditOf(id)).toHaveLength(0)
    })

    it('a stale version conflicts, leaves the row alone, and still records the conflict', async () => {
      const id = await mkMember('Stale')
      await setElig({ userId: id })
      const r = await setElig({ userId: id, expectedVersion: 0, reason: 'mobility_long' })
      expect(r).toMatchObject({ ok: false, reason: 'conflict', actual_version: 1 })
      expect((await eligOf(id))!.p2_reason).toBe('pregnancy')
      expect((await auditOf(id)).some(a => a.result === 'conflict')).toBe(true)
    })

    it('revoking clears the review date and keeps the window as history', async () => {
      const id = await mkMember('Revoke')
      await setElig({ userId: id, validFrom: '2026-01-01' })
      const r = await setElig({ userId: id, expectedVersion: 1, status: 'revoked', reason: null, validFrom: '2026-01-01', validUntil: '2099-01-01', nextReviewDate: null })
      expect(r).toMatchObject({ ok: true })

      const row = (await eligOf(id))!
      expect(row).toMatchObject({ review_status: 'revoked', p2_eligible: false })
      // No P2 left to re-check ⇒ a lingering review date would be a lie.
      expect(row.p2_review_date).toBeNull()
      // ...but what the eligibility WAS stays on the record.
      expect(row.p2_valid_until).toBe('2099-01-01')
      expect(row.p2_valid_from).toBe('2026-01-01')
    })

    it.each([
      ['reason_required',                { status: 'approved', reason: null }],
      ['review_date_required',           { nextReviewDate: null }],
      ['review_date_in_past',            { nextReviewDate: '2020-01-01' }],
      ['child_birthdate_not_applicable', { reason: 'pregnancy', childBirthdate: '2020-01-01' }],
      ['expiry_not_settable',            { reason: 'child_companion', validUntil: '2099-01-01', childBirthdate: '2020-01-01' }],
      ['child_birthdate_required',       { reason: 'child_companion', validUntil: null, childBirthdate: null }],
      ['child_birthdate_in_future',      { reason: 'child_companion', validUntil: null, childBirthdate: '2099-01-01' }],
      ['window_inverted',                { validFrom: '2099-06-01', validUntil: '2099-01-01' }],
    ])('refuses %s, writes a denied audit row, and creates nothing', async (reason, over) => {
      const id = await mkMember(`D-${reason}`)
      expect(await setElig({ userId: id, ...over })).toMatchObject({ ok: false, reason })
      expect(await eligOf(id)).toBeNull()
      const audit = await auditOf(id)
      expect(audit).toHaveLength(1)
      expect(audit[0]).toMatchObject({ result: 'denied' })
      expect(audit[0].metadata_redacted).toMatchObject({ reason })
    })

    it('child_companion derives its expiry from the birthdate', async () => {
      const id = await mkMember('Child')
      await setElig({ userId: id, reason: 'child_companion', validUntil: null, childBirthdate: '2019-09-02' })
      // 9/2 ⇒ the LATER cohort: a day earlier would have been 2025-08-31.
      expect((await eligOf(id))!.p2_valid_until).toBe('2026-08-31')
      expect((await eligOf(id))!.p2_valid_until).toBe(childCompanionValidUntil('2019-09-02'))
    })
  })

  // ── mark_p2_reviewed ─────────────────────────────────────────────────────────
  describe('mark_p2_reviewed', () => {
    it('is NEVER inert — the same date twice is two reviews, not one', async () => {
      // Its purpose is to create a review FACT. 0031's no-op suppression must not be copied
      // here: two people checking on two different days is two real events, and suppressing
      // the second would erase governance history.
      const id = await mkMember('MarkTwice')
      await setElig({ userId: id })

      expect(await markReviewed(id, 1, '2098-12-01')).toMatchObject({ ok: true, review_version: 2 })
      expect(await markReviewed(id, 2, '2098-12-01')).toMatchObject({ ok: true, review_version: 3 })

      const marks = (await auditOf(id)).filter(a => a.action === 'p2_eligibility.marked_reviewed')
      expect(marks).toHaveLength(2)
      expect(marks.every(m => m.result === 'success')).toBe(true)
    })

    it('moves the review date so the row actually LEAVES the queue', async () => {
      // The whole reason p_next_review_date is required: without it the button has no visible
      // effect and 待覆核 never clears.
      const id = await mkMember('MarkMoves')
      await setElig({ userId: id, nextReviewDate: '2098-12-01' })
      await markReviewed(id, 1, '2099-06-30')
      expect((await eligOf(id))!.p2_review_date).toBe('2099-06-30')
    })

    it('refuses a revoked row — the guard that protects the cleared review date', async () => {
      // set_p2_eligibility clears p2_review_date on revoke BECAUSE a revoked row has no P2 to
      // re-check. An unguarded mark_p2_reviewed would refill it one action later.
      const id = await mkMember('MarkRevoked')
      await setElig({ userId: id })
      await setElig({ userId: id, expectedVersion: 1, status: 'revoked', reason: null, validUntil: '2099-01-01', nextReviewDate: null })

      expect(await markReviewed(id, 2, '2099-06-30'))
        .toMatchObject({ ok: false, reason: 'eligibility_not_approved' })

      const row = (await eligOf(id))!
      expect(row.p2_review_date).toBeNull()   // the invariant held
      expect(row.review_version).toBe(2)
      expect((await auditOf(id)).some(a =>
        a.action === 'p2_eligibility.marked_reviewed' && a.result === 'denied')).toBe(true)
    })

    it('refuses an unreviewed row too — an allowlist, so #11 fails closed', async () => {
      const id = await mkMember('MarkUnreviewed')
      await sb.from('user_eligibility').insert({ user_id: id, review_status: 'unreviewed' }).throwOnError()
      expect(await markReviewed(id, 0, '2099-06-30'))
        .toMatchObject({ ok: false, reason: 'eligibility_not_approved' })
    })

    it('refuses a past review date', async () => {
      const id = await mkMember('MarkPast')
      await setElig({ userId: id })
      expect(await markReviewed(id, 1, '2020-01-01')).toMatchObject({ ok: false, reason: 'review_date_in_past' })
    })
  })

  // ── Taipei today, not current_date ───────────────────────────────────────────
  describe('the past-date guard uses Taipei today, not the DB session timezone', () => {
    it('accepts today-in-Taipei even when UTC is still on yesterday', async () => {
      // The DB session is UTC. Between 00:00–08:00 Taipei, current_date returns YESTERDAY, so
      // a naive guard would refuse a legitimate same-day review date for 8 hours every day —
      // and a test written in the afternoon would never notice.
      const id = await mkMember('TZ')
      await setElig({ userId: id })

      const taipeiToday = (await pg.query(`select (now() at time zone 'Asia/Taipei')::date::text as d`)).rows[0].d as string
      const utcToday = (await pg.query(`select current_date::text as d`)).rows[0].d as string

      // Today-in-Taipei is always acceptable, whether or not UTC agrees it has arrived.
      expect(await markReviewed(id, 1, taipeiToday)).toMatchObject({ ok: true })

      // And when the two dates differ (00:00–08:00 Taipei), the Taipei date is the LATER one —
      // proving the guard cannot be using current_date.
      if (taipeiToday !== utcToday) {
        expect(taipeiToday > utcToday).toBe(true)
      }
    })
  })

  // ── The CHECK is the guarantee, not the UI ───────────────────────────────────
  describe('child_companion expiry is DB-enforced', () => {
    it('a raw client cannot hand-set an expiry that disagrees with the birthdate', async () => {
      // 「不可覛改」 stops being a UI promise: this is psql, not the app, and it still cannot.
      const id = await mkMember('CkDirect')
      await setElig({ userId: id, reason: 'child_companion', validUntil: null, childBirthdate: '2019-09-02' })
      await expect(
        pg.query(`update user_eligibility set p2_valid_until = '2030-01-01' where user_id = $1`, [id]),
      ).rejects.toThrow(/eligibility_child_expiry_derived_ck/)
    })

    it('the review-required state (birthdate on file, no expiry) stays representable', async () => {
      const id = await mkMember('CkNullUntil')
      await sb.from('user_eligibility').insert({
        user_id: id, review_status: 'approved', p2_reason: 'child_companion',
        p2_child_birthdate: '2020-01-01', p2_valid_until: null,
      }).throwOnError()
      expect((await eligOf(id))!.p2_valid_until).toBeNull()
    })
  })

  describe('cohort parity: the LIVE SQL function vs TS', () => {
    // 0032's copy was frozen in a migration; this one is a live function the RPC calls, so the
    // parity test now drives the real thing (2B-1's pattern). Dates cast ::text in SQL — a
    // JS Date round-trip silently shifts a day (2B-2a's lesson).
    const FIXTURES = ['2019-01-15', '2019-08-31', '2019-09-01', '2019-09-02', '2019-12-31', '2020-02-29', '2024-06-15']

    it('agrees with childCompanionValidUntil for every fixture', async () => {
      const { rows } = await pg.query(
        `select b as bd, child_companion_valid_until(b::date)::text as until from unnest($1::text[]) as t(b)`,
        [FIXTURES],
      )
      expect(rows).toHaveLength(FIXTURES.length)
      for (const r of rows) {
        expect(r.until as string).toBe(childCompanionValidUntil(r.bd as string))
      }
    })
  })

  // ── The audit rows the RPCs actually wrote ───────────────────────────────────
  describe('audit metadata never carries a birthdate, a note, or a name', () => {
    it('records presence, not content', async () => {
      const id = await mkMember('AuditSafe')
      await setElig({
        userId: id, reason: 'child_companion', validUntil: null,
        childBirthdate: '2019-09-02', note: '媽媽說老三明年上小學',
      })
      const audit = await auditOf(id)
      const meta = audit[0].metadata_redacted
      const serialized = JSON.stringify(meta)

      expect(meta).toMatchObject({ child_birthdate_present: true, note_present: true })
      expect(serialized).not.toContain('2019-09-02')   // the birthdate value
      expect(serialized).not.toContain('媽媽說')        // the note text
      expect(serialized).not.toContain(TAG)            // the member's name
    })

    it('a note of only whitespace is recorded as absent', async () => {
      const id = await mkMember('AuditBlank')
      await setElig({ userId: id, note: '   ' })
      expect((await auditOf(id))[0].metadata_redacted.note_present).toBe(false)
    })
  })
})
