import { describe, expect, it } from 'vitest'
import { getStaffPinManagedSundays, staffPinExpiry } from '@/lib/staffPinSchedule'

// The managed window is a TAIPEI calendar decision (UTC+8, no DST); 2026-07-19 and
// 2026-07-26 are Sundays. The Sunday-itself rule mirrors the member page: Sunday counts
// as "current" all day.

describe('getStaffPinManagedSundays', () => {
  it('Monday → the coming Sunday', () => {
    expect(getStaffPinManagedSundays(new Date('2026-07-13T02:00:00Z')))
      .toEqual({ currentSunday: '2026-07-19', nextSunday: '2026-07-26' })
  })

  it('Saturday → tomorrow', () => {
    expect(getStaffPinManagedSundays(new Date('2026-07-18T02:00:00Z')))
      .toEqual({ currentSunday: '2026-07-19', nextSunday: '2026-07-26' })
  })

  it('Sunday itself stays current ALL day (Taipei)', () => {
    // Taipei Sunday 08:00 and 23:30
    expect(getStaffPinManagedSundays(new Date('2026-07-19T00:00:00Z')).currentSunday).toBe('2026-07-19')
    expect(getStaffPinManagedSundays(new Date('2026-07-19T15:30:00Z')).currentSunday).toBe('2026-07-19')
  })

  it('Taipei date ≠ UTC date: UTC Sunday evening is already Taipei Monday → next week', () => {
    // 2026-07-19T20:00Z = Taipei Monday 2026-07-20 04:00 — a naive UTC computation
    // would still call 07-19 "current".
    expect(getStaffPinManagedSundays(new Date('2026-07-19T20:00:00Z')))
      .toEqual({ currentSunday: '2026-07-26', nextSunday: '2026-08-02' })
  })

  it('month and year rollovers are calendar-safe', () => {
    // Taipei Monday 2026-08-31 → Sunday lands in September
    expect(getStaffPinManagedSundays(new Date('2026-08-31T01:00:00Z')))
      .toEqual({ currentSunday: '2026-09-06', nextSunday: '2026-09-13' })
    // Taipei Monday 2026-12-28 → Sunday lands in 2027
    expect(getStaffPinManagedSundays(new Date('2026-12-28T01:00:00Z')))
      .toEqual({ currentSunday: '2027-01-03', nextSunday: '2027-01-10' })
  })
})

describe('staffPinExpiry', () => {
  it('a next-week PIN issued days ahead survives until the END of its Sunday (Taipei)', () => {
    // End of 2026-07-26 Taipei = 07-27T00:00+08 = 07-26T16:00Z
    expect(staffPinExpiry(new Date('2026-07-13T02:00:00Z'), '2026-07-26'))
      .toBe('2026-07-26T16:00:00.000Z')
  })

  it('a PIN issued Sunday morning covers the whole Sunday', () => {
    // Taipei Sunday 08:00; now+12h (12:00Z) < end-of-day (16:00Z) → end of day wins
    expect(staffPinExpiry(new Date('2026-07-19T00:00:00Z'), '2026-07-19'))
      .toBe('2026-07-19T16:00:00.000Z')
  })

  it('keeps the 12h login-TTL floor when issued late on Sunday', () => {
    // Taipei Sunday 18:00; end-of-day (16:00Z) < now+12h (22:00Z) → floor wins
    expect(staffPinExpiry(new Date('2026-07-19T10:00:00Z'), '2026-07-19'))
      .toBe('2026-07-19T22:00:00.000Z')
  })
})
