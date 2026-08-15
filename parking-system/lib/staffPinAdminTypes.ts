// Client-safe staff-PIN admin DTO. No I/O, no imports — just the shape the server has
// already made safe to show.
//
// It lives in lib/, not in the service, because StaffPinManager is a Client Component and
// server/services/staffPinAdminService pulls in createParkingRepository → lib/supabase/server,
// which builds a SERVICE-ROLE client. That module is now `server-only`, so a value import
// from a client component is a build error rather than a silent bundle — but the cleanest
// outcome is that the UI has no reason to import from the server module at all.
// (Same reasoning as lib/memberAdminTypes.ts.)

// One card per managed Sunday. The PIN itself is NEVER in here: it is shown exactly once,
// at issue time, and is not readable afterwards (scrypt, one-way).
export interface StaffPinCardStatus {
  sunday: string               // YYYY-MM-DD (Taipei calendar)
  eventId: string | null       // null = weekly_event row not created yet
  hasPin: boolean
  expiresAt: string | null     // ISO
  failedAttempts: number
  locked: boolean
}
