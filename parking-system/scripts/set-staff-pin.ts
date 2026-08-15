// Provision the on-site Staff PIN for one Sunday's weekly_event (mirrors run-settle.ts).
//   npm run staff:set-pin -- --sunday 2026-06-21 --pin 246810 [--ttl-hours 12] [--created-by <uuid>]
//
// ⚠️ EMERGENCY FALLBACK ONLY (Phase 8 Slice 8): the normal path is the Admin UI at
// /admin/staff-pin, which generates a random PIN server-side (shown once, nothing on a
// command line) and uses the admin expiry contract (valid through the END of the Sunday
// — lib/staffPinSchedule.staffPinExpiry). This CLI keeps the LEGACY `now + ttl-hours`
// expiry, so a PIN set here days ahead will expire before its Sunday. The PIN passed on
// the command line may also be retained in shell history / the process list. The
// plaintext PIN is never stored or logged (only its scrypt hash lands in
// staff_sessions.pin_hash).
try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may be provided by the shell instead */
}

import { setStaffPin } from '../server/services/staffSessionService'

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const sunday = argValue('--sunday')
  const pin = argValue('--pin')
  if (!sunday || !pin) {
    throw new Error('usage: set-staff-pin --sunday <YYYY-MM-DD> --pin <6 digits> [--ttl-hours <n>] [--created-by <uuid>]')
  }
  const ttlRaw = argValue('--ttl-hours')
  const ttlHours = ttlRaw ? Number(ttlRaw) : undefined
  if (ttlRaw && (!Number.isFinite(ttlHours) || (ttlHours as number) <= 0)) {
    throw new Error(`--ttl-hours must be a positive number, got "${ttlRaw}"`)
  }

  const { eventId, expiresAt } = await setStaffPin({
    sunday,
    pin,
    ttlHours,
    createdBy: argValue('--created-by') ?? null,
  })
  // Never logs the PIN itself.
  console.log(`Staff PIN set for ${sunday} (event ${eventId}); expires ${expiresAt}`)
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
