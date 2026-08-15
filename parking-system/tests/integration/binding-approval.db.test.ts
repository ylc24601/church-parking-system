import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Phase 5B Slice 1 — approve/reject a captured pending binding into users.line_id.
// Gated: `RUN_DB_TESTS=1` + reachable local Supabase (prereq: `npm run db:reset`).
try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may already be exported */
}
const RUN = process.env.RUN_DB_TESTS === '1'

type Sb = import('@supabase/supabase-js').SupabaseClient

const NOW = new Date('2099-11-01T00:00:00Z')
const iso = (offsetSec: number) => new Date(NOW.getTime() + offsetSec * 1000).toISOString()
const T = randomUUID().slice(0, 8).toUpperCase() // isolation tag; also valid in code/line_user_id namespaces

describe.skipIf(!RUN)('binding approval (5B) — local DB integration', () => {
  let sb: Sb
  let repo: import('@/server/repositories/parkingRepository').ParkingRepository
  const createdUsers: string[] = []

  const mkUser = async (lineId: string | null = null): Promise<string> => {
    const id = randomUUID()
    await sb.from('users').insert({ id, display_name: 'Test5B', line_id: lineId }).throwOnError()
    createdUsers.push(id)
    return id
  }
  const mkPending = async (lineUserId: string, submittedCode: string, status = 'pending'): Promise<string> => {
    const id = randomUUID()
    await sb.from('pending_binding')
      .insert({ id, line_user_id: lineUserId, submitted_code: submittedCode, status, last_event_type: 'message' })
      .throwOnError()
    return id
  }
  const mkCode = async (
    code: string,
    userId: string,
    opts: { expiresAt?: string; consumedAt?: string } = {},
  ): Promise<string> => {
    const id = randomUUID()
    await sb.from('binding_codes')
      .insert({ id, code, user_id: userId, expires_at: opts.expiresAt ?? iso(3600), consumed_at: opts.consumedAt ?? null })
      .throwOnError()
    return id
  }
  const pendingRow = async (id: string) =>
    (await sb.from('pending_binding').select('*').eq('id', id).single()).data!
  const userLineId = async (id: string) =>
    ((await sb.from('users').select('line_id').eq('id', id).single()).data as { line_id: string | null }).line_id
  const codeRow = async (code: string) =>
    (await sb.from('binding_codes').select('*').eq('code', code).single()).data!

  beforeAll(async () => {
    sb = (await import('@/lib/supabase/server')).getServiceClient()
    repo = (await import('@/server/repositories/parkingRepository')).createParkingRepository(sb)
  })

  afterAll(async () => {
    if (!RUN) return
    await sb.from('binding_codes').delete().like('code', `${T}-%`)
    await sb.from('pending_binding').delete().like('line_user_id', `U${T}%`)
    for (const id of createdUsers) await sb.from('users').delete().eq('id', id)
  })

  // Applies carry the row's current superseded_count (the 0022 optimistic-concurrency
  // revision — normally threaded from the admin preview); dry-runs skip the check.
  const approve = async (pendingId: string, dryRun: boolean) => {
    const revision = dryRun
      ? null
      : ((await sb.from('pending_binding').select('superseded_count').eq('id', pendingId).maybeSingle())
          .data?.superseded_count as number | undefined) ?? null
    return repo.approvePendingBinding({
      pendingId,
      nowIso: NOW.toISOString(),
      dryRun,
      expectedSupersededCount: revision,
    })
  }
  const reject = (pendingId: string, reason: string) =>
    repo.rejectPendingBinding({ pendingId, reason, nowIso: NOW.toISOString() })

  it('happy path: apply writes users.line_id, consumes the code, marks pending approved', async () => {
    const user = await mkUser()
    const line = `U${T}H`
    const pid = await mkPending(line, `${T}-01`)
    await mkCode(`${T}-01`, user)

    expect(await approve(pid, false)).toEqual({ approved: 1, would_approve: true, reason: 'approved' })
    expect(await userLineId(user)).toBe(line)
    const c = await codeRow(`${T}-01`)
    expect(c.consumed_at).not.toBeNull()
    expect(c.consumed_pending_binding_id).toBe(pid)
    expect(c.consumed_line_user_id).toBe(line)
    const p = await pendingRow(pid)
    expect(p.status).toBe('approved')
    expect(p.approved_at).not.toBeNull()
    expect(p.approved_user_id).toBe(user)

    // Idempotent: approving the same row again is pending_not_pending, no second write.
    expect(await approve(pid, false)).toMatchObject({ approved: 0, reason: 'pending_not_pending' })
  })

  it('dry-run: predicts approved but writes nothing', async () => {
    const user = await mkUser()
    const line = `U${T}D`
    const pid = await mkPending(line, `${T}-02`)
    await mkCode(`${T}-02`, user)

    expect(await approve(pid, true)).toEqual({ approved: 0, would_approve: true, reason: 'approved' })
    expect(await userLineId(user)).toBeNull()
    expect((await codeRow(`${T}-02`)).consumed_at).toBeNull()
    expect((await pendingRow(pid)).status).toBe('pending')
  })

  it('code_expired', async () => {
    const user = await mkUser()
    const pid = await mkPending(`U${T}E`, `${T}-03`)
    await mkCode(`${T}-03`, user, { expiresAt: iso(-3600) })
    expect(await approve(pid, false)).toMatchObject({ approved: 0, would_approve: false, reason: 'code_expired' })
    expect(await userLineId(user)).toBeNull()
  })

  it('code_consumed', async () => {
    const user = await mkUser()
    const pid = await mkPending(`U${T}C`, `${T}-04`)
    await mkCode(`${T}-04`, user, { consumedAt: iso(-10) })
    expect(await approve(pid, false)).toMatchObject({ approved: 0, reason: 'code_consumed' })
  })

  it('code_not_found (pending submitted a code with no binding_codes row)', async () => {
    const pid = await mkPending(`U${T}NF`, `${T}-99`)
    expect(await approve(pid, false)).toMatchObject({ approved: 0, reason: 'code_not_found' })
  })

  it('pending_not_found', async () => {
    expect(await approve(randomUUID(), false)).toMatchObject({ approved: 0, reason: 'pending_not_found' })
  })

  it('pending_not_pending (already approved/rejected)', async () => {
    const user = await mkUser()
    const pid = await mkPending(`U${T}PA`, `${T}-05`, 'approved')
    await mkCode(`${T}-05`, user)
    expect(await approve(pid, false)).toMatchObject({ approved: 0, reason: 'pending_not_pending' })
  })

  it('member_already_bound (target member already has a line_id)', async () => {
    const user = await mkUser(`U${T}MBEXIST`)
    const pid = await mkPending(`U${T}MBNEW`, `${T}-06`)
    await mkCode(`${T}-06`, user)
    expect(await approve(pid, false)).toMatchObject({ approved: 0, reason: 'member_already_bound' })
  })

  it('line_id_taken (this line_user_id already bound to another member)', async () => {
    await mkUser(`U${T}TAKEN`)          // owner already bound to this LINE account
    const target = await mkUser()        // the code points to a different, unbound member
    const pid = await mkPending(`U${T}TAKEN`, `${T}-07`)
    await mkCode(`${T}-07`, target)
    expect(await approve(pid, false)).toMatchObject({ approved: 0, reason: 'line_id_taken' })
    expect(await userLineId(target)).toBeNull()
  })

  it('reject path: marks rejected with audit, then re-reject is pending_not_pending', async () => {
    const pid = await mkPending(`U${T}R`, `${T}-08`)
    expect(await reject(pid, 'duplicate')).toEqual({ rejected: 1, reason: 'rejected' })
    const p = await pendingRow(pid)
    expect(p.status).toBe('rejected')
    expect(p.rejected_at).not.toBeNull()
    expect(p.rejected_reason).toBe('duplicate')

    expect(await reject(pid, 'duplicate')).toMatchObject({ rejected: 0, reason: 'pending_not_pending' })
    expect(await reject(randomUUID(), 'x')).toMatchObject({ rejected: 0, reason: 'pending_not_found' })
  })

  it('results are typed + counts/reason-only (no line_user_id / submitted_code leaked)', async () => {
    const user = await mkUser()
    const pid = await mkPending(`U${T}SAFE`, `${T}-09`)
    await mkCode(`${T}-09`, user)
    const s = JSON.stringify(await approve(pid, true))
    for (const key of ['line_user_id', 'submitted_code', 'lineUserId', 'code']) {
      expect(s).not.toContain(key)
    }
    expect(s).not.toContain(`U${T}SAFE`)
    expect(s).not.toContain(`${T}-09`)
    expect(Object.keys(JSON.parse(s)).sort()).toEqual(['approved', 'reason', 'would_approve'])
  })
})
