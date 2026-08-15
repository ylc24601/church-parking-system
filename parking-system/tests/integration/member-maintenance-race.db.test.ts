import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from 'pg'

// Tier 0-2 (0038) — the two locking protocols this slice INTRODUCED, under real concurrency:
// two raw postgres connections with explicitly interleaved transactions.
//
// Why these two and not more: everything else 0038 claims is a single-transaction property a
// sequential test can prove. These two are claims ABOUT INTERLEAVING, and "the SQL looks
// right" is not evidence for those. Both protect against a wrong outcome that leaves no trace
// afterwards, which is exactly the kind of bug that never gets found in production.
//
//   (1) vehicle retirement vs a member applying for a space.
//       apply_reservation takes `vehicles ... FOR SHARE`; set_member_vehicle_active takes
//       FOR UPDATE. Without them the two interleave into an INACTIVE vehicle that owns a
//       fresh pending reservation — the exact state this slice exists to make impossible.
//       (The pre-existing member-apply-race.db.test.ts covers apply vs the Friday allocator,
//       i.e. the weekly_events lock. This is a different lock on a different row.)
//
//   (2) a phone change vs approving that member's LINE binding.
//       update_member_identity locks users → pending_binding; approve_pending_binding locks
//       pending_binding → users. Opposite orders, so 0038 puts a shared advisory lock in
//       front of both. Without it this is a textbook deadlock (40P01), and its trigger is
//       mundane: one clerk edits a phone while another approves that member's binding.
//       Proven through pg_locks rather than through the outcome — see ADVISORY_WAIT below
//       for why the outcome alone would have been evidence for nothing.
//
// Gated: `RUN_DB_TESTS=1` + reachable local Supabase (prereq: `npm run db:reset`).
try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may already be exported */
}
const RUN = process.env.RUN_DB_TESTS === '1'

const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
// This file owns Sundays 2099-07-05 / 2099-07-12.
const SUNDAY_A = '2099-07-05'
const SUNDAY_B = '2099-07-12'
const NOW = '2099-07-02T00:00:00Z'
const T = randomUUID().slice(0, 8)
// users_phone_format_ck is ^09[0-9]{8}$ — DIGITS. A uuid slice is hex and fails it, which is
// a nice reminder that the constraint is real. Six random digits, four fixed prefixes.
const N6 = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')
const PHONE_A0 = `0977${N6}`
const PHONE_B0 = `0988${N6}`
const PHONE_A1 = `0966${N6}`
const PHONE_B1 = `0955${N6}`

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// Is backend `pid` blocked on OUR advisory lock, specifically?
//
// Why this and not just "the query had not returned yet": a blocked query proves only that
// SOMETHING is holding SOMETHING. In both tests below the first transaction has already run
// its RPC to completion, so it holds every row lock that RPC takes — meaning the second
// transaction would block on a row lock even if the advisory lock did not exist. An outcome
// test therefore cannot tell the advisory lock apart from the row locks it was added to
// front-run, and would stay green after deleting the line it exists to defend.
//
// pg_locks can tell them apart. `locktype='advisory'` + `granted=false` says the waiter is
// stopped at the advisory acquire — i.e. BEFORE any row lock, which is the whole protocol.
// The classid/objid pair pins it to hashtext('member_identity_binding') rather than to any
// advisory lock at all: this file must not go green on some unrelated lock elsewhere.
// (pg_advisory_xact_lock(bigint) splits the key into classid = high 32 bits, objid = low 32,
// objsubid = 1. Recomputed in SQL rather than hardcoded, so it survives a hashtext change.)
const ADVISORY_WAIT = `
  select count(*)::int as n
    from pg_locks
   where pid = $1
     and locktype = 'advisory'
     and not granted
     and objsubid = 1
     and classid = (hashtext('member_identity_binding')::bigint >> 32)::oid
     and objid   = (hashtext('member_identity_binding')::bigint & 4294967295)::oid`

describe.skipIf(!RUN)('0038 lock protocols — concurrent transactions', () => {
  let a: Client
  let b: Client
  // A third, always-idle connection. It has to be a third: asking `b` about `b` is
  // impossible while `b` is the one blocked, and asking `a` would mean issuing a query on
  // the transaction whose locks are the thing under observation.
  let observer: Client
  let pidB: number

  // Assert `b` is parked on the advisory lock right now. Negative control: delete
  // `perform pg_advisory_xact_lock(hashtext('member_identity_binding'))` from either RPC in
  // 0038 and this fails — b then waits on a row lock, and this count is 0.
  async function expectBlockedOnAdvisoryLock() {
    const held = await observer.query(ADVISORY_WAIT, [pidB])
    expect(held.rows[0].n).toBe(1)
  }

  const eventA = randomUUID()
  const eventB = randomUUID()
  const userA = randomUUID()
  const userB = randomUUID()
  const vehicleA = randomUUID()
  const vehicleB = randomUUID()
  const adminId = randomUUID()
  const sessionId = randomUUID()

  beforeAll(async () => {
    a = new Client({ connectionString: DB_URL })
    b = new Client({ connectionString: DB_URL })
    observer = new Client({ connectionString: DB_URL })
    await a.connect()
    await b.connect()
    await observer.connect()
    pidB = (await b.query('select pg_backend_pid() as pid')).rows[0].pid
    await a.query(
      `insert into weekly_events (id, sunday_date, total_capacity, status)
       values ($1, $2, 23, 'open'), ($3, $4, 23, 'open')`,
      [eventA, SUNDAY_A, eventB, SUNDAY_B],
    )
    await a.query(
      `insert into users (id, display_name, phone_number) values ($1, $2, $3), ($4, $5, $6)`,
      [userA, `Race38 ${T} A`, PHONE_A0, userB, `Race38 ${T} B`, PHONE_B0],
    )
    await a.query(
      `insert into vehicles (id, user_id, license_plate) values ($1, $2, $3), ($4, $5, $6)`,
      [vehicleA, userA, `R38A${T.slice(0, 4)}`, vehicleB, userB, `R38B${T.slice(0, 4)}`],
    )
    await a.query(
      `insert into admin_accounts (id, username, password_hash, role)
       values ($1, $2, 'scrypt$test', 'superadmin')`,
      [adminId, `race38-${T}`],
    )
    await a.query(
      `insert into admin_sessions (id, admin_id, token_hash, expires_at)
       values ($1, $2, $3, now() + interval '1 day')`,
      [sessionId, adminId, `race38-${T}`],
    )
  })

  afterAll(async () => {
    if (RUN) {
      // Every test here leaves `a` mid-transaction until its own commit. If one fails before
      // that commit, the cleanup below would run INSIDE the doomed transaction and be
      // discarded with it — leaving fixtures that make the NEXT run fail in beforeAll on a
      // duplicate sunday_date, i.e. one red test silently becomes a red file. Found by
      // running the negative control below.
      await a.query('rollback').catch(() => {})
      await b.query('rollback').catch(() => {})
      // audit_logs is deliberately append-only (private.audit_logs_block_mutation), so the
      // rows these tests write stay. That is the design, not a leak: they are scoped to a
      // throwaway admin id.
      await a.query(`delete from pending_binding where line_user_id like $1`, [`RACE38-${T}%`])
      await a.query(`delete from reservations where weekly_event_id in ($1, $2)`, [eventA, eventB])
      await a.query(`delete from weekly_events where id in ($1, $2)`, [eventA, eventB])
      await a.query(`delete from vehicles where user_id in ($1, $2)`, [userA, userB])
      await a.query(`delete from users where id in ($1, $2)`, [userA, userB])
      await a.query(`delete from admin_sessions where id = $1`, [sessionId])
      await a.query(`delete from admin_accounts where id = $1`, [adminId])
    }
    await a?.end()
    await b?.end()
    await observer?.end()
  })

  // ── (1) vehicle retirement vs apply ────────────────────────────────────────────
  // Verified by removing 0038's `FOR SHARE` and re-running: only the SECOND test below
  // fails. That is worth writing down rather than leaving as a comfortable green.
  //
  // This first test blocks even WITHOUT the explicit lock, because inserting a reservation
  // takes an implicit FOR KEY SHARE on the referenced vehicles row to validate the composite
  // FK, and FOR KEY SHARE already conflicts with FOR UPDATE. So it documents the protocol
  // but does not isolate the line 0038 added.
  //
  // The second test is the one that does: without FOR SHARE the apply reads a stale "active"
  // under READ COMMITTED (a plain SELECT does not wait on a row-level write lock) and
  // succeeds — `applied: 1` against a car being retired, i.e. precisely the inactive-vehicle-
  // with-a-live-reservation state this slice exists to prevent.
  it('apply holding the vehicle blocks retirement; retirement then refuses on the committed reservation', async () => {
    await a.query('begin')
    const applied = await a.query(
      `select apply_reservation($1, $2, $3, false, 3::smallint, $4::timestamptz) as r`,
      [eventA, userA, vehicleA, NOW],
    )
    expect(applied.rows[0].r).toMatchObject({ applied: 1, reason: 'applied' })

    // FOR UPDATE on the same vehicle row must wait behind the apply's FOR SHARE.
    let settled = false
    const retire = b
      .query(`select set_member_vehicle_active($1, false, $2, $3, $4) as r`,
        [vehicleA, adminId, sessionId, randomUUID()])
      .then(res => { settled = true; return res })
    await wait(300)
    expect(settled).toBe(false)

    await a.query('commit')
    const res = await retire
    expect(settled).toBe(true)
    // The decisive assertion: it does not merely fail, it fails for the RIGHT reason —
    // it can now SEE the reservation that was invisible when it started waiting.
    expect(res.rows[0].r).toMatchObject({ ok: false, reason: 'unfinished_reservations', unfinished: 1 })

    const still = await b.query(`select is_active from vehicles where id = $1`, [vehicleA])
    expect(still.rows[0].is_active).toBe(true)
  })

  it('retirement committed first makes the waiting apply refuse — never an inactive car with a live reservation', async () => {
    await a.query('begin')
    const retired = await a.query(
      `select set_member_vehicle_active($1, false, $2, $3, $4) as r`,
      [vehicleB, adminId, sessionId, randomUUID()],
    )
    expect(retired.rows[0].r).toMatchObject({ ok: true, is_active: false })

    // The member's apply must block on the same row rather than read a stale "active".
    let settled = false
    const apply = b
      .query(`select apply_reservation($1, $2, $3, false, 3::smallint, $4::timestamptz) as r`,
        [eventB, userB, vehicleB, NOW])
      .then(res => { settled = true; return res })
    await wait(300)
    expect(settled).toBe(false)

    await a.query('commit')
    const res = await apply
    expect(res.rows[0].r).toMatchObject({ applied: 0, reason: 'vehicle_not_owned' })

    // The invariant, stated as data: no reservation of any status references the retired car.
    const rows = await b.query(`select id from reservations where vehicle_id = $1`, [vehicleB])
    expect(rows.rows).toHaveLength(0)

    await b.query(`update vehicles set is_active = true where id = $1`, [vehicleB])
  })

  // ── (2) phone change vs binding approval ───────────────────────────────────────
  // The pair that would deadlock without 0038's shared advisory lock. Both orders must
  // resolve, and neither may bind a LINE account to the wrong member.
  it('a phone change and an approval do not deadlock, whichever starts first', async () => {
    const line = `RACE38-${T}-1`
    const phone = PHONE_A0
    await a.query(`select capture_liff_binding_claim($1, $2, $3, now())`, [line, phone, 'Race A'])
    const pendingId = (await a.query(
      `select id, matched_user_id_at_capture from pending_binding where line_user_id = $1`, [line],
    )).rows[0]
    expect(pendingId.matched_user_id_at_capture).toBe(userA)

    // Phone change takes the advisory lock first and holds it uncommitted.
    await a.query('begin')
    const changed = await a.query(
      `select update_member_identity($1, $2, $3, $4, $5, $6, now()) as r`,
      [userA, `Race38 ${T} A`, PHONE_A1, adminId, sessionId, randomUUID()],
    )
    expect(changed.rows[0].r).toMatchObject({ ok: true, bindings_invalidated: 1 })

    // The approval must WAIT on the advisory lock, not deadlock against the row locks.
    let settled = false
    const approve = b
      .query(`select approve_pending_binding($1, $2, now(), false, $3) as r`,
        [pendingId.id, 0, adminId])
      .then(res => { settled = true; return res })
    await wait(300)
    expect(settled).toBe(false)
    // Not merely blocked — blocked ON THE ADVISORY LOCK, before it reaches pending_binding.
    await expectBlockedOnAdvisoryLock()

    await a.query('commit')
    const res = await approve
    expect(settled).toBe(true)
    // It sees the invalidation that committed while it waited — it does not approve a claim
    // whose identity evidence has just been retired.
    expect(res.rows[0].r).toMatchObject({ approved: 0, reason: 'pending_not_pending' })

    const bound = await b.query(`select line_id from users where id = $1`, [userA])
    expect(bound.rows[0].line_id).toBeNull()
  })

  it('an approval committed first survives a later phone change, and binds only the snapshot member', async () => {
    const line = `RACE38-${T}-2`
    const phone = PHONE_B0
    await a.query(`select capture_liff_binding_claim($1, $2, $3, now())`, [line, phone, 'Race B'])
    const pending = (await a.query(
      `select id from pending_binding where line_user_id = $1`, [line],
    )).rows[0]

    await a.query('begin')
    const approved = await a.query(
      `select approve_pending_binding($1, $2, now(), false, $3) as r`,
      [pending.id, 0, adminId],
    )
    expect(approved.rows[0].r).toMatchObject({ approved: 1 })

    // The phone change must wait on the advisory lock rather than deadlock behind users/pending.
    let settled = false
    const change = b
      .query(`select update_member_identity($1, $2, $3, $4, $5, $6, now()) as r`,
        [userB, `Race38 ${T} B`, PHONE_B1, adminId, sessionId, randomUUID()])
      .then(res => { settled = true; return res })
    await wait(300)
    expect(settled).toBe(false)
    // The other direction, pinned the same way: update_member_identity stops at the advisory
    // acquire, which is what keeps the two opposite row-lock orders from meeting.
    await expectBlockedOnAdvisoryLock()

    await a.query('commit')
    const res = await change
    expect(settled).toBe(true)
    // Nothing left to invalidate — the claim is already decided, not pending.
    expect(res.rows[0].r).toMatchObject({ ok: true, bindings_invalidated: 0 })

    // The binding stands, and it is on the member the claim matched AT CAPTURE.
    const bound = await b.query(`select line_id from users where id = $1`, [userB])
    expect(bound.rows[0].line_id).toBe(line)
    await b.query(`update users set line_id = null where id = $1`, [userB])
  })
})
