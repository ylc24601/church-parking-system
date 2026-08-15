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

// Fresh Sunday — must not collide with other integration files (…01-xx / 02-01 /
// 03-xx / 04-01). Also the max sunday_date present, so getActiveEvent() resolves it.
const SUNDAY = '2099-05-03'
const PIN = '246810'

describe.skipIf(!RUN)('staff PIN session — local DB integration', () => {
  let sb: Sb
  let repo: import('@/server/repositories/parkingRepository').ParkingRepository
  let loginStaff: typeof import('@/server/services/staffSessionService').loginStaff
  let hashPin: typeof import('@/server/http/pinHash').hashPin
  const event = randomUUID()

  async function cascadeDelete(eid: string) {
    await sb.from('staff_sessions').delete().eq('weekly_event_id', eid)
    await sb.from('weekly_events').delete().eq('id', eid)
  }

  async function setPin(expiresAt?: string) {
    await repo.upsertStaffSessionPin({
      eventId: event,
      pinHash: hashPin(PIN),
      expiresAt: expiresAt ?? new Date(Date.now() + 12 * 3600_000).toISOString(),
    })
  }

  beforeAll(async () => {
    sb = (await import('@/lib/supabase/server')).getServiceClient()
    repo = (await import('@/server/repositories/parkingRepository')).createParkingRepository(sb)
    loginStaff = (await import('@/server/services/staffSessionService')).loginStaff
    hashPin = (await import('@/server/http/pinHash')).hashPin

    const { data } = await sb.from('weekly_events').select('id').eq('sunday_date', SUNDAY)
    for (const row of data ?? []) await cascadeDelete(row.id as string)

    await sb
      .from('weekly_events')
      .insert({ id: event, sunday_date: SUNDAY, total_capacity: 23, blocked_spaces: 0, admin_reserved: 0 })
      .throwOnError()
  })

  afterAll(async () => {
    if (RUN) await cascadeDelete(event)
  })

  it('provisions one PIN row per event', async () => {
    await setPin()
    const row = await repo.getStaffSessionByEvent(event)
    expect(row).toBeTruthy()
    expect(row!.weekly_event_id).toBe(event)
    expect(row!.failed_attempts).toBe(0)
    expect(row!.locked_at).toBeNull()
  })

  it('logs in with the correct PIN and binds the session event', async () => {
    await setPin()
    const res = await loginStaff(PIN, repo)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.eventId).toBe(event)
  })

  it('locks the PIN after 5 wrong attempts (atomic counter), blocking even the right PIN', async () => {
    await setPin() // upsert resets failed_attempts / locked_at
    let last
    for (let i = 0; i < 5; i++) last = await loginStaff('000000', repo)
    expect(last).toEqual({ ok: false, reason: 'locked' })

    // Within the cooldown the correct PIN is still refused.
    expect(await loginStaff(PIN, repo)).toEqual({ ok: false, reason: 'locked' })

    const row = await repo.getStaffSessionByEvent(event)
    expect(row!.failed_attempts).toBeGreaterThanOrEqual(5)
    expect(row!.locked_at).not.toBeNull()
  })

  it('treats an expired PIN as invalid (same as a wrong PIN)', async () => {
    await setPin(new Date(Date.now() - 1000).toISOString())
    expect(await loginStaff(PIN, repo)).toEqual({ ok: false, reason: 'invalid' })
  })

  // ── Phase 8 Slice 8 — Admin-UI issuance (issueStaffPin / unlockStaffPin) ─────────
  // 2099-05-03 (SUNDAY above) is a Sunday; with "now" on the preceding Monday the
  // managed window is current=2099-05-03 / next=2099-05-10.
  describe('admin issuance (Phase 8 Slice 8)', () => {
    const MONDAY_BEFORE = new Date('2099-04-27T02:00:00Z')
    const DURING_SUNDAY = new Date('2099-05-02T23:00:00Z') // Taipei 2099-05-03 07:00
    let issueStaffPin: typeof import('@/server/services/staffPinAdminService').issueStaffPin
    let unlockStaffPin: typeof import('@/server/services/staffPinAdminService').unlockStaffPin
    let adminId: string

    beforeAll(async () => {
      ;({ issueStaffPin, unlockStaffPin } = await import('@/server/services/staffPinAdminService'))
      adminId = randomUUID()
      await sb.from('admin_accounts')
        .insert({ id: adminId, username: `staffpin-${adminId.slice(0, 8)}`, password_hash: 'scrypt$00$00' })
        .throwOnError()
    })

    afterAll(async () => {
      if (!RUN) return
      // The PIN row's created_by_admin_id references this admin, and this inner afterAll
      // runs BEFORE the outer one deletes staff_sessions — clear the row first or the
      // admin delete fails on the FK (and would silently leak the account).
      await sb.from('staff_sessions').delete().eq('weekly_event_id', event).throwOnError()
      await sb.from('admin_accounts').delete().eq('id', adminId).throwOnError()
    })

    it('a PIN issued days ahead records the admin + expiry contract and still logs in ON its Sunday', async () => {
      const res = await issueStaffPin({ eventId: event, sunday: SUNDAY, adminId, now: MONDAY_BEFORE }, repo)
      if (!res.ok) throw new Error(`expected ok, got ${res.reason}`)
      // survives until the end of its Sunday (Taipei): 2099-05-04T00:00+08 = 05-03T16:00Z
      expect(res.expiresAt).toBe('2099-05-03T16:00:00.000Z')
      const raw = (await sb.from('staff_sessions').select('created_by_admin_id, expires_at')
        .eq('weekly_event_id', event).single()).data!
      expect(raw.created_by_admin_id).toBe(adminId)

      // login DURING that Sunday with the early-issued PIN succeeds
      expect((await loginStaff(res.pin, repo, DURING_SUNDAY)).ok).toBe(true)
    })

    it('replacing the PIN immediately invalidates the old one and unlocks', async () => {
      const first = await issueStaffPin({ eventId: event, sunday: SUNDAY, adminId, now: MONDAY_BEFORE }, repo)
      if (!first.ok) throw new Error('expected ok')
      // Lock it with wrong attempts. locked_at is stamped with REAL wall-clock time by the
      // RPC, so the lock assertions must use real "now" — from the 2099 vantage point the
      // cooldown would look long expired.
      for (let i = 0; i < 5; i++) await loginStaff('000000', repo)
      expect(await loginStaff(first.pin, repo)).toEqual({ ok: false, reason: 'locked' })

      // unlock keeps the ORIGINAL pin working (no replacement) — real now: lock is cleared
      const unlocked = await unlockStaffPin({ eventId: event, sunday: SUNDAY, now: MONDAY_BEFORE }, repo)
      expect(unlocked.ok).toBe(true)
      expect((await loginStaff(first.pin, repo)).ok).toBe(true)

      // re-issue: old pin dies, new pin works (upsert also clears counters atomically)
      const second = await issueStaffPin({ eventId: event, sunday: SUNDAY, adminId, now: MONDAY_BEFORE }, repo)
      if (!second.ok) throw new Error('expected ok')
      if (second.pin !== first.pin) {
        expect(await loginStaff(first.pin, repo, DURING_SUNDAY)).toEqual({ ok: false, reason: 'invalid' })
      }
      expect((await loginStaff(second.pin, repo, DURING_SUNDAY)).ok).toBe(true)
    })

    it('concurrent double issue: exactly one of the two returned PINs can log in', async () => {
      const [a, b] = await Promise.all([
        issueStaffPin({ eventId: event, sunday: SUNDAY, adminId, now: MONDAY_BEFORE }, repo),
        issueStaffPin({ eventId: event, sunday: SUNDAY, adminId, now: MONDAY_BEFORE }, repo),
      ])
      if (!a.ok || !b.ok) throw new Error('expected both ok')
      if (a.pin === b.pin) return // astronomically unlikely; nothing to distinguish
      const [ra, rb] = [await loginStaff(a.pin, repo, DURING_SUNDAY), await loginStaff(b.pin, repo, DURING_SUNDAY)]
      expect([ra.ok, rb.ok].filter(Boolean)).toHaveLength(1)
    })

    it('refuses a past Sunday outside the managed window', async () => {
      // from a "now" AFTER the event's Sunday, 2099-05-03 is in the past
      const later = new Date('2099-05-04T02:00:00Z')
      expect(await issueStaffPin({ eventId: event, sunday: SUNDAY, adminId, now: later }, repo))
        .toEqual({ ok: false, reason: 'sunday_not_managed' })
    })
  })
})
