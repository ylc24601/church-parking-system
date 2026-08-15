import { randomInt, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Phase 7 Slice 2 — LIFF binding claim: capture (route → service → RPC), XOR shape
// constraints, phone-matched approval, and the preview/apply optimistic-concurrency
// guard (pending_changed) — against local Supabase.
// Gated: `RUN_DB_TESTS=1` + reachable local Supabase (prereq: `npm run db:reset`).
try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may already be exported */
}
const RUN = process.env.RUN_DB_TESTS === '1'

type Sb = import('@supabase/supabase-js').SupabaseClient

const NOW = new Date('2099-12-05T00:00:00Z')
const iso = (offsetSec: number) => new Date(NOW.getTime() + offsetSec * 1000).toISOString()
const T = randomUUID().slice(0, 8).toUpperCase()
const lineId = (s: string) => `U${T}-${s}`
// Unique canonical phones per run (seed uses 0900/0911, member-import fixtures 0955).
const phoneFor = (() => {
  const base = 60000000 + randomInt(1000000)
  let n = 0
  return () => `09${base + n++}`
})()

describe.skipIf(!RUN)('LIFF binding claim (Phase 7 Slice 2) — local DB integration', () => {
  let sb: Sb
  let repo: import('@/server/repositories/parkingRepository').ParkingRepository
  let svc: typeof import('@/server/services/bindingAdminService')
  let claimPOST: (req: Request) => Promise<Response>
  const createdUsers: string[] = []

  const mkUser = async (opts: { phone?: string | null; lineId?: string | null; name?: string } = {}) => {
    const id = randomUUID()
    await sb.from('users').insert({
      id,
      display_name: opts.name ?? `Member7B ${T}`,
      phone_number: opts.phone ?? null,
      line_id: opts.lineId ?? null,
    }).throwOnError()
    createdUsers.push(id)
    return id
  }
  const pendingFor = async (line: string) =>
    (await sb.from('pending_binding').select('*').eq('line_user_id', line).eq('status', 'pending').maybeSingle()).data
  const userLineId = async (id: string) =>
    ((await sb.from('users').select('line_id').eq('id', id).single()).data as { line_id: string | null }).line_id

  const claim = (body: unknown) =>
    claimPOST(new Request('http://localhost/api/member/binding-claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }))

  beforeAll(async () => {
    process.env.MEMBER_AUTH_MODE = 'mock'
    sb = (await import('@/lib/supabase/server')).getServiceClient()
    repo = (await import('@/server/repositories/parkingRepository')).createParkingRepository(sb)
    svc = await import('@/server/services/bindingAdminService')
    claimPOST = (await import('@/app/api/member/binding-claim/route')).POST
  })

  afterAll(async () => {
    if (!RUN) return
    await sb.from('pending_binding').delete().like('line_user_id', `U${T}%`)
    for (const id of createdUsers) await sb.from('users').delete().eq('id', id)
  })

  it('claim through the real route creates a liff-shaped pending row (code null)', async () => {
    const phone = phoneFor()
    const res = await claim({ mockLineUserId: lineId('SHAPE'), name: '  王小明 ', phone: `09${phone.slice(2, 6)}-${phone.slice(6)}` })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    const row = await pendingFor(lineId('SHAPE'))
    expect(row).toMatchObject({
      claim_source: 'liff', submitted_code: null,
      claimed_phone: phone, claimed_name: '王小明', superseded_count: 0,
    })
  })

  it('re-submitting upserts in place; keyword↔liff switches swap the whole field group', async () => {
    const line = lineId('SWITCH')
    await claim({ mockLineUserId: line, name: '甲', phone: phoneFor() })
    const phone2 = phoneFor()
    await claim({ mockLineUserId: line, name: '乙', phone: phone2 })

    let rows = (await sb.from('pending_binding').select('*').eq('line_user_id', line).eq('status', 'pending')).data!
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ claimed_name: '乙', claimed_phone: phone2, superseded_count: 1 })

    // liff → keyword: code set, phone/name cleared (XOR enforced end to end).
    await repo.capturePendingBinding({ lineUserId: line, code: `${T.slice(0, 4)}-KW01`, eventType: 'message', nowIso: iso(60) })
    rows = (await sb.from('pending_binding').select('*').eq('line_user_id', line).eq('status', 'pending')).data!
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      claim_source: 'keyword', submitted_code: `${T.slice(0, 4)}-KW01`,
      claimed_phone: null, claimed_name: null, superseded_count: 2,
    })

    // keyword → liff: back again, code cleared.
    const phone3 = phoneFor()
    await repo.captureLiffBindingClaim({ lineUserId: line, phone: phone3, name: '丙', nowIso: iso(120) })
    rows = (await sb.from('pending_binding').select('*').eq('line_user_id', line).eq('status', 'pending')).data!
    expect(rows[0]).toMatchObject({ claim_source: 'liff', submitted_code: null, claimed_phone: phone3, claimed_name: '丙' })
  })

  it('DB constraints reject half-and-half or junk rows outright', async () => {
    const insert = (row: Record<string, unknown>) =>
      sb.from('pending_binding').insert({ line_user_id: lineId(`CK${randomInt(1e6)}`), status: 'pending', last_event_type: 'test', ...row })

    // keyword row carrying phone/name
    expect((await insert({ claim_source: 'keyword', submitted_code: 'ABCD-1234', claimed_phone: phoneFor(), claimed_name: 'x' })).error?.message)
      .toMatch(/claim_shape/)
    // liff row carrying a code
    expect((await insert({ claim_source: 'liff', submitted_code: 'ABCD-1234', claimed_phone: phoneFor(), claimed_name: 'x' })).error?.message)
      .toMatch(/claim_shape/)
    // liff row with blank name
    expect((await insert({ claim_source: 'liff', submitted_code: null, claimed_phone: phoneFor(), claimed_name: '   ' })).error?.message)
      .toMatch(/claimed_name/)
    // liff row with a non-canonical phone
    expect((await insert({ claim_source: 'liff', submitted_code: null, claimed_phone: '0912-345-678', claimed_name: 'x' })).error?.message)
      .toMatch(/claimed_phone/)
    // users: non-canonical phone can no longer enter the identity key
    expect((await sb.from('users').insert({ id: randomUUID(), display_name: 'bad', phone_number: '02-12345678' })).error?.message)
      .toMatch(/users_phone_format/)
  })

  it('approves a liff claim by canonical phone: line_id written, pending approved, binding_codes untouched', async () => {
    const phone = phoneFor()
    const member = await mkUser({ phone, name: `王小明 ${T}` })
    const line = lineId('HAPPY')
    await claim({ mockLineUserId: line, name: '王小明', phone })
    const pid = (await pendingFor(line))!.id as string

    const preview = await svc.previewApproveBinding({ pendingId: pid, now: NOW }, repo)
    expect(preview).toMatchObject({
      found: true, claimSource: 'liff', claimedName: '王小明',
      matchedUserId: member, matchedDisplayName: `王小明 ${T}`,
      wouldApprove: true, reason: 'approved',
    })
    expect(preview.claimedPhoneMasked).toBe(`${phone.slice(0, 4)}***${phone.slice(-3)}`)
    expect(JSON.stringify(preview)).not.toContain(phone)
    expect(await userLineId(member)).toBeNull()   // preview wrote nothing

    const codesBefore = (await sb.from('binding_codes').select('id')).data!.length
    expect(await svc.applyApproveBinding({ pendingId: pid, expectedSupersededCount: preview.claimVersion!, now: NOW }, repo))
      .toEqual({ approved: 1, reason: 'approved' })
    expect(await userLineId(member)).toBe(line)
    const p = (await sb.from('pending_binding').select('status, approved_user_id').eq('id', pid).single()).data!
    expect(p).toMatchObject({ status: 'approved', approved_user_id: member })
    expect((await sb.from('binding_codes').select('id')).data!.length).toBe(codesBefore)
  })

  it('typed failures: unmatched_at_capture / member_already_bound / line_id_taken', async () => {
    // unmatched_at_capture (0038, formerly phone_not_found) — the capture succeeded,
    // because the LIFF flow deliberately has no membership oracle, and it recorded that it
    // matched NOBODY. The name change is not cosmetic: approval no longer asks "does this
    // phone match a member now?" but "who did this claim match when it was submitted?" —
    // and the answer to the second question cannot be changed by a later phone
    // reassignment. The remedy is for the member to submit again, which takes a fresh
    // snapshot; re-resolving this row would be the cross-identity binding 0038 removes.
    const lineA = lineId('NOMATCH')
    await claim({ mockLineUserId: lineA, name: '查無', phone: phoneFor() })
    const pidA = (await pendingFor(lineA))!.id as string
    const prevA = await svc.previewApproveBinding({ pendingId: pidA, now: NOW }, repo)
    expect(prevA).toMatchObject({ wouldApprove: false, reason: 'unmatched_at_capture', matchedUserId: null })

    // member_already_bound — the matched member already has a different line_id.
    const phoneB = phoneFor()
    await mkUser({ phone: phoneB, lineId: lineId('OTHER1') })
    const lineB = lineId('BOUNDM')
    await claim({ mockLineUserId: lineB, name: '已綁', phone: phoneB })
    const pidB = (await pendingFor(lineB))!.id as string
    expect((await svc.previewApproveBinding({ pendingId: pidB, now: NOW }, repo)).reason).toBe('member_already_bound')

    // line_id_taken — the claimant's LINE account is already bound to someone else.
    // (Route-level this is caught as line_account_already_bound; the RPC guard covers
    // rows captured before that bind happened.)
    const phoneC = phoneFor()
    await mkUser({ phone: phoneC })
    const lineC = lineId('TAKEN')
    await claim({ mockLineUserId: lineC, name: '搶先', phone: phoneC })
    const pidC = (await pendingFor(lineC))!.id as string
    await mkUser({ lineId: lineC })   // someone else binds this LINE account meanwhile
    expect((await svc.previewApproveBinding({ pendingId: pidC, now: NOW }, repo)).reason).toBe('line_id_taken')
  })

  it('TOCTOU guard: a claim re-submitted after preview yields pending_changed — even at the SAME p_now', async () => {
    const phoneA = phoneFor()
    const phoneB = phoneFor()
    const memberA = await mkUser({ phone: phoneA })
    const memberB = await mkUser({ phone: phoneB })
    const line = lineId('RACE')

    // Both captures deliberately use the IDENTICAL timestamp: superseded_count (not the
    // caller-supplied last_submitted_at, which collides here) is the revision that must trip.
    const sameNow = iso(0)
    await repo.captureLiffBindingClaim({ lineUserId: line, phone: phoneA, name: '版本甲', nowIso: sameNow })
    const pid = (await pendingFor(line))!.id as string
    const preview = await svc.previewApproveBinding({ pendingId: pid, now: NOW }, repo)
    expect(preview).toMatchObject({ reason: 'approved', matchedUserId: memberA, claimVersion: 0 })

    // Member re-submits phone B between the admin's preview and apply — same p_now.
    await repo.captureLiffBindingClaim({ lineUserId: line, phone: phoneB, name: '版本乙', nowIso: sameNow })
    const swapped = (await pendingFor(line))!
    // The timestamp is identical (collision) — only the revision moved. A timestamp-based
    // version check would have let the stale preview through here.
    expect(new Date(swapped.last_submitted_at as string).toISOString()).toBe(new Date(sameNow).toISOString())
    expect(swapped.superseded_count).toBe(1)

    expect(await svc.applyApproveBinding({ pendingId: pid, expectedSupersededCount: preview.claimVersion!, now: NOW }, repo))
      .toEqual({ approved: 0, reason: 'pending_changed' })
    expect(await userLineId(memberA)).toBeNull()
    expect(await userLineId(memberB)).toBeNull()
    expect((await pendingFor(line))!.status).toBe('pending')

    // Fresh preview picks up revision 1 (phone B) and approves the right member.
    const fresh = await svc.previewApproveBinding({ pendingId: pid, now: NOW }, repo)
    expect(fresh).toMatchObject({ matchedUserId: memberB, claimVersion: 1 })
    expect(await svc.applyApproveBinding({ pendingId: pid, expectedSupersededCount: fresh.claimVersion!, now: NOW }, repo))
      .toEqual({ approved: 1, reason: 'approved' })
    expect(await userLineId(memberB)).toBe(line)
  })

  it('same guard protects the keyword flow (code swapped after preview, same p_now)', async () => {
    const memberA = await mkUser()
    const memberB = await mkUser()
    const codeA = `${T.slice(0, 4)}-RCA1`
    const codeB = `${T.slice(0, 4)}-RCB2`
    await sb.from('binding_codes').insert([
      { id: randomUUID(), code: codeA, user_id: memberA, expires_at: iso(3600) },
      { id: randomUUID(), code: codeB, user_id: memberB, expires_at: iso(3600) },
    ]).throwOnError()

    const line = lineId('KWRACE')
    const sameNow = iso(0)
    await repo.capturePendingBinding({ lineUserId: line, code: codeA, eventType: 'message', nowIso: sameNow })
    const pid = (await pendingFor(line))!.id as string
    const preview = await svc.previewApproveBinding({ pendingId: pid, now: NOW }, repo)
    expect(preview).toMatchObject({ matchedUserId: memberA, claimVersion: 0 })

    await repo.capturePendingBinding({ lineUserId: line, code: codeB, eventType: 'message', nowIso: sameNow })
    expect(await svc.applyApproveBinding({ pendingId: pid, expectedSupersededCount: preview.claimVersion!, now: NOW }, repo))
      .toEqual({ approved: 0, reason: 'pending_changed' })
    expect(await userLineId(memberA)).toBeNull()
    expect(await userLineId(memberB)).toBeNull()
  })

  it('route: an already-bound account gets line_account_already_bound and no new row', async () => {
    const line = lineId('REBIND')
    await mkUser({ lineId: line })
    const res = await claim({ mockLineUserId: line, name: '重綁', phone: phoneFor() })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: false, reason: 'line_account_already_bound' })
    expect(await pendingFor(line)).toBeNull()
  })

  it('a rejected claim frees the account to submit a fresh one', async () => {
    const line = lineId('REJECT')
    await claim({ mockLineUserId: line, name: 'первый', phone: phoneFor() })
    const pid = (await pendingFor(line))!.id as string
    await svc.rejectBinding({ pendingId: pid, reason: 'unrecognized', now: NOW }, repo)
    expect(await pendingFor(line)).toBeNull()

    await claim({ mockLineUserId: line, name: '第二次', phone: phoneFor() })
    const fresh = await pendingFor(line)
    expect(fresh).toMatchObject({ status: 'pending', claimed_name: '第二次' })
    expect(fresh!.id).not.toBe(pid)
  })

  it('canonical phone invariant: an imported member is matched from a formatted claim input', async () => {
    // import_member normalizes in TS before insert; the claim route normalizes '0912-…' /
    // spaces the same way — both sides land on ^09\d{8}$, so equality lookup must hit.
    const phone = phoneFor()
    const member = await mkUser({ phone })
    const line = lineId('CANON')
    await claim({ mockLineUserId: line, name: '格式', phone: ` ${phone.slice(0, 4)} ${phone.slice(4, 7)} ${phone.slice(7)} ` })
    const pid = (await pendingFor(line))!.id as string
    const preview = await svc.previewApproveBinding({ pendingId: pid, now: NOW }, repo)
    expect(preview).toMatchObject({ matchedUserId: member, reason: 'approved' })
  })

  it('listPendingBindings: FIFO, masked, includes both sources', async () => {
    const lineK = lineId('LISTK')
    const lineL = lineId('LISTL')
    const phone = phoneFor()
    await repo.capturePendingBinding({ lineUserId: lineK, code: `${T.slice(0, 4)}-LST1`, eventType: 'message', nowIso: iso(1000) })
    await repo.captureLiffBindingClaim({ lineUserId: lineL, phone, name: '列表', nowIso: iso(1060) })

    const items = await svc.listPendingBindings({ limit: 100 }, repo)
    const flat = JSON.stringify(items)
    expect(flat).not.toContain(phone)                       // raw phone never in the list
    expect(flat).not.toContain(`${T.slice(0, 4)}-LST1`)     // raw code never in the list
    const kw = items.find(i => i.claim === `${T.slice(0, 4)}-****`)
    const lf = items.find(i => i.claim === `列表 / ${phone.slice(0, 4)}***${phone.slice(-3)}`)
    expect(kw).toBeTruthy()
    expect(lf).toBeTruthy()
    // FIFO: the keyword row (earlier last_submitted_at) sorts before the liff row.
    expect(items.indexOf(kw!)).toBeLessThan(items.indexOf(lf!))
  })
})
