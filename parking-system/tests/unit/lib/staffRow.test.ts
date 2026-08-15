import { describe, expect, it } from 'vitest'
import {
  type StaffRow,
  rowName,
  rowPlate,
  isWalkIn,
  sundayLabel,
  statusLabel,
  sortRowsForPrint,
} from '@/lib/staffRow'

function row(over: Partial<StaffRow>): StaffRow {
  return {
    reservation_id: 'r',
    display_name: null,
    license_plate: null,
    walk_in_name: null,
    walk_in_license_plate: null,
    is_priority: false,
    status: 'approved',
    attended_at: null,
    owner_notifiable: false,
    ...over,
  }
}

describe('statusLabel', () => {
  it('maps every known status', () => {
    expect(statusLabel('approved')).toBe('未到場')
    expect(statusLabel('attended')).toBe('已到')
    expect(statusLabel('attended_after_release')).toBe('已到（補）')
    expect(statusLabel('released_late')).toBe('已釋出')
    expect(statusLabel('walk_in')).toBe('現場')
  })
  it('falls back to 未到場 for unknown status', () => {
    expect(statusLabel('something_else')).toBe('未到場')
  })
})

describe('rowName / rowPlate / isWalkIn', () => {
  it('member row uses display_name + license_plate', () => {
    const r = row({ display_name: '王小明', license_plate: 'ABC-1234' })
    expect(rowName(r)).toBe('王小明')
    expect(rowPlate(r)).toBe('ABC-1234')
    expect(isWalkIn(r)).toBe(false)
  })

  it('walk-in row uses walk_in_* and is flagged', () => {
    const r = row({ status: 'walk_in', walk_in_name: '訪客', walk_in_license_plate: 'XYZ-9' })
    expect(rowName(r)).toBe('訪客')
    expect(rowPlate(r)).toBe('XYZ-9')
    expect(isWalkIn(r)).toBe(true)
  })

  it('walk-in without name falls back to placeholder', () => {
    const r = row({ walk_in_license_plate: 'XYZ-9' })
    expect(rowName(r)).toBe('（現場車輛）')
    expect(isWalkIn(r)).toBe(true) // no member name + has walk-in plate
  })

  it('row missing both name and plate does not throw', () => {
    const r = row({})
    expect(rowName(r)).toBe('（現場車輛）')
    expect(rowPlate(r)).toBe('')
    expect(isWalkIn(r)).toBe(false)
  })
})

describe('sundayLabel', () => {
  it('formats YYYY-MM-DD as M/D 主日', () => {
    expect(sundayLabel('2026-06-21')).toBe('6/21 主日')
    expect(sundayLabel('2026-12-06')).toBe('12/6 主日')
  })
})

describe('sortRowsForPrint', () => {
  it('puts priority rows first', () => {
    const out = sortRowsForPrint([
      row({ reservation_id: 'a', license_plate: 'AAA-1111' }),
      row({ reservation_id: 'b', license_plate: 'ZZZ-9999', is_priority: true }),
    ])
    expect(out.map(r => r.reservation_id)).toEqual(['b', 'a'])
  })

  it('sorts non-priority rows by normalized plate', () => {
    const out = sortRowsForPrint([
      row({ reservation_id: 'c', license_plate: 'bcd-2' }),
      row({ reservation_id: 'a', license_plate: 'ABC-1' }),
      row({ reservation_id: 'b', license_plate: 'abc-2' }),
    ])
    // ABC1 < ABC2 < BCD2 after normalize (uppercase, strip punctuation)
    expect(out.map(r => r.reservation_id)).toEqual(['a', 'b', 'c'])
  })

  it('orders walk-in rows by their walk-in plate alongside members', () => {
    const out = sortRowsForPrint([
      row({ reservation_id: 'w', status: 'walk_in', walk_in_license_plate: 'MMM-5' }),
      row({ reservation_id: 'm', license_plate: 'AAA-1' }),
    ])
    expect(out.map(r => r.reservation_id)).toEqual(['m', 'w'])
  })

  it('does not throw when plate/name are missing', () => {
    expect(() =>
      sortRowsForPrint([row({ reservation_id: 'x' }), row({ reservation_id: 'y', is_priority: true })]),
    ).not.toThrow()
    const out = sortRowsForPrint([row({ reservation_id: 'x' }), row({ reservation_id: 'y', is_priority: true })])
    expect(out[0].reservation_id).toBe('y') // priority first even with empty plates
  })

  it('does not mutate the input array', () => {
    const input = [row({ reservation_id: 'a', license_plate: 'B' }), row({ reservation_id: 'b', license_plate: 'A' })]
    const before = input.map(r => r.reservation_id)
    sortRowsForPrint(input)
    expect(input.map(r => r.reservation_id)).toEqual(before)
  })
})
