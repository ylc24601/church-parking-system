import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeMockRepo, asRepo, type MockRepo } from './mockRepo'
import { computeAdminTodoCounts, getAdminTodoSnapshot, p2ReviewCount } from '@/server/services/adminTodoService'
import type { EligibilityTodoCandidate, OutboxHealth } from '@/server/repositories/parkingRepository'

// taipeiToday(NOW) === '2026-07-12'.
const NOW = new Date('2026-07-12T00:00:00Z')
const TODAY = '2026-07-12'

const cand = (over: Partial<EligibilityTodoCandidate>): EligibilityTodoCandidate => ({
  user_id: '11111111-1111-4111-8111-111111111111',
  p2_valid_from: null,
  p2_valid_until: null,
  p2_review_date: null,
  ...over,
})

const health = (over: Partial<OutboxHealth>): OutboxHealth => ({
  due: 0,
  due_by_template: {},
  pending: 0,
  retrying: 0,
  processing: 0,
  stale_processing: 0,
  failed: 0,
  failed_by_error: {},
  sent_last_24h: 0,
  oldest_pending_at: null,
  oldest_due_at: null,
  oldest_failed_at: null,
  next_retry_at: null,
  ...over,
})

const minsBeforeNow = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString()

// ── p2ReviewCount: authoritative classifier over the candidate superset ───────────
describe('p2ReviewCount — classifier boundaries', () => {
  it('counts expired + review_due; excludes today-boundary, not_yet_effective, permanent; dedupes both-due', () => {
    const rows: EligibilityTodoCandidate[] = [
      cand({ user_id: 'a', p2_valid_until: '2026-07-11' }),                              // expired (yesterday) → in
      cand({ user_id: 'b', p2_review_date: '2026-07-12' }),                              // review_due (today) → in
      cand({ user_id: 'c', p2_valid_until: '2026-07-12' }),                              // last day == today → active → OUT
      cand({ user_id: 'd', p2_valid_from: '2026-07-20', p2_review_date: '2026-07-01' }), // not_yet_effective → OUT
      cand({ user_id: 'e', p2_valid_until: '2026-07-05', p2_review_date: '2026-07-06' }),// both due → count ONCE
    ]
    expect(p2ReviewCount(rows, TODAY)).toBe(3) // a, b, e
  })

  it('empty candidate set → 0', () => {
    expect(p2ReviewCount([], TODAY)).toBe(0)
  })
})

// Fixed thresholds (= the sensitive defaults) so the ops verdict never depends on ambient env.
let savedEnv: Record<string, string | undefined>
beforeEach(() => {
  savedEnv = {
    OUTBOX_ALERT_FAILED_MAX: process.env.OUTBOX_ALERT_FAILED_MAX,
    OUTBOX_ALERT_STALE_MAX: process.env.OUTBOX_ALERT_STALE_MAX,
    OUTBOX_ALERT_PENDING_STALE_MINUTES: process.env.OUTBOX_ALERT_PENDING_STALE_MINUTES,
  }
  process.env.OUTBOX_ALERT_FAILED_MAX = '0'
  process.env.OUTBOX_ALERT_STALE_MAX = '0'
  process.env.OUTBOX_ALERT_PENDING_STALE_MINUTES = '15'
})
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  vi.restoreAllMocks()
})

describe('computeAdminTodoCounts — P2 via minimal candidate query', () => {
  it('reads the candidate query with today, classifies, and pulls no list/name query', async () => {
    const repo: MockRepo = makeMockRepo({
      countOpenPastoralAlerts: vi.fn(async () => 0),
      listEligibilityTodoCandidates: vi.fn(async () => [
        cand({ user_id: 'a', p2_valid_until: '2026-07-11' }),
        cand({ user_id: 'b', p2_review_date: '2026-07-12' }),
      ]),
    })
    const counts = await computeAdminTodoCounts({ now: NOW, role: 'superadmin' }, asRepo(repo))
    expect(counts.p2Review).toBe(2)
    expect(repo.listEligibilityTodoCandidates).toHaveBeenCalledWith(TODAY)
    expect(repo.listEligibilityReview).not.toHaveBeenCalled()
  })
})

describe('computeAdminTodoCounts — role gating (#17 C)', () => {
  it('clerk → plain notificationHealth but ops:null; NO technical counts reach the client', async () => {
    const repo: MockRepo = makeMockRepo({
      countOpenPastoralAlerts: vi.fn(async () => 7),
      listEligibilityTodoCandidates: vi.fn(async () => []),
      getOutboxHealth: vi.fn(async () => health({})), // healthy
    })
    const counts = await computeAdminTodoCounts({ now: NOW, role: 'clerk' }, asRepo(repo))
    // The clerk DOES get a verdict now (health is fetched), but only the enum — no ops object.
    expect(counts).toEqual({ p2Review: 0, pastoralOpen: 7, notificationHealth: 'healthy', ops: null })
    expect(repo.getOutboxHealth).toHaveBeenCalledTimes(1)
    expect(counts.ops).toBeNull() // no backlog/attention number leaks to a clerk
  })

  it('clerk with an unhealthy pipeline → notificationHealth:attention, still ops:null (no counts)', async () => {
    const repo: MockRepo = makeMockRepo({
      countOpenPastoralAlerts: vi.fn(async () => 0),
      listEligibilityTodoCandidates: vi.fn(async () => []),
      getOutboxHealth: vi.fn(async () => health({ failed: 5 })),
    })
    const counts = await computeAdminTodoCounts({ now: NOW, role: 'clerk' }, asRepo(repo))
    expect(counts.notificationHealth).toBe('attention')
    expect(counts.ops).toBeNull()
  })

  it('superadmin → both the plain verdict and the technical ops object', async () => {
    const repo: MockRepo = makeMockRepo({
      countOpenPastoralAlerts: vi.fn(async () => 0),
      listEligibilityTodoCandidates: vi.fn(async () => []),
      getOutboxHealth: vi.fn(async () => health({ failed: 2 })),
    })
    const counts = await computeAdminTodoCounts({ now: NOW, role: 'superadmin' }, asRepo(repo))
    expect(counts.notificationHealth).toBe('attention')
    expect(counts.ops).toEqual({ backlog: 0, attention: 2 })
  })
})

describe('computeAdminTodoCounts — notification-health failure is isolated (#17 C)', () => {
  it('clerk: health query throws → P2/pastoral survive, verdict unavailable, ops null, fixed log', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const repo: MockRepo = makeMockRepo({
      countOpenPastoralAlerts: vi.fn(async () => 4),
      listEligibilityTodoCandidates: vi.fn(async () => [cand({ user_id: 'a', p2_valid_until: '2026-07-11' })]),
      getOutboxHealth: vi.fn(async () => { throw new Error('boom') }),
    })
    const counts = await computeAdminTodoCounts({ now: NOW, role: 'clerk' }, asRepo(repo))
    expect(counts).toEqual({ p2Review: 1, pastoralOpen: 4, notificationHealth: 'unavailable', ops: null })
    expect(counts.notificationHealth).not.toBe('healthy') // never fail-open
    expect(spy).toHaveBeenCalledWith('admin_notification_health_failed')
    expect(spy.mock.calls[0]).toHaveLength(1) // fixed code only, no error / query data
  })

  it('superadmin: health query throws → ops null, P2/pastoral survive, verdict unavailable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const repo: MockRepo = makeMockRepo({
      countOpenPastoralAlerts: vi.fn(async () => 2),
      listEligibilityTodoCandidates: vi.fn(async () => []),
      getOutboxHealth: vi.fn(async () => { throw new Error('boom') }),
    })
    const counts = await computeAdminTodoCounts({ now: NOW, role: 'superadmin' }, asRepo(repo))
    expect(counts).toEqual({ p2Review: 0, pastoralOpen: 2, notificationHealth: 'unavailable', ops: null })
  })
})

describe('computeAdminTodoCounts — ops (backlog + attention, no healthy field)', () => {
  const runOps = async (h: OutboxHealth) => {
    const repo: MockRepo = makeMockRepo({
      countOpenPastoralAlerts: vi.fn(async () => 0),
      listEligibilityTodoCandidates: vi.fn(async () => []),
      getOutboxHealth: vi.fn(async () => h),
    })
    return (await computeAdminTodoCounts({ now: NOW, role: 'superadmin' }, asRepo(repo))).ops
  }

  it('failed / stale present → attention = failed + stale', async () => {
    expect(await runOps(health({ failed: 2, stale_processing: 1 }))).toEqual({ backlog: 0, attention: 3 })
  })

  it('ONLY a stale due backlog (failed=0, stale=0) → attention = due (the due_backlog_stale fix)', async () => {
    expect(await runOps(health({ due: 4, oldest_due_at: minsBeforeNow(20) }))).toEqual({ backlog: 4, attention: 4 })
  })

  it('due backlog present but NOT stale → healthy: attention 0, backlog surfaced for "通知待送"', async () => {
    expect(await runOps(health({ due: 4, oldest_due_at: minsBeforeNow(5) }))).toEqual({ backlog: 4, attention: 0 })
  })
})

describe('getAdminTodoSnapshot — fail-soft', () => {
  it('a query throwing → counts:null (never "all zero"), snapshotAt set, fixed error logged', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const repo: MockRepo = makeMockRepo({
      countOpenPastoralAlerts: vi.fn(async () => { throw new Error('boom') }),
      listEligibilityTodoCandidates: vi.fn(async () => []),
    })
    const snap = await getAdminTodoSnapshot('superadmin', asRepo(repo), NOW)
    expect(snap.counts).toBeNull()
    expect(snap.snapshotAt).toBe(NOW.toISOString())
    expect(spy).toHaveBeenCalledWith('admin_todo_snapshot_failed')
    expect(spy.mock.calls[0]).toHaveLength(1) // fixed code only, no error object leaked
  })

  it('success → counts populated, snapshotAt set', async () => {
    const repo: MockRepo = makeMockRepo({
      countOpenPastoralAlerts: vi.fn(async () => 1),
      listEligibilityTodoCandidates: vi.fn(async () => []),
    })
    const snap = await getAdminTodoSnapshot('clerk', asRepo(repo), NOW)
    expect(snap.counts).toEqual({ p2Review: 0, pastoralOpen: 1, notificationHealth: 'healthy', ops: null })
    expect(snap.snapshotAt).toBe(NOW.toISOString())
  })
})
