import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { LineTransport } from '@/server/services/notification/lineTransport'

// Gated: `RUN_DB_TESTS=1` + reachable local Supabase (prereq: `npm run db:reset`).
try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may already be exported */
}
const RUN = process.env.RUN_DB_TESTS === '1'

type Sb = import('@supabase/supabase-js').SupabaseClient

// Fresh Sunday + self-owned users/vehicles so this file can't collide with any other file's
// reservations (one active reservation per (event, member)).
const SUNDAY = '2099-08-02'
const NOW = new Date('2099-08-02T02:00:00Z')

const okTransport = (): LineTransport & { calls: string[] } => {
  const calls: string[] = []
  return { calls, async push(lineId) { calls.push(lineId) } }
}

describe.skipIf(!RUN)('move-car — local DB integration', () => {
  let sb: Sb
  let repo: import('@/server/repositories/parkingRepository').ParkingRepository
  let requestMoveCar: typeof import('@/server/services/moveCarService').requestMoveCar
  let dispatchNotifications: typeof import('@/server/services/notificationDispatchService').dispatchNotifications

  const eventId = randomUUID()
  const uLine = randomUUID()   // member WITH a line_id
  const uNoLine = randomUUID() // member WITHOUT a line_id
  const vLine = randomUUID()
  const vNoLine = randomUUID()
  const rLine = randomUUID()   // member-with-line reservation (notifiable)
  const rNoLine = randomUUID() // member-without-line reservation (not notifiable)
  let rWalk = ''               // walk-in reservation (no owner)

  const outboxFor = async (rid: string) =>
    (await sb.from('notification_outbox').select('id, template_key, user_id, payload_json, status')
      .eq('reservation_id', rid)).data ?? []
  const viewRow = async (rid: string) =>
    (await sb.from('staff_checkin_view').select('owner_notifiable, license_plate, walk_in_license_plate')
      .eq('reservation_id', rid).single()).data as
      { owner_notifiable: boolean; license_plate: string | null; walk_in_license_plate: string | null }

  beforeAll(async () => {
    sb = (await import('@/lib/supabase/server')).getServiceClient()
    repo = (await import('@/server/repositories/parkingRepository')).createParkingRepository(sb)
    requestMoveCar = (await import('@/server/services/moveCarService')).requestMoveCar
    dispatchNotifications = (await import('@/server/services/notificationDispatchService')).dispatchNotifications

    const { data: existing } = await sb.from('weekly_events').select('id').eq('sunday_date', SUNDAY)
    for (const r of existing ?? []) {
      await sb.from('notification_outbox').delete().eq('weekly_event_id', r.id as string)
      await sb.from('reservations').delete().eq('weekly_event_id', r.id as string)
      await sb.from('weekly_events').delete().eq('id', r.id as string)
    }

    await sb.from('users').insert([
      { id: uLine, line_id: `U_movecar_${uLine.slice(0, 8)}`, display_name: '移車測試A', role: 'user' },
      { id: uNoLine, line_id: null, display_name: '移車測試B', role: 'user' },
    ]).throwOnError()
    await sb.from('vehicles').insert([
      { id: vLine, user_id: uLine, license_plate: `MCA-${uLine.slice(0, 4)}` },
      { id: vNoLine, user_id: uNoLine, license_plate: `MCB-${uNoLine.slice(0, 4)}` },
    ]).throwOnError()
    await sb.from('weekly_events').insert({
      id: eventId, sunday_date: SUNDAY, total_capacity: 23, blocked_spaces: 0, admin_reserved: 0,
    }).throwOnError()
    // Both members present (attended → actionable, and no release_deadline_at needed).
    await sb.from('reservations').insert([
      { id: rLine, weekly_event_id: eventId, user_id: uLine, vehicle_id: vLine, effective_priority: 3, status: 'attended', attended_at: NOW.toISOString() },
      { id: rNoLine, weekly_event_id: eventId, user_id: uNoLine, vehicle_id: vNoLine, effective_priority: 3, status: 'attended', attended_at: NOW.toISOString() },
    ]).throwOnError()
    const walk = await repo.createWalkInReservation(eventId, 'MCW-9999', '散客', NOW.toISOString())
    if ('duplicate' in walk) throw new Error('walk-in seed collided')
    rWalk = walk.row.reservation_id
  })

  afterAll(async () => {
    if (!RUN) return
    await sb.from('notification_outbox').delete().eq('weekly_event_id', eventId)
    await sb.from('reservations').delete().eq('weekly_event_id', eventId)
    await sb.from('weekly_events').delete().eq('id', eventId)
    await sb.from('vehicles').delete().in('id', [vLine, vNoLine])
    await sb.from('users').delete().in('id', [uLine, uNoLine])
  })

  it('staff_checkin_view projects owner_notifiable (true for line_id member, false for walk-in / no line_id)', async () => {
    expect((await viewRow(rLine)).owner_notifiable).toBe(true)
    expect((await viewRow(rNoLine)).owner_notifiable).toBe(false)
    expect((await viewRow(rWalk)).owner_notifiable).toBe(false)
  })

  it('notifiable member → enqueues a move_car_request that the dispatcher then delivers', async () => {
    const res = await requestMoveCar({ reservationId: rLine, eventId, now: NOW }, repo)
    expect(res).toEqual({ queued: true })
    const rows = await outboxFor(rLine)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ template_key: 'move_car_request', user_id: uLine })
    expect((rows[0].payload_json as { license_plate: string }).license_plate).toContain('MCA-')

    const summary = await dispatchNotifications({ now: NOW, worker: 'w' }, repo, okTransport())
    expect(summary.sent).toBeGreaterThanOrEqual(1)
    expect((await outboxFor(rLine))[0].status).toBe('sent')
  })

  it('walk-in → not_notifiable, nothing enqueued', async () => {
    const res = await requestMoveCar({ reservationId: rWalk, eventId, now: NOW }, repo)
    expect(res).toEqual({ queued: false, reason: 'not_notifiable' })
    expect(await outboxFor(rWalk)).toHaveLength(0)
  })

  it('member without a line binding → not_notifiable, nothing enqueued', async () => {
    const res = await requestMoveCar({ reservationId: rNoLine, eventId, now: NOW }, repo)
    expect(res).toEqual({ queued: false, reason: 'not_notifiable' })
    expect(await outboxFor(rNoLine)).toHaveLength(0)
  })
})
