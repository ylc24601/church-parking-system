import { randomInt, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Phase 8 Slice 2 — admin member search + detail + issue-code, against local Supabase.
// Gated: `RUN_DB_TESTS=1` (prereq: `npm run db:reset`). No weekly fixture needed.
try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may already be exported */
}
const RUN = process.env.RUN_DB_TESTS === '1'

type Sb = import('@supabase/supabase-js').SupabaseClient

// Letters-only isolation tag (UUID hex → a–f), so it's a clean name/plate substring.
const TAG = randomUUID().replace(/[0-9-]/g, '').slice(0, 6).toUpperCase()
const phone = () => `09${String(randomInt(1e8)).padStart(8, '0')}`

describe.skipIf(!RUN)('admin member management (Phase 8 Slice 2) — local DB integration', () => {
  let sb: Sb
  let repo: import('@/server/repositories/parkingRepository').ParkingRepository
  let svc: typeof import('@/server/services/memberAdminService')
  const ids: string[] = []

  // Members: A/B active, C bound. Names + plates carry TAG so a TAG query hits them.
  const A = { id: randomUUID(), phone: phone() }
  const B = { id: randomUUID(), phone: phone() }
  const C = { id: randomUUID(), phone: phone() }

  const mkUser = async (id: string, name: string, phoneNo: string, lineId: string | null = null) => {
    await sb.from('users').insert({ id, display_name: name, phone_number: phoneNo, line_id: lineId }).throwOnError()
    ids.push(id)
  }
  const mkVehicle = async (userId: string, plate: string, active = true) => {
    await sb.from('vehicles').insert({ user_id: userId, license_plate: plate, is_active: active }).throwOnError()
  }

  beforeAll(async () => {
    sb = (await import('@/lib/supabase/server')).getServiceClient()
    repo = (await import('@/server/repositories/parkingRepository')).createParkingRepository(sb)
    svc = await import('@/server/services/memberAdminService')

    await mkUser(A.id, `${TAG}A`, A.phone)
    await mkVehicle(A.id, `${TAG}CAR1`)
    // review_status is the authority since 0032; p2_eligible is generated from it.
    await sb.from('user_eligibility').insert({
      user_id: A.id, review_status: 'approved', p2_reason: 'mobility_long',
      p2_valid_until: '2099-01-01', p2_review_date: '2098-12-01',
    }).throwOnError()
    await sb.from('eligibility_dependents').insert({
      user_id: A.id, dependent_kind: 'child', dependent_name: `${TAG}童`, dependent_birthdate: '2022-03-01',
    }).throwOnError()

    await mkUser(B.id, `${TAG}B`, B.phone)
    await mkVehicle(B.id, `${TAG}CAR2`)
    // Inactive: excluded from SEARCH/roster (a retired car is not a current one), but
    // present on the DETAIL page since 0038 — that is where it can be reactivated, and
    // where "sold it" has to be distinguishable from "never had it".
    await mkVehicle(B.id, `${TAG}OLD9`, false)

    await mkUser(C.id, `${TAG}C`, C.phone, `U${TAG}BOUND`)
  })

  afterAll(async () => {
    if (!RUN) return
    for (const id of ids) {
      await sb.from('binding_codes').delete().eq('user_id', id)
      await sb.from('eligibility_dependents').delete().eq('user_id', id)
      await sb.from('user_eligibility').delete().eq('user_id', id)
      await sb.from('vehicles').delete().eq('user_id', id)
      await sb.from('users').delete().eq('id', id)
    }
  })

  // ── search ──────────────────────────────────────────────────────────────────

  it('a name-tag query finds all three, distinct, stable-sorted by name', async () => {
    const { items } = await svc.searchMembers({ query: TAG }, repo)
    const tagged = items.filter(i => i.displayName.startsWith(TAG))
    expect(tagged.map(i => i.displayName)).toEqual([`${TAG}A`, `${TAG}B`, `${TAG}C`])
    // Bound flag + masked phone.
    expect(tagged.find(i => i.displayName === `${TAG}C`)!.bound).toBe(true)
    expect(tagged.find(i => i.displayName === `${TAG}A`)!.phoneMasked).not.toContain(A.phone)
  })

  it('repo: phone-only and plate-only branches each hit the right member', async () => {
    const byPhone = await repo.searchMembers({ nameQuery: null, phoneQuery: A.phone, plateQuery: null, candidateCap: 250 })
    expect(byPhone.map(r => r.id)).toEqual([A.id])
    const byPlate = await repo.searchMembers({ nameQuery: null, phoneQuery: null, plateQuery: `${TAG}CAR1`, candidateCap: 250 })
    expect(byPlate.map(r => r.id)).toEqual([A.id])
  })

  it('repo: an inactive plate is neither searchable nor summarized', async () => {
    const byInactive = await repo.searchMembers({ nameQuery: null, phoneQuery: null, plateQuery: `${TAG}OLD9`, candidateCap: 250 })
    expect(byInactive).toEqual([])
    const bTag = await repo.searchMembers({ nameQuery: `${TAG}B`, phoneQuery: null, plateQuery: null, candidateCap: 250 })
    expect(bTag[0].plates).toEqual([`${TAG}CAR2`])   // OLD9 excluded
  })

  it('repo: a member matching name + phone + plate at once is returned exactly once', async () => {
    const rows = await repo.searchMembers({
      nameQuery: `${TAG}A`, phoneQuery: A.phone, plateQuery: `${TAG}CAR1`, candidateCap: 250,
    })
    expect(rows.filter(r => r.id === A.id)).toHaveLength(1)
  })

  it('service hasMore: limit 1 against 3 matches → one item, hasMore true', async () => {
    const { items, hasMore } = await svc.searchMembers({ query: TAG, limit: 1 }, repo)
    expect(items).toHaveLength(1)
    expect(hasMore).toBe(true)
  })

  // ── detail ──────────────────────────────────────────────────────────────────

  it('detail: full shape incl. vehicles, eligibility, dependents; bound flag not line_id', async () => {
    const d = (await svc.getMemberDetail(A.id, repo))!
    expect(d.phone).toBe(A.phone)
    expect(d.bound).toBe(false)
    expect(d.vehicles).toEqual([
      { id: expect.any(String), plate: `${TAG}CAR1`, nickname: null, isActive: true },
    ])
    expect(d.eligibility).toMatchObject({ p2Eligible: true, p2Reason: 'mobility_long', p2ValidUntil: '2099-01-01', p2ReviewDate: '2098-12-01' })
    expect(d.dependents).toEqual([{ kind: 'child', name: `${TAG}童`, birthdate: '2022-03-01' }])
    expect(JSON.stringify(d)).not.toContain('line_id')
  })

  it('detail: eligibility null when the member has no eligibility row', async () => {
    const d = (await svc.getMemberDetail(B.id, repo))!
    expect(d.eligibility).toBeNull()
    // Active first, then the retired one — each with the id the maintenance actions target.
    expect(d.vehicles).toEqual([
      { id: expect.any(String), plate: `${TAG}CAR2`, nickname: null, isActive: true },
      { id: expect.any(String), plate: `${TAG}OLD9`, nickname: null, isActive: false },
    ])
  })

  it('detail: unknown id → null', async () => {
    expect(await svc.getMemberDetail(randomUUID(), repo)).toBeNull()
  })

  // ── issue code ────────────────────────────────────────────────────────────────

  it('issue: unbound member → binding_codes row written with created_by audit', async () => {
    const res = await svc.issueMemberBindingCode({ userId: A.id, ttlDays: 30, createdBy: 'admin:tester' }, repo)
    expect(res.ok).toBe(true)
    const code = (res as { code: string }).code
    const { data } = await sb.from('binding_codes').select('user_id, created_by, consumed_at').eq('code', code).single()
    expect(data!.user_id).toBe(A.id)
    expect(data!.created_by).toBe('admin:tester')
    expect(data!.consumed_at).toBeNull()
  })

  it('issue: bound member → already_bound (precheck), no code written', async () => {
    const res = await svc.issueMemberBindingCode({ userId: C.id, createdBy: 'admin:tester' }, repo)
    expect(res).toEqual({ ok: false, reason: 'already_bound' })
    const { data } = await sb.from('binding_codes').select('id').eq('user_id', C.id)
    expect(data).toEqual([])
  })

  it('issue: unknown member → member_not_found', async () => {
    expect(await svc.issueMemberBindingCode({ userId: randomUUID(), createdBy: 'admin:tester' }, repo))
      .toEqual({ ok: false, reason: 'member_not_found' })
  })
})

// Wave 1c (#5A) — roster browse. listMembers has NO filter (it is the whole roster), so the seed
// rows are in the result set too: assert properties that hold ALONGSIDE them, not fixed contents.
describe.skipIf(!RUN)('listMembers (Wave 1c #5A) — local DB integration', () => {
  let sb: Sb
  let repo: import('@/server/repositories/parkingRepository').ParkingRepository
  const ids: string[] = []
  const RTAG = `ZZ${randomUUID().replace(/[0-9-]/g, '').slice(0, 5).toUpperCase()}`

  const mkUser = async (name: string) => {
    const id = randomUUID()
    await sb.from('users').insert({ id, display_name: name, phone_number: phone() }).throwOnError()
    ids.push(id)
    return id
  }
  const mkVehicle = async (
    userId: string, plate: string,
    opts: { active?: boolean; createdAt?: string; id?: string } = {},
  ) => {
    await sb.from('vehicles').insert({
      id: opts.id ?? randomUUID(), user_id: userId, license_plate: plate,
      is_active: opts.active ?? true,
      ...(opts.createdAt ? { created_at: opts.createdAt } : {}),
    }).throwOnError()
  }

  // The roster is unfiltered, so locate a seeded member by paging through it (bounded by total).
  const findByName = async (name: string) => {
    const limit = 50
    const first = await repo.listMembers({ limit, offset: 0 })
    for (let offset = 0; offset < Math.max(first.total, 1); offset += limit) {
      const { rows } = offset === 0 ? first : await repo.listMembers({ limit, offset })
      const hit = rows.find(r => r.display_name === name)
      if (hit) return hit
    }
    return null
  }

  // Same created_at on both cars → only the id tie-break makes the summary's first plate stable.
  const [lowVehicleId, highVehicleId] = [randomUUID(), randomUUID()].sort()

  beforeAll(async () => {
    sb = (await import('@/lib/supabase/server')).getServiceClient()
    repo = (await import('@/server/repositories/parkingRepository')).createParkingRepository(sb)

    const multi = await mkUser(`${RTAG}MULTI`)
    await mkVehicle(multi, `${RTAG}AAA1`, { createdAt: '2099-01-01T00:00:00Z', id: lowVehicleId })
    await mkVehicle(multi, `${RTAG}BBB2`, { createdAt: '2099-01-01T00:00:00Z', id: highVehicleId })
    await mkVehicle(multi, `${RTAG}OLD9`, { active: false }) // inactive → must not be listed

    await mkUser(`${RTAG}SOLO`)
  })

  afterAll(async () => {
    if (!RUN) return
    for (const id of ids) {
      await sb.from('vehicles').delete().eq('user_id', id)
      await sb.from('users').delete().eq('id', id)
    }
  })

  it('returns a bounded window, a real total, and DB-ordered rows', async () => {
    const { rows, total } = await repo.listMembers({ limit: 5, offset: 0 })
    expect(total).toBeGreaterThanOrEqual(ids.length) // seeded members are in the roster
    expect(rows.length).toBeLessThanOrEqual(5)
    // Ordered in the DB by (display_name, id) — offset paging is only correct over a total order.
    const names = rows.map(r => r.display_name)
    expect([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(names)
  })

  it('consecutive pages do not overlap or repeat a member', async () => {
    const p1 = await repo.listMembers({ limit: 2, offset: 0 })
    const p2 = await repo.listMembers({ limit: 2, offset: 2 })
    const overlap = p1.rows.map(r => r.id).filter(id => p2.rows.some(r => r.id === id))
    expect(overlap).toEqual([])
  })

  it('aggregates only ACTIVE plates, with a stable first plate when created_at ties', async () => {
    const multi = await findByName(`${RTAG}MULTI`)
    expect(multi).not.toBeNull()
    expect(multi!.plates).toEqual([`${RTAG}AAA1`, `${RTAG}BBB2`]) // lower vehicle id first
    expect(multi!.plates).not.toContain(`${RTAG}OLD9`)            // inactive excluded

    const solo = await findByName(`${RTAG}SOLO`)
    expect(solo!.plates).toEqual([])
  })

  it('an offset past the end returns no rows but still reports the real total', async () => {
    const { total } = await repo.listMembers({ limit: 1, offset: 0 })
    const past = await repo.listMembers({ limit: 25, offset: total + 100 })
    expect(past.rows).toEqual([])
    expect(past.total).toBe(total)
  })
})
