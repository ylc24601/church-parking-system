import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Gated: `RUN_DB_TESTS=1` + reachable local Supabase (prereq: `npm run db:reset`).
try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may already be exported */
}
const RUN = process.env.RUN_DB_TESTS === '1'

type Sb = import('@supabase/supabase-js').SupabaseClient

// Seeded member/vehicle pairs (supabase/seed.sql); penalties start at 0.
const M3 = 'a0000000-0000-0000-0000-000000000003', V3 = 'b0000000-0000-0000-0000-000000000003'
const M4 = 'a0000000-0000-0000-0000-000000000004', V4 = 'b0000000-0000-0000-0000-000000000004'
const M5 = 'a0000000-0000-0000-0000-000000000005', V5 = 'b0000000-0000-0000-0000-000000000005'

describe.skipIf(!RUN)('settlement + pastoral care — local DB integration', () => {
  let sb: Sb
  let repo: import('@/server/repositories/parkingRepository').ParkingRepository
  let settle: typeof import('@/server/services/settlementService').settle

  const SUNDAY1 = '2099-03-01', SUNDAY2 = '2099-03-08'
  const event1 = randomUUID(), event2 = randomUUID()
  const rM3 = randomUUID(), rM4 = randomUUID(), rM5 = randomUUID()   // event1
  const rM4b = randomUUID()                                          // event2
  const PAST1 = '2099-03-01T02:30:00Z', NOW1 = new Date('2099-03-01T05:00:00Z')
  const PAST2 = '2099-03-08T02:30:00Z', NOW2 = new Date('2099-03-08T05:00:00Z')

  async function cascadeDelete(eid: string) {
    await sb.from('pastoral_care_alerts').delete().eq('weekly_event_id', eid)
    await sb.from('notification_outbox').delete().eq('weekly_event_id', eid)
    await sb.from('reservations').delete().eq('weekly_event_id', eid)
    await sb.from('weekly_events').delete().eq('id', eid)
  }
  const get = async (id: string) =>
    (await sb.from('reservations').select('*').eq('id', id).single()).data!
  const penalty = async (uid: string) =>
    (await sb.from('user_penalties').select('*').eq('user_id', uid).single()).data!
  const openAlerts = async (uid: string) =>
    (await sb.from('pastoral_care_alerts').select('*').eq('user_id', uid).eq('status', 'open')).data ?? []

  beforeAll(async () => {
    const { getServiceClient } = await import('@/lib/supabase/server')
    const { createParkingRepository } = await import('@/server/repositories/parkingRepository')
    settle = (await import('@/server/services/settlementService')).settle
    sb = getServiceClient()
    repo = createParkingRepository(sb)

    for (const d of [SUNDAY1, SUNDAY2]) {
      const { data } = await sb.from('weekly_events').select('id').eq('sunday_date', d)
      for (const row of data ?? []) await cascadeDelete(row.id as string)
    }

    await sb.from('weekly_events').insert([
      { id: event1, sunday_date: SUNDAY1, total_capacity: 23, blocked_spaces: 0, admin_reserved: 0 },
      { id: event2, sunday_date: SUNDAY2, total_capacity: 23, blocked_spaces: 0, admin_reserved: 0 },
    ]).throwOnError()

    await sb.from('reservations').insert([
      // event1: released_late P3 + released_late P2 + an approved-but-past-deadline row (missed release)
      { id: rM3, weekly_event_id: event1, user_id: M3, vehicle_id: V3, effective_priority: 3, status: 'released_late', allocation_order: 1, release_deadline_at: PAST1, released_at: PAST1 },
      { id: rM4, weekly_event_id: event1, user_id: M4, vehicle_id: V4, effective_priority: 2, status: 'released_late', allocation_order: 2, release_deadline_at: PAST1, released_at: PAST1 },
      { id: rM5, weekly_event_id: event1, user_id: M5, vehicle_id: V5, effective_priority: 3, status: 'approved', allocation_order: 3, release_deadline_at: PAST1 },
      // event2: M4 no-shows again (per-event index lets the same member appear)
      { id: rM4b, weekly_event_id: event2, user_id: M4, vehicle_id: V4, effective_priority: 2, status: 'released_late', allocation_order: 1, release_deadline_at: PAST2, released_at: PAST2 },
    ]).throwOnError()

    // Presets: M3 already has a penalty point; M4 already at consecutive 3 (next no-show → 4 → alert).
    await sb.from('user_penalties').update({ penalty_score: 1 }).eq('user_id', M3).throwOnError()
    await sb.from('user_penalties').update({ consecutive_no_show: 3 }).eq('user_id', M4).throwOnError()
  })

  afterAll(async () => {
    if (!sb) return
    await cascadeDelete(event1)
    await cascadeDelete(event2)
    for (const uid of [M3, M4, M5]) {
      await sb.from('user_penalties')
        .update({ penalty_score: 0, consecutive_no_show: 0, last_successful_attended_at: null })
        .eq('user_id', uid)
    }
  })

  it('settles event1: pre-settle sweep + no_show + penalties + one pastoral alert; no outbox', async () => {
    const s = await settle({ eventId: event1, now: NOW1 }, repo)
    expect(s.releasedNow).toBe(1)        // the stale approved M5 row swept to released_late
    expect(s.settled).toBe(3)            // M3, M4, M5 all → no_show
    expect(s.alertsCreated).toBe(1)      // M4

    expect((await get(rM3)).status).toBe('no_show')
    expect((await get(rM4)).status).toBe('no_show')
    expect((await get(rM5)).status).toBe('no_show')   // approved → released_late → no_show in one settle

    expect((await penalty(M3)).penalty_score).toBe(2)             // P3: 1 → 2
    expect((await penalty(M5)).penalty_score).toBe(1)             // P3: 0 → 1 (swept then settled)
    const m4 = await penalty(M4)
    expect(m4.penalty_score).toBe(0)                              // P2 score frozen
    expect(m4.consecutive_no_show).toBe(4)                        // 3 → 4

    const alerts = await openAlerts(M4)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toMatchObject({ reason: 'consecutive_no_show', trigger_count: 4, status: 'open' })

    // settlement enqueues no notification; no waiting rows → release broadcast also 0.
    const ob = (await sb.from('notification_outbox').select('id').eq('weekly_event_id', event1)).data ?? []
    expect(ob).toHaveLength(0)
  })

  it('idempotent re-run of event1: settles 0, no penalty change, no duplicate alert', async () => {
    const before = (await penalty(M3)).penalty_score
    const s = await settle({ eventId: event1, now: NOW1 }, repo)
    expect(s.settled).toBe(0)
    expect(s.alertsCreated).toBe(0)
    expect((await penalty(M3)).penalty_score).toBe(before)
    expect(await openAlerts(M4)).toHaveLength(1)
  })

  it('cross-event dedup: M4 no-shows again while an alert is open → no new alert', async () => {
    const s = await settle({ eventId: event2, now: NOW2 }, repo)
    expect(s.settled).toBe(1)             // M4 in event2 → no_show
    expect(s.alertsCreated).toBe(0)       // already has an open alert → ON CONFLICT DO NOTHING

    expect((await penalty(M4)).consecutive_no_show).toBe(5)   // 4 → 5
    expect(await openAlerts(M4)).toHaveLength(1)              // still exactly one
  })
})
