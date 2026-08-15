import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from 'pg'

// Wave 2C-1 (#19) — admin role tiers, against the real DB, because every guarantee this
// slice makes is a DB guarantee: the acting account is LOCKED and read in-transaction,
// the audit snapshot is the role that authorised the action, and the active-superadmin
// invariant survives two operators acting at the same instant.
//
// Two raw postgres connections (same technique as capacity-race.db.test.ts) rather than
// Promise.all over supabase-js: the point is to hold one transaction OPEN while the
// other tries to proceed. Two sequential RPC calls would pass whether or not the
// advisory lock exists, which would make the most important test here worthless.
// Gated: `RUN_DB_TESTS=1` + reachable local Supabase (prereq: `npm run db:reset`).
try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may already be exported */
}
const RUN = process.env.RUN_DB_TESTS === '1'

const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
// ⚠️ This file OWNS Sunday 2099-11-08 — no other suite may use it. Audit rows FK
// weekly_events and are append-only, so an audited event can never be deleted again
// (see weekly-capacity.db.test.ts); teardown can only finalize it.
const SUNDAY = '2099-11-08'
const NOW = new Date('2099-01-01T00:00:00Z')
const T = randomUUID().slice(0, 8)

type Sb = import('@supabase/supabase-js').SupabaseClient

describe.skipIf(!RUN)('admin role tiers (2C-1 / #19) — local DB integration', () => {
  let a: Client
  let b: Client
  let sb: Sb
  let eventId: string
  const createdAdminIds: string[] = []

  const mkAdmin = async (suffix: string, role: 'superadmin' | 'clerk') => {
    const id = (await a.query(
      `insert into admin_accounts (username, password_hash, role)
       values ($1, 'scrypt$notarealhash', $2) returning id`,
      [`role-${T}-${suffix}`, role],
    )).rows[0].id as string
    createdAdminIds.push(id)
    return id
  }
  const roleOf = async (id: string) =>
    (await a.query(`select role from admin_accounts where id = $1`, [id])).rows[0]?.role
  const disabledAt = async (id: string) =>
    (await a.query(`select disabled_at from admin_accounts where id = $1`, [id])).rows[0]?.disabled_at
  const auditFor = async (requestId: string) =>
    (await a.query(`select * from audit_logs where request_id = $1`, [requestId])).rows
  const activeSuperadmins = async () =>
    Number((await a.query(
      `select count(*)::int as n from admin_accounts where disabled_at is null and role = 'superadmin'`,
    )).rows[0].n)

  const setDisabled = (client: Client, args: {
    targetId: string; actingAdminId: string; actingSessionId?: string
    disabled: boolean; requestId: string
  }) =>
    client.query(
      `select set_admin_disabled($1,$2,$3,$4,$5,$6) as r`,
      [args.targetId, args.actingAdminId, args.actingSessionId ?? randomUUID(),
        args.disabled, NOW.toISOString(), args.requestId],
    )

  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

  beforeAll(async () => {
    a = new Client({ connectionString: DB_URL })
    b = new Client({ connectionString: DB_URL })
    await a.connect()
    await b.connect()
    sb = (await import('@/lib/supabase/server')).getServiceClient()

    // Reuse rather than insert-or-die: once this suite writes an audit row against the
    // event, the event can never be deleted again (audit rows FK it and are append-only),
    // so a delete-then-insert fixture would poison every later run against the unique
    // sunday_date. Reopening it is required, not cosmetic — afterAll finalizes it, and a
    // finalized event is not editable, so the second run would fail on the first write.
    const existing = (await a.query(`select id from weekly_events where sunday_date = $1`, [SUNDAY])).rows[0]
    if (existing) {
      eventId = existing.id
      await a.query(
        `update weekly_events set status = 'open', total_capacity = 20, blocked_spaces = 0 where id = $1`,
        [eventId],
      )
    } else {
      eventId = (await a.query(
        `insert into weekly_events (sunday_date, status, total_capacity, blocked_spaces)
         values ($1, 'open', 20, 0) returning id`,
        [SUNDAY],
      )).rows[0].id
    }
  })

  afterAll(async () => {
    if (RUN) {
      // audit_logs has no FK to admin_accounts by design — the log outlives its actors —
      // so the accounts can go even though the rows they wrote cannot.
      for (const id of createdAdminIds) {
        await a.query(`delete from admin_accounts where id = $1`, [id])
      }
      // The event cannot be deleted once audited; finalize it so it never becomes some
      // later suite's "active event".
      await a.query(`update weekly_events set status = 'finalized' where id = $1`, [eventId])
    }
    await a?.end()
    await b?.end()
  })

  // ── the invariant, under genuinely overlapping transactions ──────────────────

  it('two superadmins disabling each other at the same instant: one wins, one superadmin survives', async () => {
    const x = await mkAdmin('inv-x', 'superadmin')
    const y = await mkAdmin('inv-y', 'superadmin')
    const beforeCount = await activeSuperadmins()
    const reqX = randomUUID()
    const reqY = randomUUID()

    // Connection A opens a transaction, disables Y, and HOLDS it — so it is still
    // holding hashtext('active_superadmin_invariant') when B starts.
    await a.query('begin')
    const resA = await setDisabled(a, { targetId: y, actingAdminId: x, disabled: true, requestId: reqX })
    expect(resA.rows[0].r).toEqual({ ok: true })

    // B must BLOCK rather than evaluate its guards against a stale view. (Here the row
    // locks would serialize these two on their own — B wants FOR SHARE on y, which A is
    // mid-UPDATE. The test below isolates the advisory lock proper, on rows that do not
    // overlap at all.)
    let bSettled = false
    const bCall = b.query('begin')
      .then(() => setDisabled(b, { targetId: x, actingAdminId: y, disabled: true, requestId: reqY }))
      .then(r => { bSettled = true; return r })
    await wait(300)
    expect(bSettled).toBe(false)

    await a.query('commit')
    const resB = await bCall
    await b.query('commit')

    // B ran after A committed, so its acting account (y) is now disabled — refused for
    // that, before the last-active guard is ever consulted.
    expect(resB.rows[0].r).toEqual({ ok: false, reason: 'acting_admin_disabled' })
    expect(await disabledAt(y)).not.toBeNull()
    expect(await disabledAt(x)).toBeNull()
    expect(await activeSuperadmins()).toBe(beforeCount - 1)   // never both, never zero

    // The refusal is a governed one, so it committed a row rather than rolling back.
    const denied = await auditFor(reqY)
    expect(denied.length).toBe(1)
    expect(denied[0].result).toBe('denied')
    expect(denied[0].metadata_redacted).toEqual({ reason: 'acting_admin_disabled' })
    // Read from the locked row, not asserted by the caller: y was still a superadmin.
    expect(denied[0].actor_role_snapshot).toBe('superadmin')
  })

  it('every account operation queues on ONE lock, even when the rows do not overlap', async () => {
    // This is the assertion the cross-RPC hazard actually rests on. Two disables of
    // DIFFERENT targets by DIFFERENT actors share no row, so nothing but
    // pg_advisory_xact_lock(hashtext('active_superadmin_invariant')) can serialize them.
    // Remove that lock and this test goes green-to-red immediately, while the
    // mutual-disable test above would still pass on row locks alone.
    //
    // It matters because 0036's set_admin_role must take the SAME key: a demotion and a
    // disable touch different rows, so without a shared lock each could see the other's
    // superadmin as still active and both commit — leaving zero.
    const actor1 = await mkAdmin('lock-actor-1', 'superadmin')
    const actor2 = await mkAdmin('lock-actor-2', 'superadmin')
    const target1 = await mkAdmin('lock-target-1', 'clerk')
    const target2 = await mkAdmin('lock-target-2', 'clerk')

    await a.query('begin')
    await setDisabled(a, { targetId: target1, actingAdminId: actor1, disabled: true, requestId: randomUUID() })

    let settled = false
    const blocked = b.query('begin')
      .then(() => setDisabled(b, {
        targetId: target2, actingAdminId: actor2, disabled: true, requestId: randomUUID(),
      }))
      .then(r => { settled = true; return r })
    await wait(300)
    expect(settled).toBe(false)

    await a.query('commit')
    const res = await blocked
    await b.query('commit')
    expect(res.rows[0].r).toEqual({ ok: true })
    expect(await disabledAt(target1)).not.toBeNull()
    expect(await disabledAt(target2)).not.toBeNull()
  })

  // ── deadlock: every account mutation must hold the SAME lock ─────────────────
  // Each of these RPCs locks the ACTING row (FOR SHARE) and then a TARGET row (FOR
  // UPDATE). Two concurrent calls with mirrored actor/target can interleave BETWEEN
  // those two acquisitions —
  //     backend 1: share(A) … wants update(B)
  //     backend 2: share(B) … wants update(A)
  // — and Postgres breaks the cycle with 40P01, which the API reports as a 500. Taking
  // the shared advisory lock before any row lock makes the pair strictly sequential, so
  // the interleaving cannot happen.
  //
  // That window is microseconds wide, so a test that fires both RPCs and hopes to land
  // in it is a coin flip, not a regression test. (An earlier version of this test held
  // one transaction open across a completed RPC call instead — which never reproduces
  // the cycle, because by then that backend already holds BOTH locks. It passed with
  // the lock removed, i.e. it asserted nothing.) So assert the mechanism directly:
  // while the RPC's transaction is open, the lock must be unavailable to anyone else.
  // Mutation-verified — remove the perform from either RPC and its case goes red.
  const holdsSharedLock = async (call: (actor: string, target: string) => Promise<unknown>) => {
    const actor = await mkAdmin(`lk-${randomUUID().slice(0, 6)}-a`, 'superadmin')
    const target = await mkAdmin(`lk-${randomUUID().slice(0, 6)}-t`, 'clerk')

    const free = async () => (await b.query(
      `select pg_try_advisory_xact_lock(hashtext('active_superadmin_invariant')) as got`,
    )).rows[0].got as boolean

    expect(await free()).toBe(true)          // nobody holds it before we start

    await a.query('begin')
    await call(actor, target)
    expect(await free()).toBe(false)         // the RPC took it, and still holds it

    await a.query('commit')
    expect(await free()).toBe(true)          // xact-scoped: released on commit
  }

  it('set_admin_disabled holds the shared account lock for its whole transaction', async () => {
    await holdsSharedLock((actor, target) => setDisabled(a, {
      targetId: target, actingAdminId: actor, disabled: true, requestId: randomUUID(),
    }))
  })

  it('reset_admin_password holds it too — it locks two rows, so it can deadlock without it', async () => {
    // The cross-RPC case the review caught: before this, only set_admin_disabled took
    // the advisory lock, so "A resets B's password" against "B disables A" was serialized
    // by nothing and the row locks alone formed the cycle.
    await holdsSharedLock((actor, target) => a.query(
      `select reset_admin_password($1,$2,$3,$4,$5) as r`,
      [target, actor, randomUUID(), 'scrypt$dl$dl', randomUUID()],
    ))
  })

  // ── the role guard ───────────────────────────────────────────────────────────

  it('a 幹事 cannot disable an account, and the refusal is recorded against their real role', async () => {
    const clerk = await mkAdmin('guard-clerk', 'clerk')
    const target = await mkAdmin('guard-target', 'superadmin')
    const requestId = randomUUID()

    const res = await setDisabled(a, {
      targetId: target, actingAdminId: clerk, disabled: true, requestId,
    })
    expect(res.rows[0].r).toEqual({ ok: false, reason: 'forbidden_role' })
    expect(await disabledAt(target)).toBeNull()

    const rows = await auditFor(requestId)
    expect(rows.length).toBe(1)
    expect(rows[0].result).toBe('denied')
    expect(rows[0].actor_role_snapshot).toBe('clerk')
  })

  it('a 幹事 cannot reset another admin\'s password', async () => {
    const clerk = await mkAdmin('pw-clerk', 'clerk')
    const target = await mkAdmin('pw-target', 'clerk')
    const before = (await a.query(`select password_hash from admin_accounts where id = $1`, [target]))
      .rows[0].password_hash
    const requestId = randomUUID()

    const res = await a.query(
      `select reset_admin_password($1,$2,$3,$4,$5) as r`,
      [target, clerk, randomUUID(), 'scrypt$brandnew$brandnew', requestId],
    )
    expect(res.rows[0].r).toEqual({ ok: false, reason: 'forbidden_role' })
    expect((await a.query(`select password_hash from admin_accounts where id = $1`, [target]))
      .rows[0].password_hash).toBe(before)

    const rows = await auditFor(requestId)
    expect(rows.length).toBe(1)
    expect(rows[0].action).toBe('admin_account.password_reset')
    expect(rows[0].result).toBe('denied')
  })

  it('a successful password reset is recorded too — and carries no credential', async () => {
    const actor = await mkAdmin('pw-ok-actor', 'superadmin')
    const target = await mkAdmin('pw-ok-target', 'clerk')
    const requestId = randomUUID()

    const res = await a.query(
      `select reset_admin_password($1,$2,$3,$4,$5) as r`,
      [target, actor, randomUUID(), 'scrypt$fresh$fresh', requestId],
    )
    expect(res.rows[0].r).toMatchObject({ ok: true, disabled: false })

    const rows = await auditFor(requestId)
    expect(rows.length).toBe(1)
    expect(rows[0].result).toBe('success')
    expect(rows[0].metadata_redacted).toEqual({ sessions_revoked: true, target_disabled: false })
    // Before 0035 the denial was logged and the actual reset was not. The metadata must
    // still never carry the credential or a name — the target is entity_id.
    expect(rows[0].entity_id).toBe(target)
    expect(JSON.stringify(rows[0].metadata_redacted)).not.toContain('scrypt')
  })

  // ── acting-account resolution: two failures that must NOT collapse into one ──

  it('an unknown acting admin is refused WITHOUT an audit row; a disabled one is refused WITH one', async () => {
    const target = await mkAdmin('resolve-target', 'superadmin')
    const keeper = await mkAdmin('resolve-keeper', 'superadmin')

    // Unknown: no account means no role, so no conformant admin audit row can exist —
    // and it is a bad request, not a governed refusal.
    const ghostReq = randomUUID()
    const ghost = await setDisabled(a, {
      targetId: target, actingAdminId: randomUUID(), disabled: true, requestId: ghostReq,
    })
    expect(ghost.rows[0].r).toEqual({ ok: false, reason: 'acting_admin_not_found' })
    expect(await auditFor(ghostReq)).toEqual([])

    // Disabled: a real account acting after it was switched off IS worth a row, and its
    // role is readable, so one is written.
    const disabledActor = await mkAdmin('resolve-disabled', 'superadmin')
    await setDisabled(a, {
      targetId: disabledActor, actingAdminId: keeper, disabled: true, requestId: randomUUID(),
    })
    const staleReq = randomUUID()
    const stale = await setDisabled(a, {
      targetId: target, actingAdminId: disabledActor, disabled: true, requestId: staleReq,
    })
    expect(stale.rows[0].r).toEqual({ ok: false, reason: 'acting_admin_disabled' })
    const rows = await auditFor(staleReq)
    expect(rows.length).toBe(1)
    expect(rows[0].result).toBe('denied')
    expect(await disabledAt(target)).toBeNull()
  })

  // ── the pre-2C RPCs inherit a snapshot without being rewritten ───────────────

  it('set_weekly_capacity, untouched by this slice, still records who acted and as what', async () => {
    const clerk = await mkAdmin('cap-clerk', 'clerk')
    const requestId = randomUUID()
    const version = (await a.query(`select capacity_version from weekly_events where id = $1`, [eventId]))
      .rows[0].capacity_version

    // 幹事 may edit capacity — the point here is that the writer resolved the role even
    // though this RPC passes null, which is what lets 2C-1 avoid rebuilding four large
    // SECURITY DEFINER functions.
    const res = await a.query(
      `select set_weekly_capacity($1,$2,$3,$4,$5,$6,$7,$8) as r`,
      [eventId, SUNDAY, 21, 1, version, clerk, randomUUID(), requestId],
    )
    expect(res.rows[0].r).toMatchObject({ ok: true })

    const rows = await auditFor(requestId)
    expect(rows.length).toBe(1)
    expect(rows[0].actor_role_snapshot).toBe('clerk')
  })

  it('an audit actor that resolves to nothing takes the business change down with it', async () => {
    const before = (await a.query(`select total_capacity, capacity_version from weekly_events where id = $1`, [eventId]))
      .rows[0]

    // A capacity write attributed to an admin who does not exist. The writer raises
    // rather than storing a role-less admin row, and because it runs inside the business
    // transaction the capacity change rolls back with it. Silently writing the
    // incomplete row would hide an actor-threading bug in the record meant to expose it.
    await expect(
      a.query(
        `select set_weekly_capacity($1,$2,$3,$4,$5,$6,$7,$8) as r`,
        [eventId, SUNDAY, 99, 0, before.capacity_version, randomUUID(), randomUUID(), randomUUID()],
      ),
    ).rejects.toThrow(/no resolvable role/)

    const after = (await a.query(`select total_capacity, capacity_version from weekly_events where id = $1`, [eventId]))
      .rows[0]
    expect(after.total_capacity).toBe(before.total_capacity)
    expect(after.capacity_version).toBe(before.capacity_version)
  })

  // ── the backfill ────────────────────────────────────────────────────────────

  // ── 2C-2 RPCs take the SAME advisory lock ────────────────────────────────────
  // The lock-presence property 0036 depends on: a demotion and a create must serialize
  // against every other account mutation, even though they touch different (or no)
  // target rows. Mutation-verified — drop the perform from any one RPC and only its
  // case goes red.
  it('set_admin_role holds the shared account lock for its whole transaction', async () => {
    await holdsSharedLock((actor, target) => a.query(
      `select set_admin_role($1,$2,$3,'superadmin',$4) as r`,
      [target, actor, randomUUID(), randomUUID()],
    ))
  })

  it('revoke_admin_sessions holds the shared account lock for its whole transaction', async () => {
    await holdsSharedLock((actor, target) => a.query(
      `select revoke_admin_sessions($1,$2,$3,$4) as r`,
      [target, actor, randomUUID(), randomUUID()],
    ))
  })

  it('create_admin_account holds it too, though it has no target row', async () => {
    // No target — it cannot form the actor/target deadlock, but it takes the lock anyway
    // for one consistent serialization policy (0036 header). The helper wants a target,
    // so give it a throwaway one the call ignores.
    const actor = await mkAdmin(`lk-${randomUUID().slice(0, 6)}-ca`, 'superadmin')
    const createdName = `lk-${randomUUID().slice(0, 6)}-new`
    const free = async () => (await b.query(
      `select pg_try_advisory_xact_lock(hashtext('active_superadmin_invariant')) as got`,
    )).rows[0].got as boolean

    expect(await free()).toBe(true)
    await a.query('begin')
    await a.query(
      `select create_admin_account($1,'scrypt$x$x',null,'clerk',$2,$3,$4) as r`,
      [createdName, actor, randomUUID(), randomUUID()],
    )
    expect(await free()).toBe(false)
    await a.query('commit')
    expect(await free()).toBe(true)

    const created = (await a.query(`select id from admin_accounts where username = $1`, [createdName])).rows[0]?.id
    if (created) createdAdminIds.push(created)
  })

  // ── revoke actually deletes, and counts, every session ───────────────────────
  it('revoke_admin_sessions reports and deletes 0, 1, and 2+ sessions correctly', async () => {
    const actor = await mkAdmin('rev-actor', 'superadmin')
    const mkSessions = async (targetId: string, n: number) => {
      for (let i = 0; i < n; i++) {
        await a.query(
          `insert into admin_sessions (admin_id, token_hash, expires_at)
           values ($1, $2, $3)`,
          [targetId, randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
            new Date(NOW.getTime() + 3600_000).toISOString()],
        )
      }
    }
    const sessionCount = async (targetId: string) =>
      Number((await a.query(`select count(*)::int n from admin_sessions where admin_id = $1`, [targetId])).rows[0].n)

    for (const n of [0, 1, 3]) {
      const target = await mkAdmin(`rev-t-${n}`, 'clerk')
      await mkSessions(target, n)
      const r = (await a.query(
        `select revoke_admin_sessions($1,$2,$3,$4) as r`,
        [target, actor, randomUUID(), randomUUID()],
      )).rows[0].r
      expect(r.ok).toBe(true)
      expect(r.sessions_revoked).toBe(n)       // the COUNT is right (scalar RETURNING would be wrong)
      expect(await sessionCount(target)).toBe(0) // and all rows are gone
    }
  })

  it('the CLI provisions a 系統管理員, and a bare insert falls to 幹事', async () => {
    const { createAdminAccount } = await import('@/server/services/adminAuthService')
    const repo = (await import('@/server/repositories/parkingRepository')).createParkingRepository(sb)
    const username = `role-${T}-cli`
    await createAdminAccount({ username, password: 'a-long-test-password!' }, repo)
    const cliId = (await a.query(`select id from admin_accounts where username = $1`, [username])).rows[0].id
    createdAdminIds.push(cliId)
    expect(await roleOf(cliId)).toBe('superadmin')

    // The column default is the least-privileged value, so a future write path that
    // forgets to name a role cannot accidentally mint an administrator.
    const bare = (await a.query(
      `insert into admin_accounts (username, password_hash) values ($1, 'scrypt$x$x') returning id`,
      [`role-${T}-bare`],
    )).rows[0].id
    createdAdminIds.push(bare)
    expect(await roleOf(bare)).toBe('clerk')
  })
})
