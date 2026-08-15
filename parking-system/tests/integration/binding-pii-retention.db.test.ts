import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Phase 8 Slice 7 — binding PII retention: redact_decided_binding_pii clears
// claimed_phone / claimed_name / submitted_code on rows decided >= retention window
// ago, keeps the audit columns, and never touches pending / fresh rows. Also pins
// the widened claim-shape constraint (redacted shape only for decided rows) and the
// RPC's null / floor guards.
// Gated: `RUN_DB_TESTS=1` + reachable local Supabase (prereq: `npm run db:reset`).
try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may already be exported */
}
const RUN = process.env.RUN_DB_TESTS === '1'

type Sb = import('@supabase/supabase-js').SupabaseClient

const NOW = new Date('2099-11-01T00:00:00Z')
const DAY = 86_400_000
const CUTOFF_90 = new Date(NOW.getTime() - 90 * DAY) // rows decided at/before this are eligible
const T = randomUUID().slice(0, 8).toUpperCase()

describe.skipIf(!RUN)('binding PII retention (Phase 8 Slice 7) — local DB integration', () => {
  let sb: Sb
  let repo: import('@/server/repositories/parkingRepository').ParkingRepository
  const createdUsers: string[] = []

  const mkUser = async (): Promise<string> => {
    const id = randomUUID()
    await sb.from('users').insert({ id, display_name: 'TestPII' }).throwOnError()
    createdUsers.push(id)
    return id
  }
  // A decided keyword-claim row (code set, phone/name null) with a backdated decision.
  const mkDecidedKeyword = async (opts: {
    status: 'approved' | 'rejected'
    decidedAt: Date
    userId?: string
  }): Promise<string> => {
    const id = randomUUID()
    await sb.from('pending_binding').insert({
      id,
      line_user_id: `U${T}${id.slice(0, 6)}`,
      submitted_code: `${T}-K1`,
      status: opts.status,
      last_event_type: 'message',
      claim_source: 'keyword',
      ...(opts.status === 'approved'
        ? { approved_at: opts.decidedAt.toISOString(), approved_user_id: opts.userId ?? null }
        : { rejected_at: opts.decidedAt.toISOString(), rejected_reason: 'test reason' }),
    }).throwOnError()
    return id
  }
  // A decided LIFF-claim row (phone/name set, code null).
  const mkDecidedLiff = async (opts: { status: 'approved' | 'rejected'; decidedAt: Date }): Promise<string> => {
    const id = randomUUID()
    await sb.from('pending_binding').insert({
      id,
      line_user_id: `U${T}${id.slice(0, 6)}`,
      status: opts.status,
      last_event_type: 'liff',
      claim_source: 'liff',
      claimed_phone: '0912345678',
      claimed_name: '測試會友',
      ...(opts.status === 'approved'
        ? { approved_at: opts.decidedAt.toISOString() }
        : { rejected_at: opts.decidedAt.toISOString(), rejected_reason: 'test reason' }),
    }).throwOnError()
    return id
  }
  const mkPendingKeyword = async (): Promise<string> => {
    const id = randomUUID()
    await sb.from('pending_binding').insert({
      id,
      line_user_id: `U${T}${id.slice(0, 6)}`,
      submitted_code: `${T}-P1`,
      status: 'pending',
      last_event_type: 'message',
      claim_source: 'keyword',
    }).throwOnError()
    return id
  }
  const row = async (id: string) =>
    (await sb.from('pending_binding').select('*').eq('id', id).single()).data!
  const redact = (retentionDays: number, max: number, dryRun: boolean) =>
    repo.redactDecidedBindingPii(NOW.toISOString(), retentionDays, max, dryRun)
  const cleanupTagged = async () => {
    await sb.from('pending_binding').delete().like('line_user_id', `U${T}%`)
  }

  beforeAll(async () => {
    sb = (await import('@/lib/supabase/server')).getServiceClient()
    repo = (await import('@/server/repositories/parkingRepository')).createParkingRepository(sb)
  })

  afterAll(async () => {
    if (!RUN) return
    await cleanupTagged()
    for (const id of createdUsers) await sb.from('users').delete().eq('id', id)
  })

  it('dry-run counts only eligible rows and mutates nothing; apply clears exactly those and keeps the audit columns', async () => {
    const user = await mkUser()
    const oldApproved = await mkDecidedKeyword({ status: 'approved', decidedAt: new Date(NOW.getTime() - 91 * DAY), userId: user })
    const oldRejected = await mkDecidedLiff({ status: 'rejected', decidedAt: new Date(NOW.getTime() - 91 * DAY) })
    const freshApproved = await mkDecidedKeyword({ status: 'approved', decidedAt: new Date(NOW.getTime() - 1 * DAY) })
    const stalePending = await mkPendingKeyword()

    // dry-run: 2 eligible, no backlog beyond the batch, zero mutation
    expect(await redact(90, 200, true)).toEqual({ count: 2, hasMore: false })
    expect((await row(oldApproved)).submitted_code).not.toBeNull()
    expect((await row(oldRejected)).claimed_phone).not.toBeNull()

    // apply: exactly the two old decided rows are redacted
    expect(await redact(90, 200, false)).toEqual({ count: 2, hasMore: false })

    const a = await row(oldApproved)
    expect(a.submitted_code).toBeNull()
    expect(a.claimed_phone).toBeNull()
    expect(a.claimed_name).toBeNull()
    // audit columns survive
    expect(a.status).toBe('approved')
    expect(a.claim_source).toBe('keyword')
    expect(new Date(a.approved_at as string).getTime()).toBe(NOW.getTime() - 91 * DAY)
    expect(a.approved_user_id).toBe(user)
    expect(a.created_at).not.toBeNull()

    const r = await row(oldRejected)
    expect(r.claimed_phone).toBeNull()
    expect(r.claimed_name).toBeNull()
    expect(r.submitted_code).toBeNull()
    expect(r.status).toBe('rejected')
    expect(r.claim_source).toBe('liff')
    expect(r.rejected_at).not.toBeNull()
    expect(r.rejected_reason).toBe('test reason')

    // fresh decided row and pending row untouched
    expect((await row(freshApproved)).submitted_code).not.toBeNull()
    expect((await row(stalePending)).submitted_code).not.toBeNull()
    expect((await row(stalePending)).status).toBe('pending')

    // idempotent: re-running finds nothing (redacted rows fail the IS NOT NULL arm)
    expect(await redact(90, 200, true)).toEqual({ count: 0, hasMore: false })
    expect(await redact(90, 200, false)).toEqual({ count: 0, hasMore: false })
    await cleanupTagged()
  })

  it('90-day boundary is exact: <= cutoff redacts, one second fresher does not', async () => {
    const atCutoff = await mkDecidedKeyword({ status: 'approved', decidedAt: CUTOFF_90 })
    const oneSecFresh = await mkDecidedKeyword({ status: 'approved', decidedAt: new Date(CUTOFF_90.getTime() + 1000) })
    const oneSecOlder = await mkDecidedKeyword({ status: 'approved', decidedAt: new Date(CUTOFF_90.getTime() - 1000) })

    expect(await redact(90, 200, true)).toEqual({ count: 2, hasMore: false })
    expect(await redact(90, 200, false)).toEqual({ count: 2, hasMore: false })
    expect((await row(atCutoff)).submitted_code).toBeNull()      // exactly 90 days → cleared
    expect((await row(oneSecOlder)).submitted_code).toBeNull()   // 90 days + 1s → cleared
    expect((await row(oneSecFresh)).submitted_code).not.toBeNull() // 89d 23:59:59 → kept
    await cleanupTagged()
  })

  it('bounded batch: p_max=1 clears the OLDEST decision first; dry-run probes p_max+1 for has_more', async () => {
    const oldest = await mkDecidedKeyword({ status: 'approved', decidedAt: new Date(NOW.getTime() - 300 * DAY) })
    const middle = await mkDecidedKeyword({ status: 'rejected', decidedAt: new Date(NOW.getTime() - 200 * DAY) })
    const newest = await mkDecidedKeyword({ status: 'approved', decidedAt: new Date(NOW.getTime() - 100 * DAY) })

    // 3 eligible, batch of 2 → count capped at 2, has_more flagged
    expect(await redact(90, 2, true)).toEqual({ count: 2, hasMore: true })

    expect(await redact(90, 1, false)).toEqual({ count: 1, hasMore: false })
    expect((await row(oldest)).submitted_code).toBeNull()
    expect((await row(middle)).submitted_code).not.toBeNull()
    expect((await row(newest)).submitted_code).not.toBeNull()
    await cleanupTagged()
  })

  it('claim-shape constraint: redacted shape allowed ONLY for decided rows, and never partially', async () => {
    const pendingKeyword = await mkPendingKeyword()
    const decided = await mkDecidedLiff({ status: 'rejected', decidedAt: new Date(NOW.getTime() - 91 * DAY) })

    // pending keyword row fully cleared → rejected by the constraint
    const p1 = await sb.from('pending_binding')
      .update({ submitted_code: null, claimed_phone: null, claimed_name: null })
      .eq('id', pendingKeyword)
    expect(p1.error?.message).toMatch(/claim_shape_ck/)

    // decided row cleared only partially (phone kept) → rejected
    const p2 = await sb.from('pending_binding')
      .update({ claimed_name: null, submitted_code: null })
      .eq('id', decided)
    expect(p2.error?.message).toMatch(/claim_shape_ck/)

    // decided row fully cleared → accepted
    const p3 = await sb.from('pending_binding')
      .update({ submitted_code: null, claimed_phone: null, claimed_name: null })
      .eq('id', decided)
    expect(p3.error).toBeNull()
    await cleanupTagged()
  })

  it('pending LIFF row fully cleared → rejected by the constraint', async () => {
    const id = randomUUID()
    await sb.from('pending_binding').insert({
      id,
      line_user_id: `U${T}${id.slice(0, 6)}`,
      status: 'pending',
      last_event_type: 'liff',
      claim_source: 'liff',
      claimed_phone: '0987654321',
      claimed_name: '測試待審',
    }).throwOnError()
    const res = await sb.from('pending_binding')
      .update({ claimed_phone: null, claimed_name: null })
      .eq('id', id)
    expect(res.error?.message).toMatch(/claim_shape_ck/)
    await cleanupTagged()
  })

  it('RPC guards: short window and NULL parameters all raise (three-valued logic must not skip them)', async () => {
    const shortWindow = await sb.rpc('redact_decided_binding_pii', {
      p_now: NOW.toISOString(), p_retention_days: 1, p_max: 10, p_dry_run: true,
    })
    expect(shortWindow.error?.message).toMatch(/p_retention_days/)

    const nullNow = await sb.rpc('redact_decided_binding_pii', {
      p_now: null, p_retention_days: 90, p_max: 10, p_dry_run: true,
    })
    expect(nullNow.error?.message).toMatch(/p_now/)

    const nullDays = await sb.rpc('redact_decided_binding_pii', {
      p_now: NOW.toISOString(), p_retention_days: null, p_max: 10, p_dry_run: true,
    })
    expect(nullDays.error?.message).toMatch(/p_retention_days/)

    const nullMax = await sb.rpc('redact_decided_binding_pii', {
      p_now: NOW.toISOString(), p_retention_days: 90, p_max: null, p_dry_run: true,
    })
    expect(nullMax.error?.message).toMatch(/p_max/)

    const nullDryRun = await sb.rpc('redact_decided_binding_pii', {
      p_now: NOW.toISOString(), p_retention_days: 90, p_max: 10, p_dry_run: null,
    })
    expect(nullDryRun.error?.message).toMatch(/p_dry_run/)

    const overMax = await sb.rpc('redact_decided_binding_pii', {
      p_now: NOW.toISOString(), p_retention_days: 90, p_max: 501, p_dry_run: true,
    })
    expect(overMax.error?.message).toMatch(/p_max/)
  })
})
