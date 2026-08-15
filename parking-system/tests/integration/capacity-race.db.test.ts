import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from 'pg'

// Wave 2B-1 (#14A) — the capacity guard under REAL concurrency: two raw postgres
// connections with explicitly interleaved transactions.
//
// Why this test is the important one. The guard is "effective_capacity >= promised",
// where promised is a COUNT — and a COUNT locks nothing that does not exist yet. So the
// guard is only as strong as the claim that every path which can RAISE promised takes
// the same weekly_events row lock first.
//
// Exactly one path net-increases promised: apply_friday_allocation (pending → approved).
// Every other path is a net-zero transition — a cancellation only promotes a waiting row
// if the cancel happened (0006:35), offer resolution moves temp_approved → approved
// without creating a seat. And that one path is gated by claim_friday_allocation, which
// locks the event row before marking the job 'running' (0023:96).
//
// These tests pin that protocol from both sides. If a future writer starts creating
// approved rows without taking this lock, the guard silently stops working and this file
// is what should fail.
// Gated: `RUN_DB_TESTS=1` + reachable local Supabase (prereq: `npm run db:reset`).
try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may already be exported */
}
const RUN = process.env.RUN_DB_TESTS === '1'

const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
// ⚠️ This file OWNS Sunday 2099-08-30 — no other suite may use it.
// Events audited by set_weekly_capacity can never be deleted (audit_logs.weekly_event_id
// FKs weekly_events and audit rows are append-only), so teardown can only FINALIZE them.
// The row therefore outlives the run, and any suite that INSERTs the same sunday_date
// afterwards dies on weekly_events_sunday_date_key. This file originally took 2099-09-06,
// which outbox-health.db.test.ts already owned; it only passed because the two suites
// disagree about who creates the row first (this one reuses, that one inserts), so the
// collision surfaced or hid depending on file order.
const SUNDAY = '2099-08-30'
// A REAL admin_accounts row (see weekly-capacity.db.test.ts): since 0035 the audit
// writer resolves the actor's role in-transaction and raises for an unknown admin id.
let ADMIN = ''
const SESSION = '22222222-2222-4222-8222-222222222222'

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe.skipIf(!RUN)('capacity vs allocation — lock protocol under concurrency', () => {
  let a: Client   // the capacity admin
  let b: Client   // the allocator
  let eventId: string

  beforeAll(async () => {
    a = new Client({ connectionString: DB_URL })
    b = new Client({ connectionString: DB_URL })
    await a.connect()
    await b.connect()

    ADMIN = (await a.query(
      `insert into admin_accounts (username, password_hash) values ($1, 'scrypt$notarealhash') returning id`,
      [`caprace-admin-${randomUUID().slice(0, 8)}`],
    )).rows[0].id

    // Reuse if present: audit rows FK weekly_events and are append-only, so once this
    // suite audits its event the row can never be deleted (see weekly-capacity.db.test).
    const found = await a.query(`select id from weekly_events where sunday_date = $1`, [SUNDAY])
    if (found.rows.length > 0) {
      eventId = found.rows[0].id
    } else {
      const created = await a.query(
        `insert into weekly_events (sunday_date, total_capacity, blocked_spaces, admin_reserved, status)
         values ($1, 23, 3, 0, 'open') returning id`,
        [SUNDAY],
      )
      eventId = created.rows[0].id
    }
    await a.query(`delete from job_runs where weekly_event_id = $1`, [eventId])
    await a.query(`update weekly_events set total_capacity = 23, blocked_spaces = 3, status = 'open' where id = $1`, [eventId])
  })

  afterAll(async () => {
    if (RUN) {
      await a.query(`delete from job_runs where weekly_event_id = $1`, [eventId])
      // The event row CANNOT be deleted (audit rows FK it and are append-only), so
      // finalize it: getActiveEvent is "latest non-finalized by sunday_date DESC", and a
      // lingering OPEN 2099 event would silently become the active event for every later
      // suite. It vanishes on the next db:reset.
      await a.query(`update weekly_events set status = 'finalized' where id = $1`, [eventId])
      // audit_logs has no FK to admin_accounts by design, so the actor row can go even
      // though the rows it wrote cannot.
      if (ADMIN) await a.query(`delete from admin_accounts where id = $1`, [ADMIN])
    }
    await a?.end()
    await b?.end()
  })

  const version = async () =>
    (await a.query(`select capacity_version from weekly_events where id = $1`, [eventId])).rows[0].capacity_version

  it('a capacity change holding the lock BLOCKS the allocator\'s claim until it commits', async () => {
    const v = await version()

    await a.query('begin')
    const res = await a.query(
      `select set_weekly_capacity($1, $2::date, 23, 4, $3, $4, $5, gen_random_uuid()) as r`,
      [eventId, SUNDAY, v, ADMIN, SESSION],
    )
    expect(res.rows[0].r).toMatchObject({ ok: true })

    // The allocator's claim must BLOCK on the same row lock rather than race past it.
    let claimSettled = false
    const claim = b
      .query(`select claim_friday_allocation($1, 'friday_allocation') as r`, [eventId])
      .then(r => { claimSettled = true; return r })

    await wait(300)
    expect(claimSettled).toBe(false)   // still waiting on A's lock — this is the protocol

    await a.query('commit')
    const claimed = await claim
    expect(claimSettled).toBe(true)
    expect(claimed.rows[0].r).toMatchObject({ claimed: true })

    // The allocator now reads the NEW capacity, which is the safe ordering: it allocates
    // against what the admin just set, never against a value it read before the change.
    const after = await a.query(`select blocked_spaces from weekly_events where id = $1`, [eventId])
    expect(after.rows[0].blocked_spaces).toBe(4)

    await a.query(`delete from job_runs where weekly_event_id = $1`, [eventId])
  })

  it('a claim that commits first makes the capacity change refuse rather than guess', async () => {
    await a.query(`delete from job_runs where weekly_event_id = $1`, [eventId])

    // The allocator claims and commits: the job is now 'running' and is about to create
    // approved rows that no COUNT can see yet.
    await b.query('begin')
    const claimed = await b.query(`select claim_friday_allocation($1, 'friday_allocation') as r`, [eventId])
    expect(claimed.rows[0].r).toMatchObject({ claimed: true })
    await b.query('commit')

    const v = await version()
    const res = await a.query(
      `select set_weekly_capacity($1, $2::date, 23, 10, $3, $4, $5, gen_random_uuid()) as r`,
      [eventId, SUNDAY, v, ADMIN, SESSION],
    )
    // Refused — because promised is about to rise and the guard cannot count seats that
    // are not committed yet. Guessing here is exactly how an oversell happens.
    expect(res.rows[0].r).toMatchObject({ ok: false, reason: 'allocation_in_progress' })

    const after = await a.query(`select blocked_spaces from weekly_events where id = $1`, [eventId])
    expect(after.rows[0].blocked_spaces).toBe(4)   // unchanged

    await a.query(`delete from job_runs where weekly_event_id = $1`, [eventId])
  })

  it('an UNCOMMITTED claim is still seen — the lock is what makes the job_runs read honest', async () => {
    await a.query(`delete from job_runs where weekly_event_id = $1`, [eventId])

    // 0023:14-21: READ COMMITTED hides a concurrently-claiming uncommitted 'running' row.
    // Reading job_runs WITHOUT the event lock would therefore miss this claim entirely and
    // wave the capacity change through. Taking the lock first is what closes that window.
    await b.query('begin')
    await b.query(`select claim_friday_allocation($1, 'friday_allocation') as r`, [eventId])
    // B holds the event lock and has NOT committed.

    let capacitySettled = false
    const v = await version()
    const capacity = a
      .query(`select set_weekly_capacity($1, $2::date, 23, 12, $3, $4, $5, gen_random_uuid()) as r`,
             [eventId, SUNDAY, v, ADMIN, SESSION])
      .then(r => { capacitySettled = true; return r })

    await wait(300)
    expect(capacitySettled).toBe(false)   // blocked on B's lock, not reading a stale job_runs

    await b.query('commit')
    const res = await capacity
    // Having waited, it now SEES the claim and refuses — instead of having sailed past an
    // invisible uncommitted row.
    expect(res.rows[0].r).toMatchObject({ ok: false, reason: 'allocation_in_progress' })

    await a.query(`delete from job_runs where weekly_event_id = $1`, [eventId])
  })
})
