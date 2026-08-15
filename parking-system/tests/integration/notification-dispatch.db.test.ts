import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { LineTransport } from '@/server/services/notification/lineTransport'
import {
  TransportConfigError,
  TransportRetryableError,
} from '@/server/services/notification/lineTransport'
import { NOTIFICATION_LEASE_SECONDS } from '@/lib/allocation/rules'

// Gated: `RUN_DB_TESTS=1` + reachable local Supabase (prereq: `npm run db:reset`).
try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may already be exported */
}
const RUN = process.env.RUN_DB_TESTS === '1'

type Sb = import('@supabase/supabase-js').SupabaseClient

// Seed members carry a line_id; backoffice users (admin/staff) are line_id NULL → undeliverable.
const MEMBER_WITH_LINE = 'a0000000-0000-0000-0000-000000000001'
const USER_NO_LINE = '11111111-1111-1111-1111-111111111111'

// Fresh Sunday — must not collide with other integration files.
const SUNDAY = '2099-07-05'
const NOW = new Date('2099-07-05T02:00:00Z')

// Counting transports (record recipients so we can assert exactly-once under concurrency).
function recordingTransport(behaviour?: (lineId: string) => Promise<void>): LineTransport & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async push(lineId) {
      calls.push(lineId)
      if (behaviour) await behaviour(lineId)
    },
  }
}

describe.skipIf(!RUN)('notification dispatcher — local DB integration', () => {
  let sb: Sb
  let repo: import('@/server/repositories/parkingRepository').ParkingRepository
  let dispatchNotifications: typeof import('@/server/services/notificationDispatchService').dispatchNotifications
  const eventId = randomUUID()

  async function enqueue(
    dedupe: string,
    userId: string | null,
    over: Record<string, unknown> = {},
  ): Promise<string> {
    const { data } = await sb
      .from('notification_outbox')
      .insert({
        dedupe_key: dedupe,
        template_key: 'reservation_approved',
        user_id: userId,
        weekly_event_id: eventId,
        payload_json: {},
        status: 'pending',
        next_retry_at: NOW.toISOString(),
        ...over,
      })
      .select('id')
      .single()
      .throwOnError()
    return data!.id as string
  }

  const rowOf = async (id: string) =>
    (
      await sb
        .from('notification_outbox')
        .select('status, sent_at, next_retry_at, retry_count, last_error, locked_by')
        .eq('id', id)
        .single()
    ).data as {
      status: string
      sent_at: string | null
      next_retry_at: string
      retry_count: number
      last_error: string | null
      locked_by: string | null
    }

  beforeAll(async () => {
    sb = (await import('@/lib/supabase/server')).getServiceClient()
    repo = (await import('@/server/repositories/parkingRepository')).createParkingRepository(sb)
    dispatchNotifications = (await import('@/server/services/notificationDispatchService')).dispatchNotifications

    const { data: existing } = await sb.from('weekly_events').select('id').eq('sunday_date', SUNDAY)
    for (const r of existing ?? []) {
      await sb.from('notification_outbox').delete().eq('weekly_event_id', r.id as string)
      await sb.from('weekly_events').delete().eq('id', r.id as string)
    }
    await sb
      .from('weekly_events')
      .insert({ id: eventId, sunday_date: SUNDAY, total_capacity: 23, blocked_spaces: 0, admin_reserved: 0 })
      .throwOnError()
  })

  afterEach(async () => {
    await sb.from('notification_outbox').delete().eq('weekly_event_id', eventId)
  })

  afterAll(async () => {
    if (!RUN) return
    await sb.from('notification_outbox').delete().eq('weekly_event_id', eventId)
    await sb.from('weekly_events').delete().eq('id', eventId)
  })

  it('sends a deliverable row and marks it sent', async () => {
    const id = await enqueue('nd:sent', MEMBER_WITH_LINE)
    const tx = recordingTransport()
    const summary = await dispatchNotifications({ now: NOW, worker: 'w' }, repo, tx)
    expect(summary).toMatchObject({ scanned: 1, sent: 1 })
    expect(tx.calls).toEqual(['U_member_01'])
    const row = await rowOf(id)
    expect(row.status).toBe('sent')
    expect(row.sent_at).not.toBeNull()
    expect(row.locked_by).toBeNull()
  })

  it('marks a recipient without a line_id failed (no_line_id) — sanitized, no leaked detail', async () => {
    const id = await enqueue('nd:noline', USER_NO_LINE)
    const summary = await dispatchNotifications({ now: NOW, worker: 'w' }, repo, recordingTransport())
    expect(summary).toMatchObject({ failed: 1, skippedNoLineId: 1, sent: 0 })
    const row = await rowOf(id)
    expect(row.status).toBe('failed')
    expect(row.last_error).toBe('no_line_id')
    // last_error carries a sanitized code only — never message text or the recipient's line_id.
    expect(row.last_error).not.toContain('U_member')
    expect(row.last_error).not.toContain('教會停車')
  })

  it('schedules a retry with a future next_retry_at on a retryable error, then delivers on re-run', async () => {
    const id = await enqueue('nd:retry', MEMBER_WITH_LINE)
    const failing = recordingTransport(async () => {
      throw new TransportRetryableError('http_500')
    })
    await dispatchNotifications({ now: NOW, worker: 'w1' }, repo, failing)
    let row = await rowOf(id)
    expect(row.status).toBe('retrying')
    expect(row.retry_count).toBe(1)
    expect(row.last_error).toBe('http_500')
    expect(new Date(row.next_retry_at).getTime()).toBeGreaterThan(NOW.getTime())

    // Re-run at the scheduled time with a healthy transport → claimed again and delivered.
    const later = new Date(row.next_retry_at)
    const summary = await dispatchNotifications({ now: later, worker: 'w2' }, repo, recordingTransport())
    expect(summary).toMatchObject({ sent: 1 })
    row = await rowOf(id)
    expect(row.status).toBe('sent')
  })

  it('CONCURRENCY: two dispatchers, one due row → exactly one push (atomic claim)', async () => {
    const id = await enqueue('nd:race', MEMBER_WITH_LINE)
    // Slow push so both dispatchers overlap in time; the atomic claim still lets only one win.
    const slow = recordingTransport(() => new Promise(r => setTimeout(r, 60)))
    const [a, b] = await Promise.all([
      dispatchNotifications({ now: NOW, worker: 'wa' }, repo, slow),
      dispatchNotifications({ now: NOW, worker: 'wb' }, repo, slow),
    ])
    expect(slow.calls.length).toBe(1) // pushed at most once
    expect(a.sent + b.sent).toBe(1)
    expect(a.scanned + b.scanned).toBe(1) // the other claimed nothing
    expect((await rowOf(id)).status).toBe('sent')
  })

  it('reclaims a stale-lease row left processing by a dead worker', async () => {
    const staleLockedAt = new Date(NOW.getTime() - (NOTIFICATION_LEASE_SECONDS + 60) * 1000).toISOString()
    const id = await enqueue('nd:stale', MEMBER_WITH_LINE, {
      status: 'processing',
      locked_at: staleLockedAt,
      locked_by: 'dead-worker',
    })
    const tx = recordingTransport()
    const summary = await dispatchNotifications({ now: NOW, worker: 'rescuer' }, repo, tx)
    expect(summary).toMatchObject({ scanned: 1, sent: 1 })
    expect((await rowOf(id)).status).toBe('sent')
  })

  it('config error AFTER claim leaves the row processing (not failed/sent); a later reclaim delivers it', async () => {
    const id = await enqueue('nd:config', MEMBER_WITH_LINE)
    const bad = recordingTransport(async () => {
      throw new TransportConfigError('http_401')
    })
    await expect(dispatchNotifications({ now: NOW, worker: 'w1' }, repo, bad)).rejects.toBeInstanceOf(
      TransportConfigError,
    )
    let row = await rowOf(id)
    expect(row.status).toBe('processing') // left claimed, NOT failed and NOT sent
    expect(row.sent_at).toBeNull()
    expect(row.last_error).toBeNull()

    // After config is fixed, lease expiry lets another worker reclaim and deliver it.
    const later = new Date(NOW.getTime() + (NOTIFICATION_LEASE_SECONDS + 60) * 1000)
    const summary = await dispatchNotifications({ now: later, worker: 'w2' }, repo, recordingTransport())
    expect(summary).toMatchObject({ sent: 1 })
    row = await rowOf(id)
    expect(row.status).toBe('sent')
  })
})
