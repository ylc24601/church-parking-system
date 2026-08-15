import { randomInt, randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { hashSessionToken } from '@/server/http/sessionToken'

// Phase 7 Slice 1 — member LIFF login (mock mode) + member week-status reads against
// local Supabase. Cookie-layer idempotency is unit-tested (memberLoginRoute.test.ts);
// here we exercise the service + repo like staff-pin.db.test.ts does.
// Gated: `RUN_DB_TESTS=1` + reachable local Supabase (prereq: `npm run db:reset`).
try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may already be exported */
}
const RUN = process.env.RUN_DB_TESTS === '1'

type Sb = import('@supabase/supabase-js').SupabaseClient

const NOW = new Date('2099-04-01T00:00:00Z')
const T = randomUUID().slice(0, 8).toUpperCase()
// This file owns Sundays 2099-04-05 / 2099-04-12 (integration files use distinct weeks).
const SUNDAY_1 = '2099-04-05'
const SUNDAY_2 = '2099-04-12'

describe.skipIf(!RUN)('member auth + week status (Phase 7 Slice 1) — local DB integration', () => {
  let sb: Sb
  let repo: import('@/server/repositories/parkingRepository').ParkingRepository
  let loginMember: typeof import('@/server/services/memberAuthService').loginMember

  const boundUserId = randomUUID()
  const otherUserId = randomUUID()
  const vehicleId = randomUUID()
  const otherVehicleId = randomUUID()
  const eventId1 = randomUUID()
  const eventId2 = randomUUID()
  const lineId = (s: string) => `U${T}-${s}`

  const sessionRows = async (userId: string) =>
    (await sb.from('member_sessions').select('*').eq('user_id', userId)).data ?? []

  beforeAll(async () => {
    process.env.MEMBER_AUTH_MODE = 'mock'
    sb = (await import('@/lib/supabase/server')).getServiceClient()
    repo = (await import('@/server/repositories/parkingRepository')).createParkingRepository(sb)
    loginMember = (await import('@/server/services/memberAuthService')).loginMember

    await sb.from('users').insert([
      // users_phone_format_ck (0022): fixture phones must be canonical 09xxxxxxxx (digits only).
      { id: boundUserId, display_name: '測試會友七', line_id: lineId('bound'), phone_number: `0977${100000 + randomInt(900000)}` },
      { id: otherUserId, display_name: '測試會友七乙', line_id: lineId('other') },
    ]).throwOnError()
    await sb.from('vehicles').insert([
      { id: vehicleId, user_id: boundUserId, license_plate: `T7-${T.slice(0, 4)}` },
      { id: otherVehicleId, user_id: otherUserId, license_plate: `T7B-${T.slice(0, 4)}` },
    ]).throwOnError()
    await sb.from('weekly_events').insert([
      { id: eventId1, sunday_date: SUNDAY_1, total_capacity: 23, status: 'open' },
      { id: eventId2, sunday_date: SUNDAY_2, total_capacity: 23, status: 'open' },
    ]).throwOnError()
    // Own approved reservation (plate joined) + another member's row on the same event.
    await sb.from('reservations').insert([
      {
        id: randomUUID(), weekly_event_id: eventId1, user_id: boundUserId, vehicle_id: vehicleId,
        effective_priority: 2, status: 'approved', applied_at: '2099-03-30T00:00:00Z',
        approved_at: '2099-04-03T10:00:00Z', release_deadline_at: '2099-04-05T02:45:00Z',
      },
      {
        id: randomUUID(), weekly_event_id: eventId1, user_id: otherUserId, vehicle_id: otherVehicleId,
        effective_priority: 3, status: 'waiting', applied_at: '2099-03-30T01:00:00Z',
      },
    ]).throwOnError()
  })

  afterAll(async () => {
    if (!RUN) return
    await sb.from('reservations').delete().in('weekly_event_id', [eventId1, eventId2])
    await sb.from('weekly_events').delete().in('id', [eventId1, eventId2])
    await sb.from('vehicles').delete().in('id', [vehicleId, otherVehicleId])
    // member_sessions cascade with users
    await sb.from('users').delete().in('id', [boundUserId, otherUserId])
  })

  afterEach(async () => {
    await sb.from('member_sessions').delete().in('user_id', [boundUserId, otherUserId])
  })

  it('login (mock) mints a session: DB holds sha256(token) + 30d expiry, never the raw token', async () => {
    const res = await loginMember({ mockLineUserId: lineId('bound') }, repo, undefined, NOW)
    expect(res.ok).toBe(true)
    const token = (res as { ok: true; token: string }).token

    const rows = await sessionRows(boundUserId)
    expect(rows).toHaveLength(1)
    expect(rows[0].token_hash).toBe(hashSessionToken(token))
    expect(rows[0].token_hash).not.toBe(token)
    expect(new Date(rows[0].expires_at as string).toISOString()).toBe('2099-05-01T00:00:00.000Z')

    // The stored hash resolves back to the member (the cookie-layer lookup).
    const session = await repo.getMemberSessionByTokenHash(hashSessionToken(token))
    expect(session?.user_id).toBe(boundUserId)
  })

  it('unbound LINE account → typed not_bound, zero rows', async () => {
    expect(await loginMember({ mockLineUserId: lineId('ghost') }, repo, undefined, NOW)).toEqual({
      ok: false,
      reason: 'not_bound',
    })
    expect(await sessionRows(boundUserId)).toHaveLength(0)
  })

  it('login lazily deletes the member\'s expired sessions and keeps live ones', async () => {
    await repo.createMemberSession({
      userId: boundUserId, tokenHash: hashSessionToken(`expired-${T}`),
      expiresAt: '2099-03-01T00:00:00Z',
    })
    await repo.createMemberSession({
      userId: boundUserId, tokenHash: hashSessionToken(`live-${T}`),
      expiresAt: '2099-06-01T00:00:00Z',
    })
    const res = await loginMember({ mockLineUserId: lineId('bound') }, repo, undefined, NOW)
    expect(res.ok).toBe(true)

    const hashes = (await sessionRows(boundUserId)).map(r => r.token_hash)
    expect(hashes).toHaveLength(2) // live + freshly minted
    expect(hashes).toContain(hashSessionToken(`live-${T}`))
    expect(hashes).not.toContain(hashSessionToken(`expired-${T}`))
  })

  it('logout deletes exactly its own row (multi-session)', async () => {
    const a = await loginMember({ mockLineUserId: lineId('bound') }, repo, undefined, NOW)
    const b = await loginMember({ mockLineUserId: lineId('bound') }, repo, undefined, NOW)
    const tokenA = (a as { ok: true; token: string }).token
    const tokenB = (b as { ok: true; token: string }).token

    await repo.deleteMemberSessionByTokenHash(hashSessionToken(tokenA))
    expect(await repo.getMemberSessionByTokenHash(hashSessionToken(tokenA))).toBeNull()
    expect((await repo.getMemberSessionByTokenHash(hashSessionToken(tokenB)))?.user_id).toBe(boundUserId)
  })

  it('member event resolver picks the SMALLEST sunday >= today (not the latest event)', async () => {
    expect((await repo.getMemberEvent('2099-04-01'))?.sunday_date).toBe(SUNDAY_1)
    // Sunday itself still resolves to that day's event…
    expect((await repo.getMemberEvent(SUNDAY_1))?.sunday_date).toBe(SUNDAY_1)
    // …and Monday rolls to the next week even though later events exist.
    expect((await repo.getMemberEvent('2099-04-06'))?.sunday_date).toBe(SUNDAY_2)
  })

  it('week status returns the member\'s own reservation only, plate joined', async () => {
    const own = await repo.getMemberWeekReservation(boundUserId, eventId1)
    expect(own).toMatchObject({
      status: 'approved',
      license_plate: `T7-${T.slice(0, 4)}`,
      p2_on_the_way: false,
    })
    expect(own?.release_deadline_at?.toISOString()).toBe('2099-04-05T02:45:00.000Z')

    // No reservation on the other event → null (not someone else's row).
    expect(await repo.getMemberWeekReservation(boundUserId, eventId2)).toBeNull()
  })

  it('a live row wins over a cancelled sibling; a lone cancelled row still shows', async () => {
    const cancelledId = randomUUID()
    const liveId = randomUUID()
    await sb.from('reservations').insert([
      {
        id: cancelledId, weekly_event_id: eventId2, user_id: boundUserId, vehicle_id: vehicleId,
        effective_priority: 3, status: 'cancelled_by_user', applied_at: '2099-04-06T00:00:00Z',
        cancelled_at: '2099-04-07T00:00:00Z',
      },
    ]).throwOnError()
    expect((await repo.getMemberWeekReservation(boundUserId, eventId2))?.status).toBe('cancelled_by_user')

    await sb.from('reservations').insert([
      {
        id: liveId, weekly_event_id: eventId2, user_id: boundUserId, vehicle_id: vehicleId,
        effective_priority: 3, status: 'pending', applied_at: '2099-04-08T00:00:00Z',
      },
    ]).throwOnError()
    expect((await repo.getMemberWeekReservation(boundUserId, eventId2))?.status).toBe('pending')
  })
})
