import { describe, expect, it, vi } from 'vitest'
import { registerWalkIn } from '@/server/services/walkInService'
import type { StaffCheckInRow } from '@/lib/types'
import { asRepo, makeMockRepo } from './mockRepo'

const EVENT = 'event-1'
const NOW = new Date('2026-06-21T02:00:00Z')

const listRow = (over: Partial<StaffCheckInRow>): StaffCheckInRow => ({
  reservation_id: 'r',
  weekly_event_id: EVENT,
  display_name: null,
  license_plate: null,
  walk_in_name: null,
  walk_in_license_plate: null,
  is_priority: false,
  status: 'approved',
  attended_at: null,
  owner_notifiable: false,
  ...over,
})

describe('registerWalkIn', () => {
  it('creates a walk-in when the plate is not already on the list', async () => {
    const repo = makeMockRepo({ getStaffCheckInList: vi.fn(async () => []) })
    const result = await registerWalkIn(
      { eventId: EVENT, plate: '  abc-9999 ', name: '  訪客 ', now: NOW },
      asRepo(repo),
    )

    expect(result.created).toBe(true)
    // trims plate + name, passes ISO now
    expect(repo.createWalkInReservation).toHaveBeenCalledWith(EVENT, 'abc-9999', '訪客', NOW.toISOString())
  })

  it('blank name becomes null', async () => {
    const repo = makeMockRepo({ getStaffCheckInList: vi.fn(async () => []) })
    await registerWalkIn({ eventId: EVENT, plate: 'XY-12', name: '   ', now: NOW }, asRepo(repo))
    expect(repo.createWalkInReservation).toHaveBeenCalledWith(EVENT, 'XY-12', null, NOW.toISOString())
  })

  it('rejects an empty plate (→ route 400)', async () => {
    const repo = makeMockRepo()
    await expect(
      registerWalkIn({ eventId: EVENT, plate: '   ', now: NOW }, asRepo(repo)),
    ).rejects.toThrow(/license_plate is required/)
    expect(repo.createWalkInReservation).not.toHaveBeenCalled()
  })

  it('duplicate vs an existing WALK-IN plate (normalized) → no insert', async () => {
    const repo = makeMockRepo({
      getStaffCheckInList: vi.fn(async () => [listRow({ status: 'walk_in', walk_in_license_plate: 'ABC-1234' })]),
    })
    const result = await registerWalkIn({ eventId: EVENT, plate: 'abc1234', now: NOW }, asRepo(repo))

    expect(result).toEqual({ created: false, duplicate: true })
    expect(repo.createWalkInReservation).not.toHaveBeenCalled()
  })

  it('duplicate vs an approved MEMBER plate (normalized) → no insert (precheck covers members)', async () => {
    const repo = makeMockRepo({
      getStaffCheckInList: vi.fn(async () => [listRow({ status: 'approved', license_plate: 'DEF 5678' })]),
    })
    const result = await registerWalkIn({ eventId: EVENT, plate: 'def-5678', now: NOW }, asRepo(repo))

    expect(result).toEqual({ created: false, duplicate: true })
    expect(repo.createWalkInReservation).not.toHaveBeenCalled()
  })

  it('surfaces the DB unique-index race as duplicate', async () => {
    const repo = makeMockRepo({
      getStaffCheckInList: vi.fn(async () => []),
      createWalkInReservation: vi.fn(async () => ({ duplicate: true })),
    })
    const result = await registerWalkIn({ eventId: EVENT, plate: 'NEW-1', now: NOW }, asRepo(repo))
    expect(result).toEqual({ created: false, duplicate: true })
  })
})
