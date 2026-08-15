import { describe, expect, it, vi } from 'vitest'
import { makeMockRepo, asRepo, type MockRepo } from './mockRepo'
import {
  getMemberDetail,
  issueMemberBindingCode,
  listMembersPage,
  searchMembers,
} from '@/server/services/memberAdminService'
import type { MemberSearchRow, MemberAdminDetailRow } from '@/server/repositories/parkingRepository'

function run(over: Partial<MockRepo> = {}) {
  const repo = makeMockRepo(over)
  return { repo, r: asRepo(repo) }
}

const memberRow = (over: Partial<MemberSearchRow> = {}): MemberSearchRow => ({
  id: '11111111-1111-4111-8111-111111111111',
  display_name: '王小明',
  phone_number: '0912345678',
  role: 'user',
  line_id: null,
  plates: ['ABC-1234'],
  ...over,
})

describe('searchMembers — query cleaning (whole-table protection)', () => {
  it('splits a mixed query into per-branch cleaned values', async () => {
    const search = vi.fn(async () => [])
    const { r } = run({ searchMembers: search })
    await searchMembers({ query: '  ABC-1234  ' }, r)
    expect(search).toHaveBeenCalledWith({
      nameQuery: 'ABC-1234',       // trimmed
      phoneQuery: '1234',          // 4 digits (>=3)
      plateQuery: 'ABC1234',       // upper + strip non-alnum
      candidateCap: 250,
    })
  })

  it('a pure-digit query drives the phone branch (and name), not plate below threshold', async () => {
    const search = vi.fn(async () => [])
    const { r } = run({ searchMembers: search })
    await searchMembers({ query: '0912' }, r)
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ nameQuery: '0912', phoneQuery: '0912', plateQuery: '0912' }),
    )
  })

  it('a pure-Chinese query only drives the name branch (no phone/plate)', async () => {
    const search = vi.fn(async () => [])
    const { r } = run({ searchMembers: search })
    await searchMembers({ query: '王小明' }, r)
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ nameQuery: '王小明', phoneQuery: null, plateQuery: null }),
    )
  })

  it.each([
    ['%', ''],
    ['_', ''],
    ['%%%', ''],
    ['%_%', ''],
  ])('strips LIKE wildcards so %s cannot match the whole table', async (query) => {
    const search = vi.fn(async () => [])
    const { r } = run({ searchMembers: search })
    const res = await searchMembers({ query }, r)
    expect(search).not.toHaveBeenCalled()      // nothing left after stripping → no DB hit
    expect(res).toEqual({ items: [], hasMore: false })
  })

  it.each([
    ['   '],
    ['!!!'],
    ['😀😀'],
    ['%_'],
  ])('punctuation/emoji/whitespace-only (%s) never hits the DB', async (query) => {
    const search = vi.fn(async () => [])
    const { r } = run({ searchMembers: search })
    const res = await searchMembers({ query }, r)
    expect(search).not.toHaveBeenCalled()
    expect(res).toEqual({ items: [], hasMore: false })
  })

  it('phone branch needs >=3 digits; plate branch needs >=2 alnum', async () => {
    const search = vi.fn(async () => [])
    const { r } = run({ searchMembers: search })
    // "A1" → name "A1", plate "A1" (2 alnum, ok), phone "1" (<3, skip)
    await searchMembers({ query: 'A1' }, r)
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ nameQuery: 'A1', phoneQuery: null, plateQuery: 'A1' }),
    )
  })
})

describe('searchMembers — masking + hasMore', () => {
  it('masks the phone, summarizes plates, derives bound, and never leaks the full number', async () => {
    const { r } = run({
      searchMembers: vi.fn(async () => [
        memberRow({ phone_number: '0912345678', plates: ['ABC-1234', 'XYZ-5678'], line_id: 'U_abc' }),
      ]),
    })
    const { items } = await searchMembers({ query: '王' }, r)
    expect(items[0]).toEqual({
      id: '11111111-1111-4111-8111-111111111111',
      displayName: '王小明',
      phoneMasked: '0912***678',
      plateSummary: 'ABC-1234 ＋1',
      role: 'user',
      bound: true,
    })
    expect(JSON.stringify(items)).not.toContain('0912345678')
  })

  it('null phone → em dash; single plate → no ＋N; no plate → empty', async () => {
    const { r } = run({
      searchMembers: vi.fn(async () => [
        memberRow({ id: 'a', phone_number: null, plates: [] }),
        memberRow({ id: 'b', plates: ['ABC-1234'] }),
      ]),
    })
    const { items } = await searchMembers({ query: '王' }, r)
    expect(items[0].phoneMasked).toBe('—')
    expect(items[0].plateSummary).toBe('')
    expect(items[1].plateSummary).toBe('ABC-1234')
  })

  it('hasMore true when the repo returns more than the limit; items sliced to the limit', async () => {
    const rows = Array.from({ length: 26 }, (_, i) => memberRow({ id: `id-${i}` }))
    const { r } = run({ searchMembers: vi.fn(async () => rows) })
    const { items, hasMore } = await searchMembers({ query: '王' }, r) // default limit 25
    expect(items).toHaveLength(25)
    expect(hasMore).toBe(true)
  })
})

describe('getMemberDetail', () => {
  const detailRow = (over: Partial<MemberAdminDetailRow> = {}): MemberAdminDetailRow => ({
    display_name: '王小明',
    phone_number: '0912345678',
    role: 'user',
    line_id: null,
    vehicles: [
      { id: 'v-1', license_plate: 'ABC-1234', nickname: '家庭車', is_active: true },
    ],
    eligibility: {
      p2_eligible: true, review_status: 'approved', p2_reason: 'mobility_long', p2_valid_from: null,
      p2_valid_until: '2027-01-01', p2_review_date: '2026-12-01', p2_child_birthdate: null,
      review_note: null, review_version: 2, reviewed_at: '2026-06-01T00:00:00Z',
    },
    dependents: [{ kind: 'child', name: '小華', birthdate: '2022-03-01' }],
    ...over,
  })

  it('returns the FULL phone but only a bound boolean — the raw line_id never reaches the DTO', async () => {
    const { r } = run({ getMemberAdminDetail: vi.fn(async () => detailRow({ line_id: 'U_secret' })) })
    const d = (await getMemberDetail('u1', r))!
    expect(d.phone).toBe('0912345678')
    expect(d.bound).toBe(true)
    expect(JSON.stringify(d)).not.toContain('U_secret')
    expect(JSON.stringify(d)).not.toContain('line_id')
  })

  it('handles null eligibility and empty vehicles/dependents', async () => {
    const { r } = run({
      getMemberAdminDetail: vi.fn(async () => detailRow({ eligibility: null, vehicles: [], dependents: [] })),
    })
    const d = (await getMemberDetail('u1', r))!
    expect(d.eligibility).toBeNull()
    expect(d.vehicles).toEqual([])
    expect(d.dependents).toEqual([])
  })

  it('null passes through when the member does not exist', async () => {
    const { r } = run({ getMemberAdminDetail: vi.fn(async () => null) })
    expect(await getMemberDetail('missing', r)).toBeNull()
  })
})

describe('issueMemberBindingCode', () => {
  const unbound: MemberAdminDetailRow = {
    display_name: '王小明', phone_number: '0912345678', role: 'user', line_id: null,
    vehicles: [], eligibility: null, dependents: [],
  }

  it('member not found → typed member_not_found (no code issued)', async () => {
    const insert = vi.fn(async () => ({ inserted: true }))
    const { r } = run({ getMemberAdminDetail: vi.fn(async () => null), insertBindingCode: insert })
    expect(await issueMemberBindingCode({ userId: 'x', createdBy: 'admin:alice' }, r))
      .toEqual({ ok: false, reason: 'member_not_found' })
    expect(insert).not.toHaveBeenCalled()
  })

  it('already bound → typed already_bound (precheck; NOT a DB invariant)', async () => {
    const insert = vi.fn(async () => ({ inserted: true }))
    const { r } = run({
      getMemberAdminDetail: vi.fn(async () => ({ ...unbound, line_id: 'U_bound' })),
      insertBindingCode: insert,
    })
    expect(await issueMemberBindingCode({ userId: 'u1', createdBy: 'admin:alice' }, r))
      .toEqual({ ok: false, reason: 'already_bound' })
    expect(insert).not.toHaveBeenCalled()
  })

  it('unbound → wraps issueBindingCode and returns the full code + createdBy audit', async () => {
    const insert = vi.fn(async () => ({ inserted: true }))
    const { repo, r } = run({
      getMemberAdminDetail: vi.fn(async () => unbound),
      getUserDisplayName: vi.fn(async () => '王小明'),
      insertBindingCode: insert,
    })
    const res = await issueMemberBindingCode({ userId: 'u1', ttlDays: 30, note: '小組長轉交', createdBy: 'admin:alice' }, r)
    expect(res).toMatchObject({ ok: true, displayName: '王小明' })
    expect((res as { code: string }).code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/)
    const arg = (repo.insertBindingCode as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(arg.createdBy).toBe('admin:alice')
    expect(arg.note).toBe('小組長轉交')
  })

  it('rejects an out-of-range ttl before touching the member', async () => {
    const { repo, r } = run({ getMemberAdminDetail: vi.fn(async () => unbound) })
    for (const bad of [0, 91, 1.5, Number.NaN]) {
      await expect(issueMemberBindingCode({ userId: 'u1', ttlDays: bad, createdBy: 'admin:alice' }, r))
        .rejects.toThrow(/ttlDays/)
    }
    expect(repo.getMemberAdminDetail).not.toHaveBeenCalled()
  })
})

// Wave 1c (#5A) — roster browse. `page` comes from a public query param, so the offset maths and
// the masking are the whole point of these tests.
describe('listMembersPage — paging maths + masking', () => {
  const listing = (rows: MemberSearchRow[], total: number) =>
    run({ listMembers: vi.fn(async () => ({ rows, total })) })

  it.each([
    ['page 1', 1, 0],
    ['page 3', 3, 50],
    ['undefined → 1', undefined, 0],
    ['0 → 1', 0, 0],
    ['-3 → 1', -3, 0],
    ['NaN → 1', NaN, 0],
    ['1.5 → 1', 1.5, 0],
    ['beyond safe integer → 1', Number.MAX_SAFE_INTEGER + 1, 0],
  ])('%s asks the repo for the right offset', async (_label, page, offset) => {
    const { repo, r } = listing([], 0)
    await listMembersPage({ page: page as number | undefined }, r)
    expect(repo.listMembers).toHaveBeenCalledWith({ limit: 25, offset })
  })

  it('falls back to page 1 as a pair when the offset would leave the safe range', async () => {
    const { repo, r } = listing([], 0)
    // a safe page, but page * limit is not
    const res = await listMembersPage({ page: Number.MAX_SAFE_INTEGER, limit: 100 }, r)
    expect(repo.listMembers).toHaveBeenCalledWith({ limit: 100, offset: 0 })
    expect(res.page).toBe(1) // never report page N while showing page 1's rows
  })

  it.each([
    ['over MAX_LIMIT', 500, 100],
    ['under 1', 0, 1],
    ['default', undefined, 25],
  ])('clamps limit (%s)', async (_label, limit, expected) => {
    const { repo, r } = listing([], 0)
    await listMembersPage({ limit: limit as number | undefined }, r)
    expect(repo.listMembers).toHaveBeenCalledWith({ limit: expected, offset: 0 })
  })

  it.each([
    ['exactly one full page', 25, 1],
    ['one over a page', 26, 2],
    ['empty roster is one page, never zero', 0, 1],
    ['two full pages', 50, 2],
  ])('totalPages: %s', async (_label, total, expected) => {
    const { r } = listing([], total)
    expect((await listMembersPage({}, r)).totalPages).toBe(expected)
  })

  it('masks the phone and never leaks a full number or line_id', async () => {
    const { r } = listing([
      memberRow({ phone_number: '0912345678', line_id: 'U-real-line-id' }),
      memberRow({ id: 'x', phone_number: null, plates: [] }),
    ], 2)
    const res = await listMembersPage({}, r)

    expect(res.items[0].phoneMasked).not.toBe('0912345678')
    expect(res.items[0].bound).toBe(true)
    expect(res.items[1].phoneMasked).toBe('—') // no phone at all
    const json = JSON.stringify(res)
    expect(json).not.toContain('0912345678')
    expect(json).not.toContain('U-real-line-id')
  })

  it.each([
    ['no plates', [], ''],
    ['one plate', ['ABC-1234'], 'ABC-1234'],
    ['several plates', ['ABC-1234', 'DEF-5678', 'GHI-9012'], 'ABC-1234 ＋2'],
  ])('plateSummary: %s', async (_label, plates, expected) => {
    const { r } = listing([memberRow({ plates: plates as string[] })], 1)
    expect((await listMembersPage({}, r)).items[0].plateSummary).toBe(expected)
  })

  it('an empty roster returns an empty page without throwing', async () => {
    const { r } = listing([], 0)
    expect(await listMembersPage({ page: 999 }, r)).toMatchObject({ items: [], totalPages: 1, total: 0 })
  })
})
