import { normalizePlate } from '@/lib/plate'

// Shared, framework-agnostic presentation helpers for the Staff on-site list.
// Used by the live check-in screen (StaffCheckIn.tsx), its offline cache
// (staffCache.ts), and the printable backup sheet (/admin/print — an admin page
// since Wave 1a, but still the same Staff-safe rows). Keeping the status text /
// name·plate resolution here prevents the surfaces from drifting.
//
// NOTE: this is the CLIENT-serialized row shape — `attended_at` is an ISO string
// (the server `StaffCheckInRow` in lib/types.ts carries a Date + weekly_event_id).
// All fields come from staff_checkin_view → Staff-safe only (no penalty/contact data).

export interface StaffRow {
  reservation_id: string
  display_name: string | null
  license_plate: string | null
  walk_in_name: string | null
  walk_in_license_plate: string | null
  is_priority: boolean
  status: string
  attended_at: string | null
  owner_notifiable: boolean
}

// Statuses that count as "已到" (attended one way or another).
export const DONE_STATUSES = new Set(['attended', 'attended_after_release', 'walk_in'])

// Minimal structural shapes so helpers accept BOTH the client StaffRow and the
// server StaffCheckInRow (which differ only in attended_at / weekly_event_id).
type NamedRow = Pick<StaffRow, 'display_name' | 'walk_in_name'>
type PlatedRow = Pick<StaffRow, 'license_plate' | 'walk_in_license_plate'>
type WalkInRow = Pick<StaffRow, 'status' | 'display_name' | 'walk_in_license_plate'>

export function rowName(r: NamedRow): string {
  return r.display_name ?? r.walk_in_name ?? '（現場車輛）'
}

export function rowPlate(r: PlatedRow): string {
  return r.license_plate ?? r.walk_in_license_plate ?? ''
}

export function isWalkIn(r: WalkInRow): boolean {
  return r.status === 'walk_in' || (!r.display_name && !!r.walk_in_license_plate)
}

// 'YYYY-MM-DD' → 'M/D 主日'
export function sundayLabel(date: string): string {
  const [, m, d] = date.split('-')
  return `${Number(m)}/${Number(d)} 主日`
}

// Single source for the on-screen status wording (live list + print sheet).
export function statusLabel(status: string): string {
  switch (status) {
    case 'attended':
      return '已到'
    case 'attended_after_release':
      return '已到（補）'
    case 'walk_in':
      return '現場'
    case 'released_late':
      return '已釋出'
    case 'approved':
    default:
      return '未到場'
  }
}

// Order for the printed paper: priority (⭐) first, then by normalized plate so a
// volunteer can scan down the page. Pure + total — missing plate/name never throws.
export function sortRowsForPrint<T extends PlatedRow & { is_priority: boolean }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.is_priority !== b.is_priority) return a.is_priority ? -1 : 1
    return normalizePlate(rowPlate(a)).localeCompare(normalizePlate(rowPlate(b)))
  })
}
