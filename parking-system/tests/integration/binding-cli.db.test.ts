import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Phase 5B Slice 2 — binding CLI service layer end-to-end (issue -> preview -> apply -> reject)
// against local Supabase, exercising CLI/service/repo/RPC together.
// Gated: `RUN_DB_TESTS=1` + reachable local DB (prereq: `npm run db:reset`).
try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may already be exported */
}
const RUN = process.env.RUN_DB_TESTS === '1'

type Sb = import('@supabase/supabase-js').SupabaseClient

const NOW = new Date('2099-12-01T00:00:00Z')
const T = randomUUID().slice(0, 8).toUpperCase()

describe.skipIf(!RUN)('binding CLI service (5B-2) — local DB integration', () => {
  let sb: Sb
  let repo: import('@/server/repositories/parkingRepository').ParkingRepository
  let svc: typeof import('@/server/services/bindingAdminService')
  const createdUsers: string[] = []

  const mkUser = async (): Promise<string> => {
    const id = randomUUID()
    await sb.from('users').insert({ id, display_name: `Member ${T}` }).throwOnError()
    createdUsers.push(id)
    return id
  }
  const mkPending = async (lineUserId: string, submittedCode: string): Promise<string> => {
    const id = randomUUID()
    await sb.from('pending_binding')
      .insert({ id, line_user_id: lineUserId, submitted_code: submittedCode, last_event_type: 'message' })
      .throwOnError()
    return id
  }
  const userLineId = async (id: string) =>
    ((await sb.from('users').select('line_id').eq('id', id).single()).data as { line_id: string | null }).line_id

  beforeAll(async () => {
    sb = (await import('@/lib/supabase/server')).getServiceClient()
    repo = (await import('@/server/repositories/parkingRepository')).createParkingRepository(sb)
    svc = await import('@/server/services/bindingAdminService')
  })

  afterAll(async () => {
    if (!RUN) return
    for (const id of createdUsers) await sb.from('binding_codes').delete().eq('user_id', id)
    await sb.from('pending_binding').delete().like('line_user_id', `U${T}%`)
    for (const id of createdUsers) await sb.from('users').delete().eq('id', id)
  })

  it('issue → preview (masked, no write) → apply (writes line_id) → idempotent re-apply', async () => {
    const user = await mkUser()
    const issued = await svc.issueBindingCode({ userId: user, ttlDays: 14, now: NOW }, repo)
    expect(issued.code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/)
    expect(issued.displayName).toBe(`Member ${T}`)

    // The code row exists and is unconsumed.
    const codeRow = (await sb.from('binding_codes').select('*').eq('code', issued.code).single()).data!
    expect(codeRow.user_id).toBe(user)
    expect(codeRow.consumed_at).toBeNull()

    const line = `U${T}APPLY`
    const pid = await mkPending(line, issued.code)

    // Preview: masked + predicted approve, writes nothing.
    const preview = await svc.previewApproveBinding({ pendingId: pid, now: NOW }, repo)
    expect(preview).toMatchObject({
      found: true, pendingStatus: 'pending', submittedCodeMasked: `${issued.code.slice(0, 4)}-****`,
      matchedUserId: user, matchedDisplayName: `Member ${T}`, wouldApprove: true, reason: 'approved',
    })
    const previewStr = JSON.stringify(preview)
    expect(previewStr).not.toContain(line)          // raw line_user_id never surfaces
    expect(previewStr).not.toContain(issued.code)   // full code never surfaces
    expect(await userLineId(user)).toBeNull()        // dry-run wrote nothing

    // Apply (with the previewed claimVersion revision): writes line_id, consumes code, marks approved.
    const version = preview.claimVersion!
    expect(version).toBe(0)   // fresh claim, never superseded
    expect(await svc.applyApproveBinding({ pendingId: pid, expectedSupersededCount: version, now: NOW }, repo))
      .toEqual({ approved: 1, reason: 'approved' })
    expect(await userLineId(user)).toBe(line)
    expect((await sb.from('binding_codes').select('consumed_at').eq('code', issued.code).single()).data!.consumed_at).not.toBeNull()
    expect((await sb.from('pending_binding').select('status').eq('id', pid).single()).data!.status).toBe('approved')

    // Idempotent: re-apply is pending_not_pending.
    expect(await svc.applyApproveBinding({ pendingId: pid, expectedSupersededCount: version, now: NOW }, repo))
      .toMatchObject({ approved: 0, reason: 'pending_not_pending' })
  })

  it('reject path marks the claim rejected with audit reason', async () => {
    const pid = await mkPending(`U${T}REJECT`, 'NOMATCH-99')
    expect(await svc.rejectBinding({ pendingId: pid, reason: '  duplicate ', now: NOW }, repo)).toEqual({ rejected: 1, reason: 'rejected' })
    const p = (await sb.from('pending_binding').select('status, rejected_reason').eq('id', pid).single()).data!
    expect(p.status).toBe('rejected')
    expect(p.rejected_reason).toBe('duplicate')
  })

  it('explicit --code collision surfaces as a typed error', async () => {
    const user = await mkUser()
    const first = await svc.issueBindingCode({ userId: user, ttlDays: 7, now: NOW }, repo)
    await expect(svc.issueBindingCode({ userId: user, ttlDays: 7, code: first.code, now: NOW }, repo))
      .rejects.toThrow(/already exists/)
  })
})
