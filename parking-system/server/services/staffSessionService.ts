import { STAFF_PIN_LOCK_MINUTES, STAFF_PIN_MAX_ATTEMPTS, STAFF_SESSION_TTL_HOURS } from '@/lib/allocation/rules'
import { hashPin, verifyPin } from '@/server/http/pinHash'
import { createParkingRepository, type ParkingRepository } from '@/server/repositories/parkingRepository'

// Staff on-site PIN login + provisioning, backed by staff_sessions (one shared PIN
// row per weekly_event). Privacy: login never reveals whether a PIN exists for today —
// no-event / no-row / expired / wrong-PIN all return `invalid`; only lockout returns
// `locked` (so the UI can ask the volunteer to wait).

export type LoginResult =
  | { ok: true; sessionId: string; eventId: string }
  | { ok: false; reason: 'invalid' | 'locked' }

function isLocked(lockedAt: Date | null, now: Date): boolean {
  if (!lockedAt) return false
  return now.getTime() < lockedAt.getTime() + STAFF_PIN_LOCK_MINUTES * 60_000
}

export async function loginStaff(
  pin: string,
  repo: ParkingRepository = createParkingRepository(),
  now: Date = new Date(),
): Promise<LoginResult> {
  const event = await repo.getActiveEvent()
  if (!event) return { ok: false, reason: 'invalid' }

  const row = await repo.getStaffSessionByEvent(event.id)
  // No PIN configured, or the PIN window has passed → indistinguishable from a wrong PIN.
  if (!row || now >= row.expires_at) return { ok: false, reason: 'invalid' }

  // Lockout blocks new logins for the cooldown (does NOT evict live cookie sessions).
  if (isLocked(row.locked_at, now)) return { ok: false, reason: 'locked' }

  if (verifyPin(pin, row.pin_hash)) {
    await repo.resetStaffSessionFailures(row.id)
    return { ok: true, sessionId: row.id, eventId: event.id }
  }

  const after = await repo.applyStaffPinFailure(row.id, STAFF_PIN_MAX_ATTEMPTS)
  return { ok: false, reason: isLocked(after.locked_at, now) ? 'locked' : 'invalid' }
}

// CLI provisioning: hash the PIN and upsert the event's staff_sessions row. The
// plaintext PIN is never stored or logged.
export async function setStaffPin(
  args: { sunday: string; pin: string; ttlHours?: number; createdBy?: string | null },
  repo: ParkingRepository = createParkingRepository(),
  now: Date = new Date(),
): Promise<{ eventId: string; expiresAt: string }> {
  if (!/^\d{6}$/.test(args.pin)) throw new Error('PIN must be exactly 6 digits')

  const event = await repo.getWeeklyEventBySunday(args.sunday)
  if (!event) throw new Error(`No weekly_event for sunday ${args.sunday}`)

  const ttlHours = args.ttlHours ?? STAFF_SESSION_TTL_HOURS
  const expiresAt = new Date(now.getTime() + ttlHours * 3600_000).toISOString()
  await repo.upsertStaffSessionPin({
    eventId: event.id,
    pinHash: hashPin(args.pin),
    expiresAt,
    createdBy: args.createdBy ?? null,
  })
  return { eventId: event.id, expiresAt }
}
