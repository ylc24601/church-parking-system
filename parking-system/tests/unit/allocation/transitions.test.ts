import { describe, expect, it } from 'vitest'
import {
  getAllowedTransitions,
  isTerminalStatus,
  isValidTransition,
} from '@/lib/allocation/transitions'
import type { ReservationStatus } from '@/lib/types'

describe('isValidTransition', () => {
  // Valid forward transitions
  it.each([
    ['pending',       'approved'],
    ['pending',       'waiting'],
    ['pending',       'cancelled_by_user'],
    ['approved',      'attended'],
    ['approved',      'released_late'],
    ['approved',      'cancelled_late'],
    ['temp_approved', 'approved'],
    ['temp_approved', 'waiting'],
    ['waiting',       'temp_approved'],
    ['waiting',       'approved'],
    ['waiting',       'cancelled_by_user'],
    ['released_late', 'attended_after_release'],
    ['released_late', 'no_show'],
  ] as [ReservationStatus, ReservationStatus][])(
    '%s → %s is allowed',
    (from, to) => expect(isValidTransition(from, to)).toBe(true),
  )

  // Forbidden transitions that must never happen
  it.each([
    ['attended',               'no_show'],
    ['attended_after_release', 'no_show'],
    ['cancelled_late',         'no_show'],
    ['cancelled_by_user',      'no_show'],
    ['waiting',                'no_show'],
    ['walk_in',                'no_show'],
    ['no_show',                'pending'],
    ['attended',               'released_late'],
    ['pending',                'no_show'],
    ['pending',                'attended'],
    ['temp_approved',          'released_late'],
  ] as [ReservationStatus, ReservationStatus][])(
    '%s → %s is forbidden',
    (from, to) => expect(isValidTransition(from, to)).toBe(false),
  )
})

describe('isTerminalStatus', () => {
  it.each([
    'attended', 'attended_after_release', 'no_show',
    'cancelled_by_user', 'cancelled_late', 'walk_in',
  ] as ReservationStatus[])('%s is terminal', status => {
    expect(isTerminalStatus(status)).toBe(true)
  })

  it.each([
    'pending', 'approved', 'temp_approved', 'waiting', 'released_late',
  ] as ReservationStatus[])('%s is not terminal', status => {
    expect(isTerminalStatus(status)).toBe(false)
  })
})

describe('getAllowedTransitions', () => {
  it('returns empty array for terminal status', () => {
    expect(getAllowedTransitions('attended')).toEqual([])
    expect(getAllowedTransitions('walk_in')).toEqual([])
  })

  it('returns all valid next states for pending', () => {
    expect(getAllowedTransitions('pending')).toEqual(
      expect.arrayContaining(['approved', 'waiting', 'cancelled_by_user']),
    )
  })
})
