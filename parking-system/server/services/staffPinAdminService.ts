import { randomInt } from 'node:crypto'
import { STAFF_PIN_LOCK_MINUTES } from '@/lib/allocation/rules'
import { getStaffPinManagedSundays, staffPinExpiry } from '@/lib/staffPinSchedule'
import { hashPin } from '@/server/http/pinHash'
import { createParkingRepository, type ParkingRepository } from '@/server/repositories/parkingRepository'

// Phase 8 Slice 8 — Admin management of the per-event shared on-site PIN. The managed
// Sundays (current + next, Taipei calendar) come from getStaffPinManagedSundays — NOT
// getActiveEvent(), whose latest-non-finalized semantics would mislabel an unfinalized
// last week as "current". Expiry follows the admin-issue contract in staffPinExpiry
// (survives until the end of its Sunday even when issued days ahead); the legacy
// setStaffPin CLI keeps its own now+TTL contract for emergency use.
// The plaintext PIN exists only in the issue response (shown once by the UI); it is
// never stored, logged, or re-readable. pin_hash never crosses this surface.

// The DTO now lives in lib/ so the Client Component that renders it never imports this
// (server-only) module. Re-exported so server-side callers keep one import site.
export type { StaffPinCardStatus } from '@/lib/staffPinAdminTypes'
import type { StaffPinCardStatus } from '@/lib/staffPinAdminTypes'

export async function getStaffPinStatus(
  params: { now?: Date } = {},
  repo: ParkingRepository = createParkingRepository(),
): Promise<{ current: StaffPinCardStatus; next: StaffPinCardStatus }> {
  const now = params.now ?? new Date()
  const { currentSunday, nextSunday } = getStaffPinManagedSundays(now)

  const card = async (sunday: string): Promise<StaffPinCardStatus> => {
    const event = await repo.getWeeklyEventBySunday(sunday)
    if (!event) {
      return { sunday, eventId: null, hasPin: false, expiresAt: null, failedAttempts: 0, locked: false }
    }
    const row = await repo.getStaffSessionByEvent(event.id)
    const locked = row?.locked_at
      ? now.getTime() < row.locked_at.getTime() + STAFF_PIN_LOCK_MINUTES * 60_000
      : false
    return {
      sunday,
      eventId: event.id,
      hasPin: row !== null,
      expiresAt: row ? row.expires_at.toISOString() : null,
      failedAttempts: row?.failed_attempts ?? 0,
      locked,
    }
  }

  return { current: await card(currentSunday), next: await card(nextSunday) }
}

export type IssueStaffPinResult =
  | { ok: true; pin: string; eventId: string; sunday: string; expiresAt: string }
  | { ok: false; reason: 'event_not_found' | 'sunday_mismatch' | 'sunday_not_managed' }

// Both mutations double-check the client's {eventId, sunday} pair server-side: the event
// must exist, its sunday must equal the submitted sunday (the pair the admin SAW), and
// the sunday must be one of the two managed dates (past events can never be issued).
async function verifyTarget(
  args: { eventId: string; sunday: string; now: Date },
  repo: ParkingRepository,
): Promise<{ ok: true } | { ok: false; reason: 'event_not_found' | 'sunday_mismatch' | 'sunday_not_managed' }> {
  const { currentSunday, nextSunday } = getStaffPinManagedSundays(args.now)
  if (args.sunday !== currentSunday && args.sunday !== nextSunday) {
    return { ok: false, reason: 'sunday_not_managed' }
  }
  const event = await repo.getWeeklyEventBySunday(args.sunday)
  if (!event) return { ok: false, reason: 'event_not_found' }
  if (event.id !== args.eventId) return { ok: false, reason: 'sunday_mismatch' }
  return { ok: true }
}

export async function issueStaffPin(
  args: { eventId: string; sunday: string; adminId: string; now?: Date },
  repo: ParkingRepository = createParkingRepository(),
): Promise<IssueStaffPinResult> {
  const now = args.now ?? new Date()
  const target = await verifyTarget({ eventId: args.eventId, sunday: args.sunday, now }, repo)
  if (!target.ok) return target

  // Uniform 6-digit PIN including leading zeros. Replacing an existing PIN atomically
  // clears failed_attempts/locked_at in the same upsert (pinned by tests).
  const pin = String(randomInt(0, 1_000_000)).padStart(6, '0')
  const expiresAt = staffPinExpiry(now, args.sunday)
  await repo.upsertStaffSessionPin({
    eventId: args.eventId,
    pinHash: hashPin(pin),
    expiresAt,
    createdByAdminId: args.adminId,
  })
  return { ok: true, pin, eventId: args.eventId, sunday: args.sunday, expiresAt }
}

export type UnlockStaffPinResult =
  | { ok: true; eventId: string; sunday: string }
  | { ok: false; reason: 'event_not_found' | 'sunday_mismatch' | 'sunday_not_managed' | 'no_pin' }

// Clears the failure lockout while KEEPING the existing PIN (the plaintext cannot be
// recovered, so nothing is returned to display).
export async function unlockStaffPin(
  args: { eventId: string; sunday: string; now?: Date },
  repo: ParkingRepository = createParkingRepository(),
): Promise<UnlockStaffPinResult> {
  const now = args.now ?? new Date()
  const target = await verifyTarget({ eventId: args.eventId, sunday: args.sunday, now }, repo)
  if (!target.ok) return target

  const row = await repo.getStaffSessionByEvent(args.eventId)
  if (!row) return { ok: false, reason: 'no_pin' }
  await repo.resetStaffSessionFailures(row.id)
  return { ok: true, eventId: args.eventId, sunday: args.sunday }
}
