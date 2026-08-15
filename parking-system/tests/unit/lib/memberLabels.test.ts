import { describe, expect, it } from 'vitest'
import { RELEASE_TIMES } from '@/lib/allocation/rules'
import { memberSundayLabel, releaseTimeLabel } from '@/lib/memberLabels'

describe('memberSundayLabel', () => {
  it('renders a Sunday as member-voice prose, not an ISO date', () => {
    expect(memberSundayLabel('2026-07-19')).toBe('7月19日 主日')
    // no zero padding in the prose
    expect(memberSundayLabel('2026-01-04')).toBe('1月4日 主日')
  })

  // The notification payload is JSON read back out of notification_outbox, so it is not trusted.
  // A shape check alone would print dates that don't exist.
  it.each([
    ['2026-02-29', 'Feb 29 in a non-leap year'],
    ['2026-04-31', 'April has 30 days'],
    ['2026-13-01', 'month 13'],
    ['2026-00-10', 'month 0'],
    ['2026-01-32', 'day 32'],
    ['2026-01-00', 'day 0'],
    ['0000-00-00', 'all zeroes'],
  ])('rejects %s (%s)', date => {
    expect(memberSundayLabel(date)).toBeNull()
  })

  it('accepts a real leap day', () => {
    expect(memberSundayLabel('2028-02-29')).toBe('2月29日 主日')
  })

  it.each([
    ['2026-7-9', 'unpadded'],
    ['not-a-date', 'junk'],
    ['', 'empty'],
    ['2026-07-19T00:00:00Z', 'a timestamp'],
    [' 2026-07-19', 'leading space'],
  ])('rejects the malformed string %s (%s)', value => {
    expect(memberSundayLabel(value)).toBeNull()
  })

  it.each([
    [undefined],
    [null],
    [20260719],
    [new Date('2026-07-19')],
    [{ sunday_date: '2026-07-19' }],
  ])('rejects the non-string %s', value => {
    expect(memberSundayLabel(value)).toBeNull()
  })
})

describe('releaseTimeLabel', () => {
  it('formats the release deadlines from their canonical constants', () => {
    expect(releaseTimeLabel(RELEASE_TIMES.p3)).toBe('10:30')
    expect(releaseTimeLabel(RELEASE_TIMES.p2)).toBe('10:30')
    expect(releaseTimeLabel(RELEASE_TIMES.p2Grace)).toBe('10:50')
  })

  it('zero-pads both parts', () => {
    expect(releaseTimeLabel({ hour: 9, minute: 5 })).toBe('09:05')
    expect(releaseTimeLabel({ hour: 0, minute: 0 })).toBe('00:00')
  })
})
