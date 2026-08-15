import { computeCapacity } from '@/lib/allocation/allocate'
import { addDaysToIsoDate } from '@/lib/eligibilityStatus'
import { upcomingSundayISO } from '@/lib/taipeiDate'
import type { CapacityCard, CapacityCards } from '@/lib/capacityAdminTypes'
import { requireAdminActor, type AuditActor } from '@/server/services/auditContext'
import { createParkingRepository, type ParkingRepository } from '@/server/repositories/parkingRepository'

// ── Weekly capacity admin (Wave 2B-1 / #14A) ─────────────────────────────────
// Lets a 幹事 change a week's capacity from the UI. Until now the only way was the
// hand-written SQL the runbook told operators to run.
//
// The read path here keeps using the pure computeCapacity — 0004's decision ("the view
// supplies inputs, NOT the formula") still stands for reads, and this preview must show
// exactly what the allocator will compute. The transactional guard in set_weekly_capacity
// necessarily recomputes the same formula in SQL, because a guard that runs here would
// be bypassable and could not be atomic. Those two copies are pinned against each other
// by the parity test in tests/integration/weekly-capacity.db.test.ts.

export type { CapacityCard, CapacityCards } from '@/lib/capacityAdminTypes'

// An ALLOWLIST, mirroring the RPC's. 'closed' exists in the enum but nothing writes it;
// if that ever changes, someone must consciously decide whether capacity is editable
// then, rather than inheriting "editable" by default.
const EDITABLE_STATUSES = new Set(['open'])

const NOT_EDITABLE_COPY: Record<string, string> = {
  finalized: '這一週已結算，車位設定已鎖定',
  closed: '這一週已關閉，車位設定已鎖定',
}

export type SetCapacityReason =
  | 'not_found'
  | 'sunday_mismatch'
  | 'event_not_editable'
  | 'conflict'
  | 'allocation_in_progress'
  | 'negative_capacity'
  | 'capacity_below_promised'

export type SetCapacityResult =
  | { ok: true; noop: boolean; effectiveCapacity: number; promisedCount: number; capacityVersion: number }
  | { ok: false; reason: SetCapacityReason; effectiveCapacity?: number; promisedCount?: number; actualVersion?: number }

// The current + next Sunday of the TAIPEI CALENDAR — deliberately not getActiveEvent(),
// whose "latest non-finalized" semantics would serve up a stale week that was simply
// never finalized. Same rule (and same reason) as the staff-PIN page documents.
export function getManagedCapacitySundays(now: Date): { currentSunday: string; nextSunday: string } {
  const currentSunday = upcomingSundayISO(now)
  return { currentSunday, nextSunday: addDaysToIsoDate(currentSunday, 7) }
}

export async function getCapacityCards(
  params: { now?: Date } = {},
  repo: ParkingRepository = createParkingRepository(),
): Promise<CapacityCards> {
  const { currentSunday, nextSunday } = getManagedCapacitySundays(params.now ?? new Date())

  const card = async (sunday: string): Promise<CapacityCard | null> => {
    const row = await repo.getWeeklyCapacityAdmin(sunday)
    // The weekly_events row is created by the ensure-weekly-event job, so a Sunday can
    // legitimately have none yet. That is a "nothing to edit" state, not an error.
    if (!row) return null

    const promisedCount = await repo.countPromisedReservations(row.id)
    const editable = EDITABLE_STATUSES.has(row.status)
    return {
      sunday,
      eventId: row.id,
      totalCapacity: row.total_capacity,
      blockedSpaces: row.blocked_spaces,
      reservedStaff: row.active_full_time_staff_reserved,
      effectiveCapacity: computeCapacity(row, row.active_full_time_staff_reserved),
      promisedCount,
      capacityVersion: row.capacity_version,
      editable,
      notEditableReason: editable ? null : (NOT_EDITABLE_COPY[row.status] ?? '這一週目前不可修改'),
    }
  }

  return { current: await card(currentSunday), next: await card(nextSunday) }
}

// Audited (0031). The actor/requestId go straight through to the RPC, which writes the
// audit row in the same transaction — this service must not build metadata, must not
// write a second row, and must not catch an audit failure and report success.
export async function setCapacity(
  params: {
    eventId: string
    sunday: string
    totalCapacity: number
    blockedSpaces: number
    expectedVersion: number
    actor: AuditActor
    requestId: string
  },
  repo: ParkingRepository = createParkingRepository(),
): Promise<SetCapacityResult> {
  const { adminId, sessionId } = requireAdminActor(params.actor)

  const res = await repo.setWeeklyCapacity({
    eventId: params.eventId,
    sunday: params.sunday,
    totalCapacity: params.totalCapacity,
    blockedSpaces: params.blockedSpaces,
    expectedVersion: params.expectedVersion,
    actingAdminId: adminId,
    actingSessionId: sessionId,
    requestId: params.requestId,
  })

  if (!res.ok) {
    return {
      ok: false,
      reason: (res.reason ?? 'not_found') as SetCapacityReason,
      effectiveCapacity: res.effective_capacity,
      promisedCount: res.promised_count,
      actualVersion: res.actual_version,
    }
  }
  return {
    ok: true,
    noop: res.noop ?? false,
    effectiveCapacity: res.effective_capacity!,
    promisedCount: res.promised_count!,
    capacityVersion: res.capacity_version!,
  }
}
