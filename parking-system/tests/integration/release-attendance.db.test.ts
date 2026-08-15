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

// Seeded member/vehicle pairs (supabase/seed.sql); all penalties start at 0.
const M1 = 'a0000000-0000-0000-0000-000000000001', V1 = 'b0000000-0000-0000-0000-000000000001'
const M2 = 'a0000000-0000-0000-0000-000000000002', V2 = 'b0000000-0000-0000-0000-000000000002'
const M3 = 'a0000000-0000-0000-0000-000000000003', V3 = 'b0000000-0000-0000-0000-000000000003'
const M4 = 'a0000000-0000-0000-0000-000000000004', V4 = 'b0000000-0000-0000-0000-000000000004'
const M5 = 'a0000000-0000-0000-0000-000000000005', V5 = 'b0000000-0000-0000-0000-000000000005'

describe.skipIf(!RUN)('sunday release + attendance — local DB integration', () => {
  let sb: Sb
  let repo: import('@/server/repositories/parkingRepository').ParkingRepository
  let svc: {
    runRelease: typeof import('@/server/services/releaseService').runRelease
    checkIn: typeof import('@/server/services/attendanceService').checkIn
    markOnTheWay: typeof import('@/server/services/onTheWayService').markOnTheWay
    sendArrivalReminders: typeof import('@/server/services/p2ReminderService').sendArrivalReminders
  }

  const SUNDAY = '2099-02-01'
  const event = randomUUID()
  // M2 = approved P2 (deadline 10:30, will go on-the-way → grace 10:50).
  // M4 = approved P2 (deadline 10:30, stays off the way — same deadline as P3, #42).
  // M3 = approved P3 (10:30). M1/M5 = waiting.
  const rM2 = randomUUID(), rM3 = randomUUID(), rM4 = randomUUID(), wM1 = randomUUID(), wM5 = randomUUID()

  // Sunday 2099-02-01 release deadlines (Taipei), post-#42: p3 10:30 = 02:30Z,
  // p2 10:30 = 02:30Z (same as p3), grace 10:50 = 02:50Z.
  let DL: { p3: Date; p2: Date; p2Grace: Date }
  const T_1025 = new Date('2099-02-01T02:25:00Z')  // before p2/p3 (on-time P2 attendance)
  const T_1029 = new Date('2099-02-01T02:29:00Z')  // before p2/p3 (on-the-way ok)
  const T_1031 = new Date('2099-02-01T02:31:00Z')  // past p2/p3
  const T_1040 = new Date('2099-02-01T02:40:00Z')  // before grace
  const T_1056 = new Date('2099-02-01T02:56:00Z')  // past grace

  async function cascadeDelete(eid: string) {
    await sb.from('notification_outbox').delete().eq('weekly_event_id', eid)
    await sb.from('reservations').delete().eq('weekly_event_id', eid)
    await sb.from('weekly_events').delete().eq('id', eid)
  }
  const get = async (id: string) =>
    (await sb.from('reservations').select('*').eq('id', id).single()).data!
  const penalty = async (uid: string) =>
    (await sb.from('user_penalties').select('*').eq('user_id', uid).single()).data!
  const outboxKeys = async () =>
    ((await sb.from('notification_outbox').select('dedupe_key').eq('weekly_event_id', event)).data ?? [])
      .map(r => r.dedupe_key as string)

  beforeAll(async () => {
    const { getServiceClient } = await import('@/lib/supabase/server')
    const { createParkingRepository } = await import('@/server/repositories/parkingRepository')
    const { buildReleaseDeadlines } = await import('@/lib/allocation/release')
    svc = {
      runRelease: (await import('@/server/services/releaseService')).runRelease,
      checkIn: (await import('@/server/services/attendanceService')).checkIn,
      markOnTheWay: (await import('@/server/services/onTheWayService')).markOnTheWay,
      sendArrivalReminders: (await import('@/server/services/p2ReminderService')).sendArrivalReminders,
    }
    sb = getServiceClient()
    repo = createParkingRepository(sb)
    DL = buildReleaseDeadlines(SUNDAY)

    const { data: leftovers } = await sb.from('weekly_events').select('id').eq('sunday_date', SUNDAY)
    for (const row of leftovers ?? []) await cascadeDelete(row.id as string)

    await sb.from('weekly_events').insert({
      id: event, sunday_date: SUNDAY, total_capacity: 23, blocked_spaces: 0, admin_reserved: 0,
    }).throwOnError()

    await sb.from('reservations').insert([
      { id: rM2, weekly_event_id: event, user_id: M2, vehicle_id: V2, effective_priority: 2, status: 'approved', allocation_order: 1, release_deadline_at: DL.p2.toISOString() },
      { id: rM3, weekly_event_id: event, user_id: M3, vehicle_id: V3, effective_priority: 3, status: 'approved', allocation_order: 2, release_deadline_at: DL.p3.toISOString() },
      { id: rM4, weekly_event_id: event, user_id: M4, vehicle_id: V4, effective_priority: 2, status: 'approved', allocation_order: 3, release_deadline_at: DL.p2.toISOString() },
      { id: wM1, weekly_event_id: event, user_id: M1, vehicle_id: V1, effective_priority: 3, status: 'waiting', allocation_order: 4 },
      { id: wM5, weekly_event_id: event, user_id: M5, vehicle_id: V5, effective_priority: 3, status: 'waiting', allocation_order: 5 },
    ]).throwOnError()

    // Give M3 a penalty so attendance recovery (score-1) is observable.
    await sb.from('user_penalties').update({ penalty_score: 2 }).eq('user_id', M3).throwOnError()
  })

  afterAll(async () => {
    if (!sb) return
    await cascadeDelete(event)
    // Reset the penalty we mutated so the suite leaves the seed as it found it.
    await sb.from('user_penalties')
      .update({ penalty_score: 0, consecutive_no_show: 0, last_successful_attended_at: null })
      .eq('user_id', M3)
  })

  it('on-the-way: before deadline extends to grace (10:50); after deadline is a no-op', async () => {
    // M2 at 10:29 (<= 10:30) → flag + deadline extends to the 10:50 grace.
    const ok = await svc.markOnTheWay({ reservationId: rM2, now: T_1029 }, repo)
    expect(ok.updated).toBe(true)
    const m2 = await get(rM2)
    expect(m2.p2_on_the_way).toBe(true)
    expect(new Date(m2.release_deadline_at as string).getTime()).toBe(DL.p2Grace.getTime())

    // repeat → no-op (already on the way).
    expect((await svc.markOnTheWay({ reservationId: rM2, now: T_1029 }, repo)).updated).toBe(false)

    // M4 at 10:31 (> 10:30) → no-op, deadline unchanged.
    const late = await svc.markOnTheWay({ reservationId: rM4, now: T_1031 }, repo)
    expect(late.updated).toBe(false)
    const m4 = await get(rM4)
    expect(m4.p2_on_the_way).toBe(false)
    expect(new Date(m4.release_deadline_at as string).getTime()).toBe(DL.p2.getTime())
  })

  it('p2 reminder targets approved P2 not yet on-the-way (excludes M2)', async () => {
    const { enqueued } = await svc.sendArrivalReminders({ eventId: event }, repo)
    expect(enqueued).toBe(1)                              // only M4 (M2 is on the way)
    const keys = await outboxKeys()
    expect(keys).toContain(`p2_reminder:${rM4}:${SUNDAY}`)
    expect(keys).not.toContain(`p2_reminder:${rM2}:${SUNDAY}`)
  })

  it('attendance: on-time approved P2 (not on the way) → attended, penalty frozen', async () => {
    // M4's deadline collapsed onto P3's (#42) — "on time" now means before 10:30.
    const r = await svc.checkIn({ reservationId: rM4, now: T_1025 }, repo)
    expect(r.status).toBe('attended')
    expect((await get(rM4)).status).toBe('attended')
    expect((await penalty(M4)).penalty_score).toBe(0)     // privileged → frozen
  })

  it('release at 10:31: P3 released_late, on-the-way P2 held; broadcast only to live-waiting users', async () => {
    // Race: M5 becomes temp_approved just before the sweep → must NOT get a waiting broadcast.
    await sb.from('reservations').update({ status: 'temp_approved' }).eq('id', wM5).throwOnError()

    const res = await svc.runRelease({ eventId: event, now: T_1031 }, repo)
    expect(res.released).toBe(1)                          // only M3 (P3, 10:30); M4 already attended
    expect(res.broadcastEnqueued).toBe(1)                 // only M1 still waiting (M5 excluded)

    expect((await get(rM3)).status).toBe('released_late')
    expect((await get(rM3)).released_at).not.toBeNull()
    expect((await get(rM2)).status).toBe('approved')      // grace 10:50, still held
    expect((await get(rM4)).status).toBe('attended')      // untouched — already checked in

    const keys = await outboxKeys()
    expect(keys).toContain(`broadcast:${wM1}:${T_1031.toISOString()}`)
    expect(keys).not.toContain(`broadcast:${wM5}:${T_1031.toISOString()}`)

    // idempotent re-run: nothing new released or broadcast.
    const before = (await outboxKeys()).length
    const again = await svc.runRelease({ eventId: event, now: T_1031 }, repo)
    expect(again.released).toBe(0)
    expect((await outboxKeys()).length).toBe(before)
  })

  it('attendance: released_late P3 → attended_after_release + penalty recovered; idempotent', async () => {
    const r = await svc.checkIn({ reservationId: rM3, now: T_1031 }, repo)
    expect(r.attended).toBe(true)
    expect(r.status).toBe('attended_after_release')
    expect((await get(rM3)).status).toBe('attended_after_release')

    const p = await penalty(M3)
    expect(p.penalty_score).toBe(1)                       // 2 - 1
    expect(p.consecutive_no_show).toBe(0)
    expect(p.last_successful_attended_at).toBe(SUNDAY)    // Taipei date

    // re-run → no-op, no double recovery.
    const again = await svc.checkIn({ reservationId: rM3, now: T_1031 }, repo)
    expect(again.attended).toBe(false)
    expect((await penalty(M3)).penalty_score).toBe(1)
  })

  it('release after grace: the on-the-way P2 is released at 10:56', async () => {
    const res = await svc.runRelease({ eventId: event, now: T_1056 }, repo)
    expect(res.released).toBe(1)                          // M2 (grace deadline 10:50)
    expect((await get(rM2)).status).toBe('released_late')
  })

  it('apply_attendance rejects an out-of-range target status (DB guard)', async () => {
    await expect(
      repo.applyAttendance({
        eventId: event,
        reservationId: rM4,
        targetStatus: 'no_show' as unknown as 'attended',
        nowIso: T_1040.toISOString(),
        penalty: null,
      }),
    ).rejects.toThrow()
  })
})
