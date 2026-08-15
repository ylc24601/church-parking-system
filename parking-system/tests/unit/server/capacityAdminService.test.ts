import { describe, expect, it, vi } from 'vitest'
import { makeMockRepo, asRepo, type MockRepo } from './mockRepo'
import {
  getCapacityCards,
  getManagedCapacitySundays,
  setCapacity,
} from '@/server/services/capacityAdminService'
import type { AuditActor } from '@/server/services/auditContext'

function run(over: Partial<MockRepo> = {}) {
  const repo = makeMockRepo(over)
  return { repo, r: asRepo(repo) }
}

const ACTOR: AuditActor = {
  actorType: 'admin',
  actorId: 'admin-1',
  actorSessionId: 'sess-1',
  actorRoleSnapshot: null,
}
// Taipei Wed 2026-06-17 → the upcoming Sunday is 2026-06-21.
const NOW = new Date('2026-06-17T04:00:00Z')

const capacityRow = (over: Record<string, unknown> = {}) => ({
  id: 'event-1',
  sunday_date: '2026-06-21',
  status: 'open',
  total_capacity: 23,
  blocked_spaces: 3,
  admin_reserved: 0,
  capacity_version: 0,
  active_full_time_staff_reserved: 1,
  ...over,
})

describe('getManagedCapacitySundays', () => {
  it('is the Taipei calendar current + next Sunday, not getActiveEvent', () => {
    // getActiveEvent means "latest non-finalized", which would serve up last week
    // whenever it was simply never finalized — a 幹事 would then edit the wrong week's
    // capacity. Same rule (and reason) as the staff-PIN page.
    expect(getManagedCapacitySundays(NOW)).toEqual({
      currentSunday: '2026-06-21',
      nextSunday: '2026-06-28',
    })
  })

  it('treats Sunday itself as the current week all day', () => {
    // 2026-06-21 15:59Z is still Sunday in Taipei (UTC+8).
    expect(getManagedCapacitySundays(new Date('2026-06-21T15:59:00Z')).currentSunday).toBe('2026-06-21')
    expect(getManagedCapacitySundays(new Date('2026-06-21T16:00:00Z')).currentSunday).toBe('2026-06-28')
  })
})

describe('getCapacityCards', () => {
  it('previews with the SAME formula the allocator uses', async () => {
    // 23 − 3 blocked − 0 admin_reserved − 1 staff = 19. If this preview and
    // computeCapacity ever disagree, the 幹事 is being shown a number the allocator will
    // not honour.
    const { r } = run({ getWeeklyCapacityAdmin: vi.fn(async () => capacityRow()) })
    const { current } = await getCapacityCards({ now: NOW }, r)
    expect(current).toMatchObject({
      sunday: '2026-06-21',
      totalCapacity: 23,
      blockedSpaces: 3,
      reservedStaff: 1,
      effectiveCapacity: 19,
      capacityVersion: 0,
      editable: true,
      notEditableReason: null,
    })
  })

  it('surfaces promised seats so the form can warn before the DB refuses', async () => {
    const { r } = run({
      getWeeklyCapacityAdmin: vi.fn(async () => capacityRow()),
      countPromisedReservations: vi.fn(async () => 7),
    })
    expect((await getCapacityCards({ now: NOW }, r)).current!.promisedCount).toBe(7)
  })

  it('a Sunday with no event row yet is "nothing to edit", not an error', async () => {
    // The ensure-weekly-event job creates the row; next Sunday legitimately may not
    // exist yet.
    const { r } = run({ getWeeklyCapacityAdmin: vi.fn(async () => null) })
    const cards = await getCapacityCards({ now: NOW }, r)
    expect(cards.current).toBeNull()
    expect(cards.next).toBeNull()
  })

  it.each([
    ['finalized', false],
    ['closed', false],
    ['open', true],
    ['some_future_status', false],
  ])('status %s → editable=%s (allowlist, unknown fails closed)', async (status, editable) => {
    // An allowlist, so a status nobody has thought about does not become silently
    // editable. Mirrors the RPC's own check.
    const { r } = run({ getWeeklyCapacityAdmin: vi.fn(async () => capacityRow({ status })) })
    const card = (await getCapacityCards({ now: NOW }, r)).current!
    expect(card.editable).toBe(editable)
    if (!editable) expect(card.notEditableReason).toBeTruthy()
  })
})

describe('setCapacity', () => {
  it('threads actor, session and requestId through to the RPC', async () => {
    const { repo, r } = run()
    await setCapacity({
      eventId: 'event-1', sunday: '2026-06-21', totalCapacity: 23, blockedSpaces: 5,
      expectedVersion: 2, actor: ACTOR, requestId: 'req-1',
    }, r)
    expect(repo.setWeeklyCapacity).toHaveBeenCalledWith({
      eventId: 'event-1', sunday: '2026-06-21', totalCapacity: 23, blockedSpaces: 5,
      expectedVersion: 2, actingAdminId: 'admin-1', actingSessionId: 'sess-1', requestId: 'req-1',
    })
  })

  it('refuses an actor it cannot attribute, without touching the repo', async () => {
    // The audit row is written inside the RPC's transaction, so a capacity change that
    // cannot be pinned on anyone must not happen at all.
    const { repo, r } = run()
    await expect(
      setCapacity({
        eventId: 'event-1', sunday: '2026-06-21', totalCapacity: 23, blockedSpaces: 5,
        expectedVersion: 0, actor: { ...ACTOR, actorSessionId: null }, requestId: 'req-1',
      }, r),
    ).rejects.toThrow(/admin actor/)
    expect(repo.setWeeklyCapacity).not.toHaveBeenCalled()
  })

  it.each([
    ['capacity_below_promised'],
    ['conflict'],
    ['event_not_editable'],
    ['allocation_in_progress'],
    ['negative_capacity'],
    ['sunday_mismatch'],
  ])('passes the typed refusal %s straight through', async reason => {
    const { r } = run({ setWeeklyCapacity: vi.fn(async () => ({ ok: false, reason })) })
    const res = await setCapacity({
      eventId: 'event-1', sunday: '2026-06-21', totalCapacity: 23, blockedSpaces: 5,
      expectedVersion: 0, actor: ACTOR, requestId: 'req-1',
    }, r)
    expect(res).toMatchObject({ ok: false, reason })
  })

  it('reports a no-op as success without pretending anything changed', async () => {
    const { r } = run({
      setWeeklyCapacity: vi.fn(async () => ({
        ok: true, noop: true, effective_capacity: 19, promised_count: 0, capacity_version: 3,
      })),
    })
    const res = await setCapacity({
      eventId: 'event-1', sunday: '2026-06-21', totalCapacity: 23, blockedSpaces: 3,
      expectedVersion: 3, actor: ACTOR, requestId: 'req-1',
    }, r)
    expect(res).toEqual({ ok: true, noop: true, effectiveCapacity: 19, promisedCount: 0, capacityVersion: 3 })
  })
})
