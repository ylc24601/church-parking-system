import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { NOTIFICATION_LEASE_SECONDS } from '@/lib/allocation/rules'

// Gated: `RUN_DB_TESTS=1` + reachable local Supabase (prereq: `npm run db:reset`).
try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may already be exported */
}
const RUN = process.env.RUN_DB_TESTS === '1'

type Sb = import('@supabase/supabase-js').SupabaseClient

const SUNDAY = '2099-09-06'
const NOW = new Date('2099-09-06T02:00:00Z')
const iso = (offsetSec: number) => new Date(NOW.getTime() + offsetSec * 1000).toISOString()
const STALE = -(NOTIFICATION_LEASE_SECONDS + 180) // locked_at older than the lease → reclaimable
const FRESH = -10

describe.skipIf(!RUN)('outbox health / preview — local DB integration', () => {
  let sb: Sb
  let repo: import('@/server/repositories/parkingRepository').ParkingRepository
  let getOutboxHealth: typeof import('@/server/services/outboxHealthService').getOutboxHealth
  let previewDispatch: typeof import('@/server/services/notificationDispatchService').previewDispatch
  const eventId = randomUUID()

  beforeAll(async () => {
    sb = (await import('@/lib/supabase/server')).getServiceClient()
    repo = (await import('@/server/repositories/parkingRepository')).createParkingRepository(sb)
    getOutboxHealth = (await import('@/server/services/outboxHealthService')).getOutboxHealth
    previewDispatch = (await import('@/server/services/notificationDispatchService')).previewDispatch

    const { data: existing } = await sb.from('weekly_events').select('id').eq('sunday_date', SUNDAY)
    for (const r of existing ?? []) {
      await sb.from('notification_outbox').delete().eq('weekly_event_id', r.id as string)
      await sb.from('weekly_events').delete().eq('id', r.id as string)
    }
    await sb.from('weekly_events').insert({
      id: eventId, sunday_date: SUNDAY, total_capacity: 23, blocked_spaces: 0, admin_reserved: 0,
    }).throwOnError()

    const k = (s: string) => `oh:${eventId.slice(0, 8)}:${s}`
    // PostgREST bulk insert fills omitted keys with NULL (not column DEFAULT), so every row
    // sets the not-null retry_count + next_retry_at explicitly.
    const base = { weekly_event_id: eventId, template_key: 'move_car_request', retry_count: 0, next_retry_at: iso(0) }
    await sb.from('notification_outbox').insert([
      // due pending (2, different templates)
      { ...base, dedupe_key: k('p-due-1'), status: 'pending', next_retry_at: iso(-60) },
      { ...base, dedupe_key: k('p-due-2'), template_key: 'broadcast_release', status: 'pending', next_retry_at: iso(-60) },
      // pending but not due yet (future next_retry_at)
      { ...base, dedupe_key: k('p-future'), status: 'pending', next_retry_at: iso(3600) },
      // retrying: one due now, one scheduled later
      { ...base, dedupe_key: k('r-due'), status: 'retrying', next_retry_at: iso(-30), retry_count: 1 },
      { ...base, dedupe_key: k('r-future'), template_key: 'broadcast_release', status: 'retrying', next_retry_at: iso(600), retry_count: 2 },
      // failed with sanitized error codes
      { ...base, dedupe_key: k('f-noline'), status: 'failed', last_error: 'no_line_id' },
      { ...base, dedupe_key: k('f-403'), status: 'failed', last_error: 'terminal_403' },
      // processing: one stale-lease (reclaimable → due), one fresh (in-flight)
      { ...base, dedupe_key: k('proc-stale'), status: 'processing', locked_at: iso(STALE), locked_by: 'dead' },
      { ...base, dedupe_key: k('proc-fresh'), status: 'processing', locked_at: iso(FRESH), locked_by: 'alive' },
      // sent within 24h
      { ...base, dedupe_key: k('sent'), status: 'sent', sent_at: iso(-3600) },
    ]).throwOnError()
  })

  afterAll(async () => {
    if (!RUN) return
    await sb.from('notification_outbox').delete().eq('weekly_event_id', eventId)
    await sb.from('weekly_events').delete().eq('id', eventId)
  })

  it('outbox_health returns correct operation-safe aggregates', async () => {
    const h = await getOutboxHealth({ now: NOW }, repo)
    // due = 2 pending-due + 1 retrying-due + 1 stale-processing
    expect(h.due).toBe(4)
    expect(h.due_by_template).toEqual({ move_car_request: 3, broadcast_release: 1 })
    expect(h.pending).toBe(3)
    expect(h.retrying).toBe(2)
    expect(h.processing).toBe(2)
    expect(h.stale_processing).toBe(1)
    expect(h.failed).toBe(2)
    expect(h.failed_by_error).toEqual({ no_line_id: 1, terminal_403: 1 })
    expect(h.sent_last_24h).toBe(1)
    expect(h.oldest_pending_at).not.toBeNull()
    expect(h.next_retry_at).not.toBeNull()
  })

  it('health output is aggregate-only (no per-row / sensitive field names)', async () => {
    const s = JSON.stringify(await getOutboxHealth({ now: NOW }, repo))
    for (const key of ['payload_json', 'user_id', 'reservation_id', 'dedupe_key', 'line_id', 'license_plate']) {
      expect(s).not.toContain(`"${key}"`)
    }
  })

  it('previewDispatch mirrors due counts and mutates NOTHING', async () => {
    const before = (await sb.from('notification_outbox').select('dedupe_key, status, locked_by')
      .eq('weekly_event_id', eventId).order('dedupe_key')).data

    const preview = await previewDispatch({ now: NOW }, repo)
    expect(preview.dryRun).toBe(true)
    expect(preview.due).toBe(4)
    expect(preview.staleProcessing).toBe(1)
    expect(preview.dueByTemplate).toEqual({ move_car_request: 3, broadcast_release: 1 })

    const after = (await sb.from('notification_outbox').select('dedupe_key, status, locked_by')
      .eq('weekly_event_id', eventId).order('dedupe_key')).data
    expect(after).toEqual(before) // no claim, no status/lock changes
  })
})
