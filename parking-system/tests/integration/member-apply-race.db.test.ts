import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from 'pg'

// Phase 7 Slice 3 (PR #16 review) — the apply-window locking protocol under REAL
// concurrency: two raw postgres connections with explicitly interleaved transactions.
// apply_reservation and claim_friday_allocation both take the weekly_events row lock,
// so whichever commits first fully wins:
//   A) apply commits first  → the allocator's later snapshot INCLUDES the row;
//   B) claim commits first  → the concurrent apply gets applications_closed, no row.
// Gated: `RUN_DB_TESTS=1` + reachable local Supabase (prereq: `npm run db:reset`).
try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may already be exported */
}
const RUN = process.env.RUN_DB_TESTS === '1'

const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
// This file owns Sundays 2099-06-14 / 2099-06-21.
const SUNDAY_A = '2099-06-14'
const SUNDAY_B = '2099-06-21'
const NOW = '2099-06-11T00:00:00Z'
const T = randomUUID().slice(0, 8)

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe.skipIf(!RUN)('apply-window lock protocol — concurrent transactions', () => {
  let a: Client   // transaction-controlled connection
  let b: Client   // the "other side", also transaction-capable
  const eventA = randomUUID()
  const eventB = randomUUID()
  const userA = randomUUID()
  const userB = randomUUID()
  const vehicleA = randomUUID()
  const vehicleB = randomUUID()

  beforeAll(async () => {
    a = new Client({ connectionString: DB_URL })
    b = new Client({ connectionString: DB_URL })
    await a.connect()
    await b.connect()
    await a.query(
      `insert into weekly_events (id, sunday_date, total_capacity, status)
       values ($1, $2, 23, 'open'), ($3, $4, 23, 'open')`,
      [eventA, SUNDAY_A, eventB, SUNDAY_B],
    )
    await a.query(
      `insert into users (id, display_name) values ($1, $2), ($3, $4)`,
      [userA, `Race7 ${T} A`, userB, `Race7 ${T} B`],
    )
    await a.query(
      `insert into vehicles (id, user_id, license_plate) values ($1, $2, $3), ($4, $5, $6)`,
      [vehicleA, userA, `RC7A-${T.slice(0, 4)}`, vehicleB, userB, `RC7B-${T.slice(0, 4)}`],
    )
  })

  afterAll(async () => {
    if (RUN) {
      await a.query(`delete from reservations where weekly_event_id in ($1, $2)`, [eventA, eventB])
      await a.query(`delete from job_runs where weekly_event_id in ($1, $2)`, [eventA, eventB])
      await a.query(`delete from weekly_events where id in ($1, $2)`, [eventA, eventB])
      await a.query(`delete from vehicles where id in ($1, $2)`, [vehicleA, vehicleB])
      await a.query(`delete from users where id in ($1, $2)`, [userA, userB])
    }
    await a?.end()
    await b?.end()
  })

  it('A: an apply holding the lock blocks the claim; its row lands in the snapshot', async () => {
    // Apply transaction takes the event lock (and inserts) but does NOT commit yet.
    await a.query('begin')
    const applied = await a.query(
      `select apply_reservation($1, $2, $3, false, 3::smallint, $4::timestamptz) as r`,
      [eventA, userA, vehicleA, NOW],
    )
    expect(applied.rows[0].r).toMatchObject({ applied: 1, reason: 'applied' })

    // The allocator's claim on the other connection must BLOCK on the row lock.
    let claimSettled = false
    const claimPromise = b
      .query(`select claim_friday_allocation($1, 'friday_allocation') as r`, [eventA])
      .then(res => {
        claimSettled = true
        return res
      })
    await wait(300)
    expect(claimSettled).toBe(false)   // still waiting on the lock

    // Apply commits → claim proceeds → the committed row is in the pending snapshot.
    await a.query('commit')
    const claim = await claimPromise
    expect(claimSettled).toBe(true)
    expect(claim.rows[0].r).toMatchObject({ claimed: true })

    const snapshot = await b.query(
      `select id from reservations where weekly_event_id = $1 and status = 'pending'`,
      [eventA],
    )
    expect(snapshot.rows).toHaveLength(1)   // the racer's row is allocatable, not stranded

    // And any apply AFTER the committed claim is closed.
    const late = await b.query(
      `select apply_reservation($1, $2, $3, false, 3::smallint, $4::timestamptz) as r`,
      [eventA, userB, vehicleB, NOW],
    )
    expect(late.rows[0].r).toMatchObject({ applied: 0, reason: 'applications_closed' })
  })

  it('B: a claim holding the lock blocks the apply; the apply then sees applications_closed', async () => {
    // Claim transaction takes the event lock (marks running) but does NOT commit yet.
    await a.query('begin')
    const claim = await a.query(
      `select claim_friday_allocation($1, 'friday_allocation') as r`,
      [eventB],
    )
    expect(claim.rows[0].r).toMatchObject({ claimed: true })

    // A concurrent member apply must BLOCK (it cannot sneak a row past the claim).
    let applySettled = false
    const applyPromise = b
      .query(
        `select apply_reservation($1, $2, $3, false, 3::smallint, $4::timestamptz) as r`,
        [eventB, userB, vehicleB, NOW],
      )
      .then(res => {
        applySettled = true
        return res
      })
    await wait(300)
    expect(applySettled).toBe(false)

    // Claim commits → the blocked apply resumes, sees the committed 'running' row, refuses.
    await a.query('commit')
    const applied = await applyPromise
    expect(applied.rows[0].r).toMatchObject({ applied: 0, reason: 'applications_closed' })

    // Invariant the review demanded: no pending row created after the claim.
    const rows = await b.query(
      `select id from reservations where weekly_event_id = $1`,
      [eventB],
    )
    expect(rows.rows).toHaveLength(0)
  })
})
