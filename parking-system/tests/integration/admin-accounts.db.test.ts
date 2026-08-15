import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashPin } from '@/server/http/pinHash'
import { hashSessionToken } from '@/server/http/sessionToken'

// Phase 8 Slice 3 — admin account management (migration 0026: set_admin_disabled +
// reset_admin_password RPCs). These carry the atomicity/concurrency/session-safety
// guarantees a unit test (mocked repo) cannot exercise — the whole point of making
// this an offboarding security feature is that the DB, not the service layer,
// enforces them.
// Gated: `RUN_DB_TESTS=1` + reachable local Supabase (prereq: `npm run db:reset`).
try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may already be exported */
}
const RUN = process.env.RUN_DB_TESTS === '1'

type Sb = import('@supabase/supabase-js').SupabaseClient

const NOW = new Date('2099-12-01T00:00:00Z')
const T = randomUUID().slice(0, 8)
const U = `a3${T.toLowerCase()}`
const PASSWORD = 'a-long-test-password!'

describe.skipIf(!RUN)('admin account management (Phase 8 Slice 3) — local DB integration', () => {
  let sb: Sb
  let repo: import('@/server/repositories/parkingRepository').ParkingRepository
  let createAdminAccount: typeof import('@/server/services/adminAuthService').createAdminAccount
  const createdAdminIds: string[] = []

  const mkAdmin = async (suffix: string) => {
    await createAdminAccount({ username: `${U}-${suffix}`, password: PASSWORD }, repo)
    const acct = await adminRow(`${U}-${suffix}`)
    createdAdminIds.push(acct.id)
    return acct as { id: string; username: string; disabled_at: string | null; failed_attempts: number; locked_at: string | null; password_hash: string }
  }
  const adminRow = async (username: string) =>
    (await sb.from('admin_accounts').select('*').eq('username', username).single()).data!
  const mkSession = async (adminId: string, tokenSeed: string) => {
    await sb.from('admin_sessions').insert({
      admin_id: adminId,
      token_hash: hashSessionToken(tokenSeed),
      expires_at: new Date(NOW.getTime() + 3600_000).toISOString(),
    }).throwOnError()
  }
  const sessionCount = async (adminId: string) =>
    (await sb.from('admin_sessions').select('id').eq('admin_id', adminId)).data!.length
  const deleteAdmins = async (ids: string[]) => {
    for (const id of ids) await sb.from('admin_accounts').delete().eq('id', id)
  }
  // 0030 threaded an audit actor + request id through this RPC. The tests below
  // predate audit and assert nothing about it, so those arguments take throwaway
  // values here; the audit-specific assertions live in audit-log.db.test.ts.
  const setDisabled = (args: {
    targetId: string
    actingAdminId: string
    disabled: boolean
    nowIso?: string
  }) =>
    repo.setAdminDisabled({
      targetId: args.targetId,
      actingAdminId: args.actingAdminId,
      actingSessionId: randomUUID(),
      disabled: args.disabled,
      nowIso: args.nowIso ?? NOW.toISOString(),
      requestId: randomUUID(),
    })

  beforeAll(async () => {
    sb = (await import('@/lib/supabase/server')).getServiceClient()
    repo = (await import('@/server/repositories/parkingRepository')).createParkingRepository(sb)
    ;({ createAdminAccount } = await import('@/server/services/adminAuthService'))
  })

  afterAll(async () => {
    if (!RUN) return
    // admin_sessions cascade with their accounts.
    await deleteAdmins(createdAdminIds)
  })

  // ── session-revival guard ────────────────────────────────────────────────────

  it('re-enabling clears sessions even if a prior disable left one behind (no stale-cookie revival)', async () => {
    // A second admin must stay active throughout — the last-active guard would
    // otherwise refuse to disable `target` if it were the table's only admin.
    const keeper = await mkAdmin('revive-keep')
    const target = await mkAdmin('revive')
    await mkSession(target.id, `${T}-revive-1`)

    const disabled = await setDisabled({ targetId: target.id, actingAdminId: keeper.id, disabled: true })
    expect(disabled).toEqual({ ok: true })
    expect(await sessionCount(target.id)).toBe(0)

    // Simulate a missed deletion / a device that never made a request while disabled:
    // insert a session row directly, bypassing the RPC entirely.
    await mkSession(target.id, `${T}-revive-stale`)
    expect(await sessionCount(target.id)).toBe(1)

    const enabled = await setDisabled({ targetId: target.id, actingAdminId: keeper.id, disabled: false })
    expect(enabled).toEqual({ ok: true })
    // The stale row must be gone — re-enabling always forces a fresh login.
    expect(await sessionCount(target.id)).toBe(0)

    await deleteAdmins([keeper.id, target.id])
  })

  // ── idempotency ───────────────────────────────────────────────────────────────

  it('disabling an already-disabled admin is a no-op success that still clears sessions, skipping the last-active check', async () => {
    const other = await mkAdmin('idem-other')   // stays active so the FIRST disable below is legal
    const target = await mkAdmin('idem-target')

    const first = await setDisabled({ targetId: target.id, actingAdminId: other.id, disabled: true })
    expect(first).toEqual({ ok: true })
    const disabledAtAfterFirst = (await adminRow(`${U}-idem-target`)).disabled_at

    await mkSession(target.id, `${T}-idem-stray`)

    // Re-disable while ALREADY disabled: must succeed even though `other` is the
    // only currently-active admin (the exists-check is skipped for this branch).
    const second = await setDisabled({
      targetId: target.id, actingAdminId: other.id, disabled: true,
      nowIso: new Date(NOW.getTime() + 60_000).toISOString(),
    })
    expect(second).toEqual({ ok: true })
    expect(await sessionCount(target.id)).toBe(0)
    // disabled_at is untouched by the idempotent re-disable (no update runs on that branch).
    expect((await adminRow(`${U}-idem-target`)).disabled_at).toBe(disabledAtAfterFirst)

    await deleteAdmins([other.id, target.id])
  })

  it('enabling an already-active admin is a no-op success that still clears sessions', async () => {
    const actor = await mkAdmin('idem-enable-actor')
    const target = await mkAdmin('idem-enable')
    await mkSession(target.id, `${T}-idem-enable-stray`)

    const res = await setDisabled({ targetId: target.id, actingAdminId: actor.id, disabled: false })
    expect(res).toEqual({ ok: true })
    expect(await sessionCount(target.id)).toBe(0)
    expect((await adminRow(`${U}-idem-enable`)).disabled_at).toBeNull()

    await deleteAdmins([actor.id, target.id])
  })

  // ── last-active atomic guard ─────────────────────────────────────────────────

  // Wave 2C-1 (#19) moved where this is enforced. It used to reach the last-active
  // guard, but only because nothing verified the ACTING admin existed: a fictional
  // actor made the target look like the last one standing. Now the actor must be a
  // real, active superadmin — so the refusal comes earlier, and the invariant holds
  // for a stronger reason (the actor themselves is an active superadmin who survives).
  it('a nonexistent acting admin cannot disable anyone', async () => {
    const sole = await mkAdmin('sole')
    const res = await setDisabled({ targetId: sole.id, actingAdminId: randomUUID(), disabled: true })
    expect(res).toEqual({ ok: false, reason: 'acting_admin_not_found' })
    expect((await adminRow(`${U}-sole`)).disabled_at).toBeNull()

    await deleteAdmins([sole.id])
  })

  it('two active admins racing to disable each other: exactly one wins, at least one stays active', async () => {
    const a = await mkAdmin('race-a')
    const b = await mkAdmin('race-b')

    const [resA, resB] = await Promise.all([
      setDisabled({ targetId: a.id, actingAdminId: b.id, disabled: true }),
      setDisabled({ targetId: b.id, actingAdminId: a.id, disabled: true }),
    ])

    const aWon = resA.ok
    const bWon = resB.ok
    expect(aWon !== bWon).toBe(true)   // exactly one side succeeds
    const loser = aWon ? resB : resA
    // The advisory lock serializes the two calls, so the loser runs AFTER its own
    // acting account was disabled by the winner — and is refused for that, rather
    // than by the last-active guard as it was before 2C-1. Same outcome, earlier and
    // for a better reason: a disabled admin should not be able to act at all.
    expect(loser).toEqual({ ok: false, reason: 'acting_admin_disabled' })

    const rowA = await adminRow(`${U}-race-a`)
    const rowB = await adminRow(`${U}-race-b`)
    const activeCount = [rowA, rowB].filter(r => r.disabled_at === null).length
    expect(activeCount).toBe(1)   // never zero, never both disabled

    await deleteAdmins([a.id, b.id])
  })

  // ── reset password: atomic hash + lock-clear + session revoke ──────────────────

  it('reset is atomic: hash changes, failures/lock clear, sessions revoke — all in one RPC', async () => {
    const target = await mkAdmin('reset')
    const oldHash = target.password_hash
    // Simulate a locked-out state before the reset.
    await sb.from('admin_accounts')
      .update({ failed_attempts: 5, locked_at: NOW.toISOString() })
      .eq('id', target.id)
    await mkSession(target.id, `${T}-reset-1`)
    await mkSession(target.id, `${T}-reset-2`)

    const newHash = hashPin('a-brand-new-password!!')
    const actor = await mkAdmin('reset-actor')
    const res = await repo.resetAdminPassword({
      targetId: target.id, actingAdminId: actor.id, actingSessionId: randomUUID(),
      passwordHash: newHash, requestId: randomUUID(),
    })
    expect(res).toEqual({ ok: true, username: `${U}-reset`, disabled: false })

    const row = await adminRow(`${U}-reset`)
    expect(row.password_hash).toBe(newHash)
    expect(row.password_hash).not.toBe(oldHash)
    expect(row.failed_attempts).toBe(0)
    expect(row.locked_at).toBeNull()
    expect(await sessionCount(target.id)).toBe(0)

    await deleteAdmins([actor.id, target.id])
  })

  it('resetting a disabled admin leaves it disabled', async () => {
    const other = await mkAdmin('reset-dis-other')
    const target = await mkAdmin('reset-dis-target')
    await setDisabled({ targetId: target.id, actingAdminId: other.id, disabled: true })

    const res = await repo.resetAdminPassword({
      targetId: target.id, actingAdminId: other.id, actingSessionId: randomUUID(),
      passwordHash: hashPin('another-new-password!!'), requestId: randomUUID(),
    })
    expect(res).toEqual({ ok: true, username: `${U}-reset-dis-target`, disabled: true })
    expect((await adminRow(`${U}-reset-dis-target`)).disabled_at).not.toBeNull()

    await deleteAdmins([other.id, target.id])
  })

  it('reset_admin_password RPC refuses self-target directly (defense in depth, bypassing the service)', async () => {
    const target = await mkAdmin('reset-self')
    const { data, error } = await sb.rpc('reset_admin_password', {
      p_target_id: target.id, p_acting_admin_id: target.id, p_acting_session_id: randomUUID(),
      p_password_hash: hashPin('irrelevant-pw!!'), p_request_id: randomUUID(),
    })
    expect(error).toBeNull()
    expect(data).toEqual({ ok: false, reason: 'cannot_target_self' })
    // The plaintext never crosses the RPC boundary; the returned jsonb never carries a password.
    expect(JSON.stringify(data)).not.toContain('password')

    await deleteAdmins([target.id])
  })

  it('set_admin_disabled RPC also refuses self-target directly', async () => {
    const other = await mkAdmin('disable-self-other')
    const target = await mkAdmin('disable-self-target')
    const { data, error } = await sb.rpc('set_admin_disabled', {
      p_target_id: target.id, p_acting_admin_id: target.id, p_acting_session_id: randomUUID(),
      p_disabled: true, p_now: NOW.toISOString(), p_request_id: randomUUID(),
    })
    expect(error).toBeNull()
    expect(data).toEqual({ ok: false, reason: 'cannot_target_self' })

    await deleteAdmins([other.id, target.id])
  })

  // ── standalone session revocation (already-atomic single statement) ────────────

  it('deleteAdminSessionsByAdminId only removes the TARGET admin sessions', async () => {
    const target = await mkAdmin('revoke')
    const bystander = await mkAdmin('revoke-bystander')
    await mkSession(target.id, `${T}-revoke-1`)
    await mkSession(target.id, `${T}-revoke-2`)
    await mkSession(bystander.id, `${T}-revoke-b1`)

    const result = await repo.deleteAdminSessionsByAdminId(target.id)
    expect(result).toEqual({ deleted: 2 })
    expect(await sessionCount(target.id)).toBe(0)
    expect(await sessionCount(bystander.id)).toBe(1)

    await deleteAdmins([target.id, bystander.id])
  })

  // ── list ─────────────────────────────────────────────────────────────────────

  it('listAdminAccounts returns username-sorted rows with the expected shape', async () => {
    const zTag = await mkAdmin('zz-listed')
    const aTag = await mkAdmin('aa-listed')

    const rows = await repo.listAdminAccounts()
    const mine = rows.filter(r => r.username === zTag.username || r.username === aTag.username)
    expect(mine.map(r => r.username)).toEqual([aTag.username, zTag.username])   // alphabetical
    for (const r of mine) {
      expect(r.created_at).toBeInstanceOf(Date)
      expect(r.disabled_at).toBeNull()
      expect(r.locked_at).toBeNull()
    }
    expect(JSON.stringify(mine)).not.toContain('password_hash')

    await deleteAdmins([zTag.id, aTag.id])
  })
})
