import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Phase 4 Slice F — dead-letter requeue + outbox_health.oldest_due_at.
// Gated: `RUN_DB_TESTS=1` + reachable local Supabase (prereq: `npm run db:reset`).
try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may already be exported */
}
const RUN = process.env.RUN_DB_TESTS === '1'

type Sb = import('@supabase/supabase-js').SupabaseClient

const SUNDAY = '2099-10-04'
const NOW = new Date('2099-10-04T02:00:00Z')
const iso = (offsetSec: number) => new Date(NOW.getTime() + offsetSec * 1000).toISOString()

describe.skipIf(!RUN)('outbox requeue + oldest_due_at — local DB integration', () => {
  let sb: Sb
  let repo: import('@/server/repositories/parkingRepository').ParkingRepository
  let getOutboxHealth: typeof import('@/server/services/outboxHealthService').getOutboxHealth
  let requeueFailed: typeof import('@/server/services/requeueFailedService').requeueFailed
  const eventId = randomUUID()

  const k = (s: string) => `rq:${eventId.slice(0, 8)}:${s}`
  const row = async (dk: string) =>
    (await sb.from('notification_outbox').select('*').eq('dedupe_key', dk).single()).data!
  const statusOf = async (dk: string) => (await row(dk)).status as string

  beforeAll(async () => {
    sb = (await import('@/lib/supabase/server')).getServiceClient()
    repo = (await import('@/server/repositories/parkingRepository')).createParkingRepository(sb)
    getOutboxHealth = (await import('@/server/services/outboxHealthService')).getOutboxHealth
    requeueFailed = (await import('@/server/services/requeueFailedService')).requeueFailed

    const { data: existing } = await sb.from('weekly_events').select('id').eq('sunday_date', SUNDAY)
    for (const r of existing ?? []) {
      await sb.from('notification_outbox').delete().eq('weekly_event_id', r.id as string)
      await sb.from('weekly_events').delete().eq('id', r.id as string)
    }
    await sb.from('weekly_events').insert({
      id: eventId, sunday_date: SUNDAY, total_capacity: 23, blocked_spaces: 0, admin_reserved: 0,
    }).throwOnError()

    // PostgREST bulk insert fills omitted keys with NULL (not DEFAULT) → every not-null column must be
    // set on every row. Because pending-due overrides created_at, all rows must set it too.
    const base = { weekly_event_id: eventId, template_key: 'move_car_request', retry_count: 0, next_retry_at: iso(0), created_at: iso(0) }
    await sb.from('notification_outbox').insert([
      // 3 failed (terminal_403) + 2 failed (no_line_id) with retry/lock state to verify reset
      { ...base, dedupe_key: k('f-403-1'), status: 'failed', last_error: 'terminal_403', retry_count: 5 },
      { ...base, dedupe_key: k('f-403-2'), status: 'failed', last_error: 'terminal_403', retry_count: 5 },
      { ...base, dedupe_key: k('f-403-3'), status: 'failed', last_error: 'terminal_403', retry_count: 5 },
      { ...base, dedupe_key: k('f-nl-1'), status: 'failed', last_error: 'no_line_id', retry_count: 5, locked_at: iso(-100), locked_by: 'dead' },
      { ...base, dedupe_key: k('f-nl-2'), status: 'failed', last_error: 'no_line_id', retry_count: 5, locked_at: iso(-100), locked_by: 'dead' },
      // the four statuses requeue must NEVER touch
      { ...base, dedupe_key: k('sent'), status: 'sent', sent_at: iso(-3600) },
      { ...base, dedupe_key: k('proc'), status: 'processing', locked_at: iso(-10), locked_by: 'alive' },
      { ...base, dedupe_key: k('pending-due'), status: 'pending', next_retry_at: iso(-60), created_at: iso(-1200) },
      { ...base, dedupe_key: k('retrying-future'), status: 'retrying', next_retry_at: iso(3600), retry_count: 2 },
    ]).throwOnError()
  })

  afterAll(async () => {
    if (!RUN) return
    await sb.from('notification_outbox').delete().eq('weekly_event_id', eventId)
    await sb.from('weekly_events').delete().eq('id', eventId)
  })

  it('outbox_health.oldest_due_at reflects the oldest DUE row and ignores future-scheduled rows', async () => {
    const h = await getOutboxHealth({ now: NOW }, repo)
    expect(h.due).toBe(1)                                 // only pending-due (proc is fresh; retrying is future)
    expect(new Date(h.oldest_due_at!).getTime()).toBe(new Date(iso(-1200)).getTime()) // due pending's created_at, 20 min old
    expect(h.failed).toBe(5)
    expect(h.failed_by_error).toEqual({ terminal_403: 3, no_line_id: 2 })
  })

  it('dryRun (default) counts failed rows and mutates nothing', async () => {
    const before = (await sb.from('notification_outbox').select('dedupe_key, status')
      .eq('weekly_event_id', eventId).order('dedupe_key')).data

    const all = await requeueFailed({ now: NOW }, repo)
    expect(all).toEqual({ dryRun: true, wouldRequeue: 5 })
    const filtered = await requeueFailed({ now: NOW, errorCode: 'terminal_403' }, repo)
    expect(filtered).toEqual({ dryRun: true, wouldRequeue: 3 })
    const capped = await requeueFailed({ now: NOW, max: 2 }, repo)
    expect(capped).toEqual({ dryRun: true, wouldRequeue: 2 })

    const after = (await sb.from('notification_outbox').select('dedupe_key, status')
      .eq('weekly_event_id', eventId).order('dedupe_key')).data
    expect(after).toEqual(before)                         // no mutation on any dryRun
  })

  it('apply requeues only the filtered failed rows → pending with fields reset; others untouched', async () => {
    const res = await requeueFailed({ now: NOW, dryRun: false, errorCode: 'no_line_id' }, repo)
    expect(res).toEqual({ dryRun: false, requeued: 2 })

    // the two no_line_id rows are now pending with retry/lock/last_error reset and next_retry_at = now
    for (const dk of ['f-nl-1', 'f-nl-2']) {
      const r = await row(k(dk))
      expect(r.status).toBe('pending')
      expect(r.retry_count).toBe(0)
      expect(new Date(r.next_retry_at as string).getTime()).toBe(NOW.getTime())
      expect(r.locked_at).toBeNull()
      expect(r.locked_by).toBeNull()
      expect(r.last_error).toBeNull()
    }
    // terminal_403 failed rows are untouched (filter), and the four other statuses never change
    expect(await statusOf(k('f-403-1'))).toBe('failed')
    expect(await statusOf(k('f-403-2'))).toBe('failed')
    expect(await statusOf(k('f-403-3'))).toBe('failed')
    expect(await statusOf(k('sent'))).toBe('sent')
    expect(await statusOf(k('proc'))).toBe('processing')
    expect(await statusOf(k('pending-due'))).toBe('pending')
    expect(await statusOf(k('retrying-future'))).toBe('retrying')
  })

  it('re-running the same apply requeues 0 (nothing left failed for that code)', async () => {
    const again = await requeueFailed({ now: NOW, dryRun: false, errorCode: 'no_line_id' }, repo)
    expect(again).toEqual({ dryRun: false, requeued: 0 })
  })

  it('responses are aggregate-only (no per-row / sensitive keys)', async () => {
    const s = JSON.stringify(await requeueFailed({ now: NOW }, repo))
    for (const key of ['payload_json', 'user_id', 'reservation_id', 'dedupe_key', 'line_id', 'license_plate']) {
      expect(s).not.toContain(`"${key}"`)
    }
  })
})
