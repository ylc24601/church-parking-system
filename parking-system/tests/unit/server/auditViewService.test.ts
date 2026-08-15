import { describe, expect, it, vi } from 'vitest'
import { makeMockRepo, asRepo, type MockRepo } from './mockRepo'
import {
  decodeAuditCursor,
  encodeAuditCursor,
  idSuffix,
  listAuditTimeline,
} from '@/server/services/auditViewService'
import type { AuditLogRow } from '@/server/repositories/parkingRepository'

function run(over: Partial<MockRepo> = {}) {
  const repo = makeMockRepo(over)
  return { repo, r: asRepo(repo) }
}

// A real PostgREST timestamp: MICROSECOND precision and a +00:00 offset. Both
// details are load-bearing — see the round-trip test below.
const TS = '2026-07-17T01:31:40.355854+00:00'
const ADMIN_ID = '11111111-1111-4111-8111-111111111111'
const SESSION_ID = '22222222-2222-4222-8222-222222222222'
const TARGET_ID = '33333333-3333-4333-8333-333333333333'
const REQ_ID = '44444444-4444-4444-8444-444444444444'

const row = (over: Partial<AuditLogRow> = {}): AuditLogRow => ({
  id: '99999999-9999-4999-8999-999999999999',
  created_at: TS,
  actor_type: 'admin',
  actor_id: ADMIN_ID,
  actor_session_id: SESSION_ID,
  actor_role_snapshot: null,
  action: 'admin_account.disable',
  entity_type: 'admin_account',
  entity_id: TARGET_ID,
  weekly_event_id: null,
  request_id: REQ_ID,
  result: 'success',
  metadata_redacted: { disabled_to: true, state_changed: true },
  ...over,
})

const adminRow = (over: Record<string, unknown> = {}) => ({
  id: ADMIN_ID,
  username: 'alice',
  display_name: '王姐妹',
  locked_at: null,
  disabled_at: null,
  created_at: new Date('2026-01-01T00:00:00Z'),
  ...over,
})

const timeline = (rows: AuditLogRow[], admins: unknown[] = [adminRow()]) =>
  run({
    listAuditLogs: vi.fn(async () => ({ rows })),
    listAdminAccounts: vi.fn(async () => admins),
  })

describe('audit cursor — round-trip', () => {
  it('preserves the exact microsecond timestamp', () => {
    // THE regression guard for this slice. created_at comes back with microseconds
    // (…40.355854), but new Date(ts).toISOString() yields …40.355Z — and a query
    // filtering created_at.eq.<truncated> matches ZERO rows (verified against real
    // PostgREST). A cursor that loses those digits silently drops the tiebreaker
    // arm and starts SKIPPING rows, and would look fine in any test without ties.
    const decoded = decodeAuditCursor(encodeAuditCursor({ created_at: TS, id: ADMIN_ID }))
    expect(decoded).toEqual({ v: 1, createdAt: TS, id: ADMIN_ID })
    expect(decoded!.createdAt).toBe(TS)
    expect(decoded!.createdAt).not.toBe(new Date(TS).toISOString())
  })
})

describe('audit cursor — malformed input always means "newest page", never a throw', () => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url')

  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['not base64url', '!!!not base64!!!'],
    ['not JSON', Buffer.from('hello', 'utf8').toString('base64url')],
    ['JSON but not an object', b64('a string')],
    ['an array', b64([1, 2])],
    ['null payload', b64(null)],
    ['missing v', b64({ createdAt: TS, id: ADMIN_ID })],
    ['unsupported v', b64({ v: 2, createdAt: TS, id: ADMIN_ID })],
    ['missing createdAt', b64({ v: 1, id: ADMIN_ID })],
    ['missing id', b64({ v: 1, createdAt: TS })],
    ['bad timestamp', b64({ v: 1, createdAt: 'yesterday', id: ADMIN_ID })],
    ['bad uuid', b64({ v: 1, createdAt: TS, id: 'not-a-uuid' })],
    ['extra keys (non-canonical)', b64({ v: 1, createdAt: TS, id: ADMIN_ID, evil: true })],
    ['over-length', 'A'.repeat(300)],
  ])('%s => null', (_label, raw) => {
    expect(decodeAuditCursor(raw as string | undefined)).toBeNull()
  })

  it('a forged cursor reaches the repo as no cursor at all', async () => {
    const { repo, r } = timeline([])
    await listAuditTimeline({ cursor: 'garbage' }, r)
    expect(repo.listAuditLogs).toHaveBeenCalledWith({ limit: 26, before: undefined })
  })
})

describe('listAuditTimeline — paging', () => {
  it('asks for limit+1 and reports no next page when the extra row is absent', async () => {
    const { repo, r } = timeline([row()])
    const res = await listAuditTimeline({ limit: 25 }, r)
    expect(repo.listAuditLogs).toHaveBeenCalledWith({ limit: 26, before: undefined })
    expect(res.items).toHaveLength(1)
    expect(res.nextCursor).toBeNull()
  })

  it('trims the probe row and builds the next cursor from the LAST returned row', async () => {
    const rows = [
      row({ id: 'aaaaaaaa-0000-4000-8000-000000000001', created_at: TS }),
      row({ id: 'aaaaaaaa-0000-4000-8000-000000000002', created_at: '2026-07-16T01:00:00+00:00' }),
      row({ id: 'aaaaaaaa-0000-4000-8000-000000000003', created_at: '2026-07-15T01:00:00+00:00' }),
    ]
    const { r } = timeline(rows)
    const res = await listAuditTimeline({ limit: 2 }, r)

    expect(res.items.map(i => i.id)).toEqual([rows[0].id, rows[1].id])
    // The cursor must come from the last row SHOWN, not the probe row — otherwise
    // row 2 would be skipped on the next page.
    expect(decodeAuditCursor(res.nextCursor!)).toEqual({
      v: 1,
      createdAt: rows[1].created_at,
      id: rows[1].id,
    })
  })

  it('passes a valid cursor through to the repo verbatim', async () => {
    const { repo, r } = timeline([])
    await listAuditTimeline({ cursor: encodeAuditCursor({ created_at: TS, id: ADMIN_ID }) }, r)
    expect(repo.listAuditLogs).toHaveBeenCalledWith({
      limit: 26,
      before: { createdAt: TS, id: ADMIN_ID },
    })
  })

  it.each([
    [0, 1],
    [-5, 1],
    [1000, 100],
    [25.7, 25],
  ])('clamps limit %s to %s', async (given, expected) => {
    const { repo, r } = timeline([])
    await listAuditTimeline({ limit: given }, r)
    expect(repo.listAuditLogs).toHaveBeenCalledWith({ limit: expected + 1, before: undefined })
  })
})

describe('listAuditTimeline — actor resolution', () => {
  // The default row() carries a null snapshot (pre-0035), so the honest 「角色制度建立前」
  // suffix rides along on these — see the dedicated role-snapshot test below.
  it('shows an admin display name, and prefers username when display_name is null', async () => {
    const named = await listAuditTimeline({}, timeline([row()]).r)
    expect(named.items[0].actorLabel).toBe('王姐妹（角色制度建立前）')

    const fallback = await listAuditTimeline({}, timeline([row()], [adminRow({ display_name: null })]).r)
    expect(fallback.items[0].actorLabel).toBe('alice（角色制度建立前）')
  })

  it('appends the actor role AS OF the action (2C-2): known label, honest null, raw unknown', async () => {
    const known = await listAuditTimeline({}, timeline([row({ actor_role_snapshot: 'clerk' })]).r)
    expect(known.items[0].actorLabel).toBe('王姐妹（當時身分：幹事）')

    // null = written before roles existed. Not "missing" — an honest gap.
    const historical = await listAuditTimeline({}, timeline([row({ actor_role_snapshot: null })]).r)
    expect(historical.items[0].actorLabel).toBe('王姐妹（角色制度建立前）')

    // An unrecognized value shows raw rather than vanishing, mirroring 未知動作.
    const unknown = await listAuditTimeline({}, timeline([row({ actor_role_snapshot: 'future_role' })]).r)
    expect(unknown.items[0].actorLabel).toBe('王姐妹（當時身分：future_role）')
  })

  it('a deleted actor is a normal row, not an error', async () => {
    // audit_logs deliberately carries no FK on actor_id so the log outlives what it
    // names. That makes "admin not found" an expected state to render, not throw.
    const { r } = timeline([row({ actor_role_snapshot: 'superadmin' })], [])
    const res = await listAuditTimeline({}, r)
    expect(res.items[0].actorLabel).toBe(`已刪除管理員（ID 尾碼 ${idSuffix(ADMIN_ID)}）（當時身分：系統管理員）`)
  })

  it('never resolves a staff session to a person — even when a real admin shares that UUID', async () => {
    // The on-site PIN is a per-event credential every device shares, so the session
    // is the actor. Resolving it to a name would invent an accusation. This test
    // rigs the worst case: an admin row whose id is byte-identical to the session id.
    // entity is deliberately NOT an admin_account here, so the "no lookup happened"
    // assertion below is about the actor and nothing else.
    const { repo, r } = timeline(
      [row({
        actor_type: 'staff_session', actor_id: ADMIN_ID, actor_session_id: null,
        entity_type: 'audit', entity_id: null,
      })],
      [adminRow()],
    )
    const res = await listAuditTimeline({}, r)
    expect(res.items[0].actorLabel).toBe(`現場同工 session（尾碼 ${idSuffix(ADMIN_ID)}）`)
    expect(res.items[0].actorLabel).not.toContain('王姐妹')
    // The label must not imply an individual at all.
    expect(res.items[0].actorLabel).not.toContain('同工某')
    expect(repo.listAdminAccounts).not.toHaveBeenCalled()
  })

  it('shows a member actor as type + suffix, never a name', async () => {
    const { r } = timeline([row({ actor_type: 'member', actor_id: TARGET_ID, entity_type: 'audit', entity_id: null })])
    const res = await listAuditTimeline({}, r)
    expect(res.items[0].actorLabel).toBe(`會友（ID 尾碼 ${idSuffix(TARGET_ID)}）`)
  })

  it.each([
    ['system actor carries no id', { actor_type: 'system' as const, actor_id: null, actor_session_id: null }, '系統'],
    ['job with a run id', { actor_type: 'job' as const, actor_id: TARGET_ID, actor_session_id: null }, `系統工作（ID 尾碼 ${idSuffix(TARGET_ID)}）`],
    ['job without one', { actor_type: 'job' as const, actor_id: null, actor_session_id: null }, '系統工作'],
  ])('%s', async (_l, over, expected) => {
    const { r } = timeline([row({ ...over, entity_type: 'audit', entity_id: null })])
    const res = await listAuditTimeline({}, r)
    expect(res.items[0].actorLabel).toBe(expected)
  })
})

describe('listAuditTimeline — entity resolution stays inside its contract', () => {
  it('resolves admin_account entities to a name', async () => {
    const { r } = timeline([row({ entity_id: ADMIN_ID })])
    expect((await listAuditTimeline({}, r)).items[0].entityLabel).toBe('王姐妹')
  })

  it('renders every OTHER entity type as type + suffix, never resolving a member', async () => {
    // 2A-2 resolves admin_account only. When #10 makes entity_id a member, showing
    // that member's name must be a deliberate decision in that slice — not something
    // inherited from a generic resolver here.
    const { r } = timeline([row({ entity_type: 'user', entity_id: TARGET_ID })])
    const res = await listAuditTimeline({}, r)
    expect(res.items[0].entityLabel).toBe(`user（ID 尾碼 ${idSuffix(TARGET_ID)}）`)
    expect(res.items[0].entityLabel).not.toContain('王姐妹')
  })

  // Tier 0-2 (0038). Shipped without these and a real staged smoke showed the raw
  // 「member（ID 尾碼 …）」/「vehicle（…）」on the page. The label is the whole fix —
  // resolving either to a NAME stays deliberately out of scope (see the note above
  // ENTITY_TYPE_LABEL on why there is no generic resolver).
  it.each([
    ['member', '會友'],
    ['vehicle', '車輛'],
  ])('labels 0038 entity type %s as %s, with the id suffix and nothing more', async (type, label) => {
    const { r } = timeline([row({ entity_type: type, entity_id: TARGET_ID })])
    const res = await listAuditTimeline({}, r)
    expect(res.items[0].entityLabel).toBe(`${label}（ID 尾碼 ${idSuffix(TARGET_ID)}）`)
    expect(res.items[0].entityLabel).not.toContain('王姐妹')
  })
})

describe('listAuditTimeline — the DTO is the privacy boundary', () => {
  it('never carries raw metadata off the service, whatever a future writer put there', async () => {
    // The structural half is the type itself: AuditViewItem has no metadata field,
    // so the page cannot reach metadata_redacted even by mistake. This proves the
    // renderer doesn't launder it into `details` either.
    const sentinels = {
      disabled_to: true,
      state_changed: true,
      phone_number: '0912345678',
      line_id: 'Uffffffffffffffffffffffffffffffff',
      license_plate: 'ABC-1234',
      review_note: '因罹患重大疾病',
      password_hash: 'scrypt$aa$bb',
    }
    const { r } = timeline([row({ metadata_redacted: sentinels })])
    const res = await listAuditTimeline({}, r)

    const serialized = JSON.stringify(res)
    for (const leak of ['0912345678', 'Uffffffff', 'ABC-1234', '因罹患重大疾病', 'scrypt$', 'password_hash']) {
      expect(serialized).not.toContain(leak)
    }
    expect(res.items[0].unsupportedDetailCount).toBe(5)
    expect(res.items[0]).not.toHaveProperty('metadata_redacted')
  })

  it('keeps the full requestId for correlation while the UI shows only a suffix', async () => {
    const res = await listAuditTimeline({}, timeline([row()]).r)
    expect(res.items[0].requestId).toBe(REQ_ID)
    expect(idSuffix(REQ_ID)).toBe('444444')
  })
})
