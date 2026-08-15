import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Phase 9 Slice 1 — ensureWeeklyEvent idempotency + getUpcomingScheduledEvent
// determinism against the real DB (the on-conflict-do-nothing semantics live in
// Postgres, not in TS, so unit tests cannot cover them).
// Gated: `RUN_DB_TESTS=1` + reachable local Supabase (prereq: `npm run db:reset`).
try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may already be exported */
}
const RUN = process.env.RUN_DB_TESTS === '1'

type Sb = import('@supabase/supabase-js').SupabaseClient

// Fresh Sundays — must not collide with other integration files (they use dates up to
// 2099-08-02 in this window; nothing between 08-03 and 09-05).
const SUNDAY_A = '2099-08-09'
const SUNDAY_B = '2099-08-16'
// A cursor after every other file's dates in this window, so the upcoming-event query
// can only see the two rows this file owns even when files run concurrently.
const CURSOR = '2099-08-03'

describe.skipIf(!RUN)('ensure-weekly-event — local DB integration', () => {
  let sb: Sb
  let repo: import('@/server/repositories/parkingRepository').ParkingRepository

  async function deleteSundays() {
    await sb.from('weekly_events').delete().in('sunday_date', [SUNDAY_A, SUNDAY_B])
  }

  beforeAll(async () => {
    sb = (await import('@/lib/supabase/server')).getServiceClient()
    repo = (await import('@/server/repositories/parkingRepository')).createParkingRepository(sb)
    await deleteSundays()
  })

  afterAll(async () => {
    if (RUN) await deleteSundays()
  })

  it('creates a missing Sunday with pure DB defaults (23/0/0/open)', async () => {
    const { created, event } = await repo.ensureWeeklyEvent(SUNDAY_A)
    expect(created).toBe(true)
    expect(event.sunday_date).toBe(SUNDAY_A)

    const { data } = await sb
      .from('weekly_events')
      .select('total_capacity, blocked_spaces, admin_reserved, status')
      .eq('id', event.id)
      .single()
    expect(data).toEqual({ total_capacity: 23, blocked_spaces: 0, admin_reserved: 0, status: 'open' })
  })

  it('re-run is a no-op: created=false, same row id', async () => {
    const first = await repo.ensureWeeklyEvent(SUNDAY_A)
    expect(first.created).toBe(false)

    const again = await repo.ensureWeeklyEvent(SUNDAY_A)
    expect(again.created).toBe(false)
    expect(again.event.id).toBe(first.event.id)
  })

  it('never modifies an existing event (admin-tuned capacity/status survive)', async () => {
    await sb
      .from('weekly_events')
      .update({ total_capacity: 20, blocked_spaces: 3, status: 'closed' })
      .eq('sunday_date', SUNDAY_A)
      .throwOnError()

    const { created, event } = await repo.ensureWeeklyEvent(SUNDAY_A)
    expect(created).toBe(false)
    expect(event.status).toBe('closed')

    const { data } = await sb
      .from('weekly_events')
      .select('total_capacity, blocked_spaces, status')
      .eq('sunday_date', SUNDAY_A)
      .single()
    expect(data).toEqual({ total_capacity: 20, blocked_spaces: 3, status: 'closed' })
  })

  it('two concurrent ensures yield exactly one created=true', async () => {
    const [r1, r2] = await Promise.all([
      repo.ensureWeeklyEvent(SUNDAY_B),
      repo.ensureWeeklyEvent(SUNDAY_B),
    ])
    expect([r1.created, r2.created].filter(Boolean)).toHaveLength(1)
    expect(r1.event.id).toBe(r2.event.id)

    const { count } = await sb
      .from('weekly_events')
      .select('id', { count: 'exact', head: true })
      .eq('sunday_date', SUNDAY_B)
    expect(count).toBe(1)
  })

  it('getUpcomingScheduledEvent returns the nearest Sunday >= cursor, deterministically', async () => {
    // Both this file's Sundays exist by now; the cursor excludes every other file's rows.
    const nearest = await repo.getUpcomingScheduledEvent(CURSOR)
    expect(nearest?.sunday_date).toBe(SUNDAY_A)

    // Cursor past A → B is next; on B itself → B (Sunday counts all day).
    expect((await repo.getUpcomingScheduledEvent('2099-08-10'))?.sunday_date).toBe(SUNDAY_B)
    expect((await repo.getUpcomingScheduledEvent(SUNDAY_B))?.sunday_date).toBe(SUNDAY_B)
  })
})
