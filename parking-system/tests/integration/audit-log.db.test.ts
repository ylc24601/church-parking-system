import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashSessionToken } from '@/server/http/sessionToken'

// Wave 2A-1 (#15) — the audit substrate (migration 0030), exercised against the real
// DB because every guarantee it makes is a DB guarantee: grants, triggers, CHECK
// constraints and transaction boundaries. A mocked-repo test cannot observe any of
// them, and each is a property that #10/#14A will build on.
// Gated: `RUN_DB_TESTS=1` + reachable local Supabase (prereq: `npm run db:reset`).
try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may already be exported */
}
const RUN = process.env.RUN_DB_TESTS === '1'

type Sb = import('@supabase/supabase-js').SupabaseClient

const NOW = new Date('2099-11-01T00:00:00Z')
const T = randomUUID().slice(0, 8)
const U = `au${T.toLowerCase()}`
const PASSWORD = 'a-long-test-password!'

describe.skipIf(!RUN)('audit substrate (Wave 2A-1 / #15) — local DB integration', () => {
  let sb: Sb
  let repo: import('@/server/repositories/parkingRepository').ParkingRepository
  let createAdminAccount: typeof import('@/server/services/adminAuthService').createAdminAccount
  const createdAdminIds: string[] = []

  const adminRow = async (username: string) =>
    (await sb.from('admin_accounts').select('*').eq('username', username).single()).data!
  const mkAdmin = async (suffix: string) => {
    await createAdminAccount({ username: `${U}-${suffix}`, password: PASSWORD }, repo)
    const acct = await adminRow(`${U}-${suffix}`)
    createdAdminIds.push(acct.id)
    return acct as { id: string; username: string; disabled_at: string | null }
  }
  const mkSession = async (adminId: string, tokenSeed: string) => {
    await sb.from('admin_sessions').insert({
      admin_id: adminId,
      token_hash: hashSessionToken(tokenSeed),
      expires_at: new Date(NOW.getTime() + 3600_000).toISOString(),
    }).throwOnError()
  }
  const sessionCount = async (adminId: string) =>
    (await sb.from('admin_sessions').select('id').eq('admin_id', adminId)).data!.length
  const auditFor = async (requestId: string) =>
    (await sb.from('audit_logs').select('*').eq('request_id', requestId)).data!
  const activeAdminCount = async () =>
    (await sb.from('admin_accounts').select('id').is('disabled_at', null)).data!.length

  const setDisabled = (args: {
    targetId: string
    actingAdminId: string
    actingSessionId?: string | null
    disabled: boolean
    requestId: string
  }) =>
    repo.setAdminDisabled({
      targetId: args.targetId,
      actingAdminId: args.actingAdminId,
      // `as string` so the null case (used to force an audit failure) can reach the
      // RPC — the service layer's requireAdminActor makes that unreachable in the app.
      actingSessionId: (args.actingSessionId === undefined ? randomUUID() : args.actingSessionId) as string,
      disabled: args.disabled,
      nowIso: NOW.toISOString(),
      requestId: args.requestId,
    })

  beforeAll(async () => {
    sb = (await import('@/lib/supabase/server')).getServiceClient()
    repo = (await import('@/server/repositories/parkingRepository')).createParkingRepository(sb)
    ;({ createAdminAccount } = await import('@/server/services/adminAuthService'))
  })

  afterAll(async () => {
    if (!RUN) return
    for (const id of createdAdminIds) await sb.from('admin_accounts').delete().eq('id', id)
    // The audit rows these tests wrote are deliberately NOT cleaned up: the table is
    // append-only, so the app principal has no way to remove them. They are scoped to
    // this run by a random request_id and vanish on the next `db:reset`.
  })

  // ── append-only against the application principal ────────────────────────────

  it('the app principal can read the log but cannot update or delete it', async () => {
    const { data: existing } = await sb.from('audit_logs').select('id').limit(1)
    expect(existing!.length).toBe(1)   // the 0030 bootstrap marker is readable

    const updated = await sb.from('audit_logs').update({ action: 'tampered.row' }).eq('id', existing![0].id)
    expect(updated.error).not.toBeNull()

    const deleted = await sb.from('audit_logs').delete().eq('id', existing![0].id)
    expect(deleted.error).not.toBeNull()

    // Still there, still saying what it said.
    const after = await sb.from('audit_logs').select('action').eq('id', existing![0].id).single()
    expect(after.data!.action).toBe('audit.substrate_enabled')
  })

  // ── atomicity: the whole reason audit lives inside the business RPC ──────────

  it('a failing audit write rolls the business change back with it', async () => {
    const keeper = await mkAdmin('atomic-keep')
    const target = await mkAdmin('atomic-target')
    await mkSession(target.id, `${T}-atomic`)
    const requestId = randomUUID()

    // A null session id on an `admin` actor violates audit_logs_actor_shape_ck, so
    // the audit insert raises — INSIDE the RPC, AFTER it has already updated the
    // account and deleted the sessions. If the write were a second, post-commit
    // call (the design this slice rejected), the disable would survive this.
    await expect(
      setDisabled({
        targetId: target.id, actingAdminId: keeper.id, actingSessionId: null,
        disabled: true, requestId,
      }),
    ).rejects.toThrow(/set_admin_disabled failed/)

    expect((await adminRow(`${U}-atomic-target`)).disabled_at).toBeNull()   // not disabled
    expect(await sessionCount(target.id)).toBe(1)                            // delete rolled back too
    expect(await auditFor(requestId)).toEqual([])                            // no orphan row
  })

  // ── governance refusals must COMMIT, not roll back ───────────────────────────

  it('a denied guard trip leaves the account untouched but still records the refusal', async () => {
    // 2C-1 (#19) changed which guard is reachable here. This used to use the
    // last-active refusal, reached by passing a fictional acting admin id — now that
    // the RPC verifies the actor, that path returns acting_admin_not_found and writes
    // NO row (no account means no role, so no conformant admin audit row exists, and
    // it is a bad request rather than a governed refusal). A clerk being refused is
    // the same shape of governance denial and is genuinely reachable.
    const clerk = await mkAdmin('denied-clerk')
    await sb.from('admin_accounts').update({ role: 'clerk' }).eq('id', clerk.id).throwOnError()
    const target = await mkAdmin('denied-target')
    // Asserted rather than assumed: without this the test could "pass" against the
    // wrong precondition and prove nothing.
    expect(await activeAdminCount()).toBeGreaterThanOrEqual(2)

    const requestId = randomUUID()
    const res = await setDisabled({
      targetId: target.id, actingAdminId: clerk.id, disabled: true, requestId,
    })
    expect(res).toEqual({ ok: false, reason: 'forbidden_role' })
    expect((await adminRow(`${U}-denied-target`)).disabled_at).toBeNull()

    // The row survives the call, which is the point: had the RPC raised instead of
    // returning a typed refusal, the rollback would have erased the evidence that
    // someone tried to disable the last admin.
    const rows = await auditFor(requestId)
    expect(rows.length).toBe(1)
    expect(rows[0].result).toBe('denied')
    expect(rows[0].action).toBe('admin_account.disable')
    expect(rows[0].metadata_redacted).toEqual({ reason: 'forbidden_role' })
    // The refusal is attributed to the role the RPC itself read, not one the caller
    // asserted — a clerk cannot log itself as a superadmin.
    expect(rows[0].actor_role_snapshot).toBe('clerk')
  })

  // ── the success path ─────────────────────────────────────────────────────────

  it('a successful disable records the actor, the entity and a flat, PII-free fact', async () => {
    const keeper = await mkAdmin('ok-keep')
    const target = await mkAdmin('ok-target')
    const actingSessionId = randomUUID()
    const requestId = randomUUID()

    const res = await setDisabled({
      targetId: target.id, actingAdminId: keeper.id, actingSessionId, disabled: true, requestId,
    })
    expect(res).toEqual({ ok: true })

    const rows = await auditFor(requestId)
    expect(rows.length).toBe(1)
    expect(rows[0]).toMatchObject({
      actor_type: 'admin',
      actor_id: keeper.id,
      actor_session_id: actingSessionId,
      // 2C-1 (#19): the role the RPC read for THIS action, resolved inside the same
      // transaction. mkAdmin goes through the CLI service, which provisions superadmins.
      actor_role_snapshot: 'superadmin',
      action: 'admin_account.disable',
      entity_type: 'admin_account',
      entity_id: target.id,
      result: 'success',
      metadata_redacted: { disabled_to: true, state_changed: true },
    })
  })

  it('a repeat disable still records a row, because it still revokes sessions', async () => {
    const keeper = await mkAdmin('repeat-keep')
    const target = await mkAdmin('repeat-target')
    await setDisabled({ targetId: target.id, actingAdminId: keeper.id, disabled: true, requestId: randomUUID() })

    // A device that never made a request while disabled (0026's stale-cookie hazard).
    await mkSession(target.id, `${T}-repeat-stale`)
    const requestId = randomUUID()
    const res = await setDisabled({
      targetId: target.id, actingAdminId: keeper.id, disabled: true, requestId,
    })
    expect(res).toEqual({ ok: true })

    // This looks like a no-op and is not one: the session delete runs
    // unconditionally. Suppressing this row as "no-op noise" would hide a real
    // session revocation, so state_changed carries the nuance instead.
    expect(await sessionCount(target.id)).toBe(0)
    const rows = await auditFor(requestId)
    expect(rows.length).toBe(1)
    expect(rows[0].metadata_redacted).toEqual({ disabled_to: true, state_changed: false })
  })

  // ── the log outlives what it points at (why actor_id/entity_id carry no FK) ──

  it('audit rows survive deletion of both the actor and the entity they name', async () => {
    const keeper = await mkAdmin('gone-keep')
    const target = await mkAdmin('gone-target')
    const requestId = randomUUID()
    await setDisabled({ targetId: target.id, actingAdminId: keeper.id, disabled: true, requestId })

    await sb.from('admin_accounts').delete().eq('id', target.id)
    await sb.from('admin_accounts').delete().eq('id', keeper.id)

    // An FK on actor_id/entity_id would have either blocked these deletes or taken
    // the audit row with them. Both are wrong for a governance log — hence the
    // no-FK snapshot refs, and hence admin accounts are soft-disabled in practice
    // so 2A-2 can still resolve a name to show.
    const rows = await auditFor(requestId)
    expect(rows.length).toBe(1)
    expect(rows[0].actor_id).toBe(keeper.id)
    expect(rows[0].entity_id).toBe(target.id)
  })

  // ── privacy ──────────────────────────────────────────────────────────────────

  it('nothing in the log carries a name, a credential, or any other PII', async () => {
    const keeper = await mkAdmin('priv-keep')
    const target = await mkAdmin('priv-target')
    const requestId = randomUUID()
    await setDisabled({ targetId: target.id, actingAdminId: keeper.id, disabled: true, requestId })

    const rows = await auditFor(requestId)
    const serialized = JSON.stringify(rows)
    // Usernames are the PII actually reachable on this surface: the RPC has them in
    // scope and could trivially have stored one. IDs are stored instead, precisely so
    // the log never has to hold a person's name.
    expect(serialized).not.toContain(target.username)
    expect(serialized).not.toContain(keeper.username)
    for (const forbidden of ['scrypt$', 'password', 'token', 'phone', 'line_id', 'pin']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden)
    }
  })

  // ── read path: the keyset timeline (Wave 2A-2) ───────────────────────────────
  // These run against real PostgREST on purpose. The whole cursor design lives or
  // dies on how PostgREST parses the `or(...)` predicate and how it round-trips a
  // microsecond timestamptz — neither of which a mocked repo can tell us.

  const writeRows = async (n: number) => {
    const keeper = await mkAdmin(`tl-keep-${randomUUID().slice(0, 4)}`)
    const target = await mkAdmin(`tl-target-${randomUUID().slice(0, 4)}`)
    const ids: string[] = []
    for (let i = 0; i < n; i++) {
      const requestId = randomUUID()
      await setDisabled({
        targetId: target.id, actingAdminId: keeper.id, disabled: i % 2 === 0, requestId,
      })
      ids.push((await auditFor(requestId))[0].id as string)
    }
    return ids
  }

  it('reads newest-first and walks the whole timeline with no overlap and no gap', async () => {
    await writeRows(5)
    const first = await repo.listAuditLogs({ limit: 3 })
    expect(first.rows).toHaveLength(3)

    const times = first.rows.map(r => new Date(r.created_at).getTime())
    expect([...times].sort((a, b) => b - a)).toEqual(times)   // descending

    const last = first.rows[2]
    const second = await repo.listAuditLogs({
      limit: 3,
      before: { createdAt: last.created_at, id: last.id },
    })

    const firstIds = first.rows.map(r => r.id)
    const secondIds = second.rows.map(r => r.id)
    expect(secondIds.some(id => firstIds.includes(id))).toBe(false)   // no overlap
    // and no gap: the two pages together are a prefix of the full ordered timeline
    const all = await repo.listAuditLogs({ limit: 100 })
    expect([...firstIds, ...secondIds]).toEqual(all.rows.slice(0, firstIds.length + secondIds.length).map(r => r.id))
  })

  it('the cursor tiebreaker arm works on identical created_at values', async () => {
    // created_at defaults to now() — the TRANSACTION timestamp — so two rows written
    // by one RPC would tie. Rather than rely on a tie occurring, this pins the arm
    // directly: same created_at + a higher id must treat the row as older; a lower
    // id must not. Without this arm, ties silently skip rows.
    const [rowId] = await writeRows(1)
    const target = (await sb.from('audit_logs').select('id, created_at').eq('id', rowId).single()).data!

    const matches = await repo.listAuditLogs({
      limit: 10,
      before: { createdAt: target.created_at as string, id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
    })
    expect(matches.rows.map(r => r.id)).toContain(rowId)

    const excludes = await repo.listAuditLogs({
      limit: 10,
      before: { createdAt: target.created_at as string, id: '00000000-0000-4000-8000-000000000000' },
    })
    expect(excludes.rows.map(r => r.id)).not.toContain(rowId)
  })

  it('an insert while paging does not duplicate or skip a row (what offset could not do)', async () => {
    // The reason this timeline is keyset and not offset. audit_logs is append-only
    // and read newest-first, so a new row lands at the TOP: under offset paging it
    // would push page 1's last row down onto page 2, and the reader would see it
    // twice. The cursor is anchored to a row, not a position, so it cannot move.
    await writeRows(4)
    const page1 = await repo.listAuditLogs({ limit: 2 })
    const cursorRow = page1.rows[1]

    await writeRows(1)   // a NEWER audit row arrives mid-read

    const page2 = await repo.listAuditLogs({
      limit: 2,
      before: { createdAt: cursorRow.created_at, id: cursorRow.id },
    })

    const page1Ids = page1.rows.map(r => r.id)
    expect(page2.rows.map(r => r.id).some(id => page1Ids.includes(id))).toBe(false)
    // Every page-2 row is strictly older than the cursor — the new row cannot appear.
    for (const r of page2.rows) {
      expect(new Date(r.created_at).getTime()).toBeLessThanOrEqual(new Date(cursorRow.created_at).getTime())
    }
  })

  it('reaching the end of the timeline returns fewer rows than asked', async () => {
    // The cursor is deliberately older than any row that can exist, rather than "the oldest of
    // the first 100". audit_logs is append-only — no suite can clean up after itself — so the
    // table grows with every DB test that audits anything, and once it passed 100 rows the old
    // approach was paging from the middle and (correctly) getting more rows back.
    // This asserts the same property without assuming how much history exists.
    const past = await repo.listAuditLogs({
      limit: 10,
      before: { createdAt: '1970-01-01T00:00:00+00:00', id: '00000000-0000-4000-8000-000000000000' },
    })
    expect(past.rows).toEqual([])
  })

  it('created_at survives the round trip with microseconds intact', async () => {
    // If the repo ever parseDate()s this column, the cursor's equality arm stops
    // matching and rows get skipped — silently, and only when timestamps tie.
    const { rows } = await repo.listAuditLogs({ limit: 1 })
    expect(typeof rows[0].created_at).toBe('string')
    expect(rows[0].created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,6}[+-]\d{2}:\d{2}$/)
  })
})
