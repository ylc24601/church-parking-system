import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashPin } from '@/server/http/pinHash'
import { hashSessionToken } from '@/server/http/sessionToken'

// Phase 8 Slice 1 — admin accounts/sessions (0025) + the binding decider audit.
// Gated: `RUN_DB_TESTS=1` + reachable local Supabase (prereq: `npm run db:reset`).
// No weekly fixture needed — nothing here touches weekly_events.
try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may already be exported */
}
const RUN = process.env.RUN_DB_TESTS === '1'

type Sb = import('@supabase/supabase-js').SupabaseClient

const NOW = new Date('2099-12-01T00:00:00Z')
const iso = (offsetSec: number) => new Date(NOW.getTime() + offsetSec * 1000).toISOString()
const T = randomUUID().slice(0, 8)                    // isolation tag
const U = `adm-${T.toLowerCase()}`                     // valid username stem
const PASSWORD = 'a-long-test-password!'

describe.skipIf(!RUN)('admin auth + binding decider audit (Phase 8 Slice 1) — local DB integration', () => {
  let sb: Sb
  let repo: import('@/server/repositories/parkingRepository').ParkingRepository
  let loginAdmin: typeof import('@/server/services/adminAuthService').loginAdmin
  let createAdminAccount: typeof import('@/server/services/adminAuthService').createAdminAccount
  const createdUsers: string[] = []
  let phoneSeq = 0

  const mkMember = async (over: Record<string, unknown> = {}): Promise<{ id: string; phone: string }> => {
    const id = randomUUID()
    const phone = `09${String(80_000_000 + Math.floor(Math.random() * 1_000_000) * 10 + phoneSeq++).padStart(8, '0')}`
    await sb.from('users').insert({ id, display_name: 'Test8', phone_number: phone, ...over }).throwOnError()
    createdUsers.push(id)
    return { id, phone }
  }
  // Since 0038 a liff claim carries the member it matched AT CAPTURE, and approval reads
  // that snapshot instead of re-resolving claimed_phone. A hand-written fixture must
  // therefore resolve the member too — otherwise it fabricates a shape the app can no
  // longer produce (a liff claim that never matched anybody) and every approval below
  // would fail with `unmatched_at_capture` for reasons that have nothing to do with the
  // decider-audit behaviour under test.
  const mkLiffPending = async (lineUserId: string, phone: string): Promise<string> => {
    const id = randomUUID()
    const { data: matched } = await sb
      .from('users').select('id').eq('phone_number', phone).maybeSingle()
    await sb.from('pending_binding')
      .insert({
        id, line_user_id: lineUserId, submitted_code: null, claim_source: 'liff',
        claimed_phone: phone, claimed_name: '測試會友', status: 'pending', last_event_type: 'liff',
        matched_user_id_at_capture: (matched as { id: string } | null)?.id ?? null,
      })
      .throwOnError()
    return id
  }
  const adminRow = async (username: string) =>
    (await sb.from('admin_accounts').select('*').eq('username', username).single()).data!
  const pendingRow = async (id: string) =>
    (await sb.from('pending_binding').select('*').eq('id', id).single()).data!

  beforeAll(async () => {
    sb = (await import('@/lib/supabase/server')).getServiceClient()
    repo = (await import('@/server/repositories/parkingRepository')).createParkingRepository(sb)
    ;({ loginAdmin, createAdminAccount } = await import('@/server/services/adminAuthService'))
  })

  afterAll(async () => {
    if (!RUN) return
    await sb.from('pending_binding').delete().like('line_user_id', `U${T}%`)
    // admin_sessions cascade with their accounts.
    await sb.from('admin_accounts').delete().like('username', `${U}%`)
    for (const id of createdUsers) await sb.from('users').delete().eq('id', id)
  })

  // ── schema constraints ──────────────────────────────────────────────────────

  it('constraints: username format/lowercase, scrypt prefix, display_name bound, session expiry order', async () => {
    const hash = hashPin(PASSWORD)
    // uppercase username
    let r = await sb.from('admin_accounts').insert({ username: `${U}-UP`, password_hash: hash })
    expect(r.error?.message).toMatch(/admin_accounts_username_ck/)
    // bad chars
    r = await sb.from('admin_accounts').insert({ username: `${U} sp`, password_hash: hash })
    expect(r.error?.message).toMatch(/admin_accounts_username_ck/)
    // plaintext password guard
    r = await sb.from('admin_accounts').insert({ username: `${U}-pt`, password_hash: 'plaintext-oops' })
    expect(r.error?.message).toMatch(/admin_accounts_password_hash_ck/)
    // empty display name
    r = await sb.from('admin_accounts').insert({ username: `${U}-dn`, password_hash: hash, display_name: '   ' })
    expect(r.error?.message).toMatch(/admin_accounts_display_name_ck/)

    // session expiry must be after creation
    const { data: acct } = await sb.from('admin_accounts')
      .insert({ username: `${U}-ok`, password_hash: hash }).select('id').single()
    const bad = await sb.from('admin_sessions').insert({
      admin_id: (acct as { id: string }).id, token_hash: hashSessionToken(`x${T}`),
      created_at: iso(0), expires_at: iso(-1),
    })
    expect(bad.error?.message).toMatch(/admin_sessions_expiry_after_creation/)
  })

  it('duplicate normalized username → repo reports inserted:false (23505 mapped, not thrown)', async () => {
    await createAdminAccount({ username: `${U}-dup`, password: PASSWORD }, repo)
    await expect(createAdminAccount({ username: ` ${U.toUpperCase()}-DUP `, password: PASSWORD }, repo))
      .rejects.toThrow(/already exists/)
  })

  it('deleting an admin cascades its sessions; decided_by_admin_id FK refuses unknown admins', async () => {
    await createAdminAccount({ username: `${U}-cas`, password: PASSWORD }, repo)
    const acct = await adminRow(`${U}-cas`)
    const login = await loginAdmin({ username: `${U}-cas`, password: PASSWORD }, repo, NOW)
    expect(login.ok).toBe(true)
    await sb.from('admin_accounts').delete().eq('id', acct.id).throwOnError()
    const { data: rows } = await sb.from('admin_sessions').select('id').eq('admin_id', acct.id)
    expect(rows).toEqual([])

    const pid = await mkLiffPending(`U${T}FK`, (await mkMember()).phone)
    const fk = await sb.rpc('reject_pending_binding', {
      p_pending_id: pid, p_reason: 'x', p_now: NOW.toISOString(), p_admin_id: randomUUID(),
    })
    expect(fk.error?.message).toMatch(/foreign key/)
  })

  // ── login lifecycle ─────────────────────────────────────────────────────────

  it('login mints a session storing sha256(token) with a 12h expiry; wrong-password ×5 locks atomically', async () => {
    await createAdminAccount({ username: `${U}-life`, password: PASSWORD }, repo)
    const acct = await adminRow(`${U}-life`)

    const ok = await loginAdmin({ username: `${U}-life`, password: PASSWORD }, repo, NOW)
    expect(ok.ok).toBe(true)
    const token = (ok as { ok: true; token: string }).token
    const { data: session } = await sb.from('admin_sessions')
      .select('token_hash, expires_at').eq('admin_id', acct.id).single()
    expect(session!.token_hash).toBe(hashSessionToken(token))
    expect(session!.token_hash).not.toBe(token)
    expect(new Date(session!.expires_at as string).toISOString()).toBe(iso(12 * 3600))

    // 5 CONCURRENT wrong passwords: the single-statement counter cannot under-count,
    // and exactly one transition sets locked_at (the rest see an active lock → no-op).
    await Promise.all(Array.from({ length: 5 }, () =>
      repo.applyAdminLoginFailure({ id: acct.id, nowIso: NOW.toISOString(), threshold: 5, lockMinutes: 15 }),
    ))
    let row = await adminRow(`${U}-life`)
    expect(row.failed_attempts).toBe(5)
    expect(row.locked_at).not.toBeNull()
    const lockStamp = row.locked_at

    // Extra failures during the active lock change NOTHING (no counter creep, no lock extension).
    await repo.applyAdminLoginFailure({ id: acct.id, nowIso: iso(60), threshold: 5, lockMinutes: 15 })
    row = await adminRow(`${U}-life`)
    expect(row.failed_attempts).toBe(5)
    expect(row.locked_at).toBe(lockStamp)

    // Locked → login refused even with the right password.
    expect(await loginAdmin({ username: `${U}-life`, password: PASSWORD }, repo, new Date(iso(60))))
      .toEqual({ ok: false, reason: 'locked' })

    // Lock EXPIRED + wrong password → a NEW round starting at 1 (not 6, not instant re-lock).
    const afterLock = new Date(NOW.getTime() + 16 * 60_000)
    await repo.applyAdminLoginFailure({ id: acct.id, nowIso: afterLock.toISOString(), threshold: 5, lockMinutes: 15 })
    row = await adminRow(`${U}-life`)
    expect(row.failed_attempts).toBe(1)
    expect(row.locked_at).toBeNull()

    // Correct password now → success + counter fully reset.
    const back = await loginAdmin({ username: `${U}-life`, password: PASSWORD }, repo, afterLock)
    expect(back.ok).toBe(true)
    row = await adminRow(`${U}-life`)
    expect(row.failed_attempts).toBe(0)
  })

  // ── binding decider audit ───────────────────────────────────────────────────

  it('approve with adminId: users.line_id written + decided_by_admin_id recorded; without → null (CLI compat)', async () => {
    await createAdminAccount({ username: `${U}-dec`, password: PASSWORD }, repo)
    const acct = await adminRow(`${U}-dec`)

    // Admin-UI path
    const m1 = await mkMember()
    const p1 = await mkLiffPending(`U${T}A1`, m1.phone)
    const r1 = await repo.approvePendingBinding({
      pendingId: p1, nowIso: NOW.toISOString(), dryRun: false, expectedSupersededCount: 0, adminId: acct.id,
    })
    expect(r1).toMatchObject({ approved: 1, reason: 'approved' })
    expect((await sb.from('users').select('line_id').eq('id', m1.id).single()).data!.line_id).toBe(`U${T}A1`)
    const row1 = await pendingRow(p1)
    expect(row1.status).toBe('approved')
    expect(row1.decided_by_admin_id).toBe(acct.id)

    // CLI path (no adminId) still decides, unattributed.
    const m2 = await mkMember()
    const p2 = await mkLiffPending(`U${T}A2`, m2.phone)
    const r2 = await repo.approvePendingBinding({
      pendingId: p2, nowIso: NOW.toISOString(), dryRun: false, expectedSupersededCount: 0,
    })
    expect(r2).toMatchObject({ approved: 1 })
    expect((await pendingRow(p2)).decided_by_admin_id).toBeNull()
  })

  it('reject records reason + decider; over-long rejected_reason is refused by the DB', async () => {
    await createAdminAccount({ username: `${U}-rej`, password: PASSWORD }, repo)
    const acct = await adminRow(`${U}-rej`)
    const pid = await mkLiffPending(`U${T}R1`, (await mkMember()).phone)

    const r = await repo.rejectPendingBinding({
      pendingId: pid, reason: '重複申請', nowIso: NOW.toISOString(), adminId: acct.id,
    })
    expect(r).toEqual({ rejected: 1, reason: 'rejected' })
    const row = await pendingRow(pid)
    expect(row.rejected_reason).toBe('重複申請')
    expect(row.decided_by_admin_id).toBe(acct.id)

    const pid2 = await mkLiffPending(`U${T}R2`, (await mkMember()).phone)
    const long = await sb.rpc('reject_pending_binding', {
      p_pending_id: pid2, p_reason: '愛'.repeat(201), p_now: NOW.toISOString(), p_admin_id: null,
    })
    expect(long.error?.message).toMatch(/pending_binding_rejected_reason_len_ck/)
  })

  it('dry-run and blocked applies (pending_changed) never write decided_by_admin_id', async () => {
    await createAdminAccount({ username: `${U}-blk`, password: PASSWORD }, repo)
    const acct = await adminRow(`${U}-blk`)
    const pid = await mkLiffPending(`U${T}B1`, (await mkMember()).phone)

    const dry = await repo.approvePendingBinding({
      pendingId: pid, nowIso: NOW.toISOString(), dryRun: true, adminId: acct.id,
    })
    expect(dry).toMatchObject({ approved: 0, would_approve: true })
    expect((await pendingRow(pid)).decided_by_admin_id).toBeNull()

    const changed = await repo.approvePendingBinding({
      pendingId: pid, nowIso: NOW.toISOString(), dryRun: false, expectedSupersededCount: 7, adminId: acct.id,
    })
    expect(changed).toMatchObject({ approved: 0, reason: 'pending_changed' })
    const row = await pendingRow(pid)
    expect(row.status).toBe('pending')
    expect(row.decided_by_admin_id).toBeNull()
  })

  it('a concurrent approve + reject of the SAME pending row: exactly one side decides', async () => {
    await createAdminAccount({ username: `${U}-race`, password: PASSWORD }, repo)
    const acct = await adminRow(`${U}-race`)
    const m = await mkMember()
    const pid = await mkLiffPending(`U${T}RC`, m.phone)

    const [approveRes, rejectRes] = await Promise.all([
      repo.approvePendingBinding({
        pendingId: pid, nowIso: NOW.toISOString(), dryRun: false, expectedSupersededCount: 0, adminId: acct.id,
      }),
      repo.rejectPendingBinding({
        pendingId: pid, reason: 'race-test', nowIso: NOW.toISOString(), adminId: acct.id,
      }),
    ])

    const approved = approveRes.approved === 1
    const rejected = rejectRes.rejected === 1
    expect(approved !== rejected).toBe(true)   // exactly one winner
    const loserReason = approved ? rejectRes.reason : approveRes.reason
    expect(loserReason).toBe('pending_not_pending')

    // The stored decision matches the winner — no half-approved/half-rejected row.
    const row = await pendingRow(pid)
    if (approved) {
      expect(row.status).toBe('approved')
      expect(row.rejected_reason).toBeNull()
      expect((await sb.from('users').select('line_id').eq('id', m.id).single()).data!.line_id).toBe(`U${T}RC`)
    } else {
      expect(row.status).toBe('rejected')
      expect((await sb.from('users').select('line_id').eq('id', m.id).single()).data!.line_id).toBeNull()
    }
  })
})
