import { normalizePlate } from '@/lib/plate'
import {
  createParkingRepository,
  type ParkingRepository,
} from '@/server/repositories/parkingRepository'
import type { StaffCheckInRow } from '@/lib/types'

export type WalkInResult =
  | { created: true; row: StaffCheckInRow }
  | { created: false; duplicate: true }

// Staff registers a walk-in (a car that showed up without a reservation). It's
// recorded as present (status='walk_in', attended_at=now, P3) and shows up on the
// on-site list. Dedupe is two-layer:
//   1) app precheck here against the Staff-safe on-site list — catches a plate that
//      is ALREADY on the list, including an approved member's vehicle plate;
//   2) the walk_in unique index (0009) — the race backstop for two devices at once.
export async function registerWalkIn(
  params: { eventId: string; plate: string; name?: string | null; now?: Date },
  repo: ParkingRepository = createParkingRepository(),
): Promise<WalkInResult> {
  const { eventId, now = new Date() } = params
  const plate = params.plate.trim()
  if (!plate) throw new Error('license_plate is required')
  const name = params.name?.trim() || null

  // Precheck: is this plate already on the on-site list (member or walk-in)?
  const target = normalizePlate(plate)
  const existing = await repo.getStaffCheckInList(eventId)
  const clash = existing.some(r => {
    const p = r.license_plate ?? r.walk_in_license_plate
    return p != null && normalizePlate(p) === target
  })
  if (clash) return { created: false, duplicate: true }

  const result = await repo.createWalkInReservation(eventId, plate, name, now.toISOString())
  if ('duplicate' in result) return { created: false, duplicate: true }
  return { created: true, row: result.row }
}
