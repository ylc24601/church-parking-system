// Client-safe capacity DTOs (Wave 2B-1 / #14A). No I/O, no imports — just the shape
// the server already made safe to show.
//
// It lives in lib/, not in the service, because CapacityForm is a client component and
// server/services/capacityAdminService pulls in createParkingRepository →
// lib/supabase/server, which builds a SERVICE-ROLE client. That module is protected by
// a comment, not by the `server-only` package, so a value import from a client
// component would bundle it silently. (Same reasoning as lib/memberAdminTypes.ts.)

// Whether this week's capacity may be edited at all. Derived from an ALLOWLIST of
// event statuses server-side, never from `status !== 'finalized'` — a future status
// must not become silently editable because nobody remembered to exclude it.
export interface CapacityCard {
  sunday: string                 // YYYY-MM-DD (Taipei calendar)
  eventId: string | null         // null = the weekly_events row does not exist yet
  totalCapacity: number
  blockedSpaces: number          // 「保留·停用」— the single number, post-0031 fold
  reservedStaff: number          // P1 staff holds; not editable here
  effectiveCapacity: number      // computeCapacity(...) — the same formula the allocator uses
  promisedCount: number          // approved + temp_approved: the floor an edit cannot go under
  capacityVersion: number        // optimistic lock; submitted back so a lost update is visible
  editable: boolean
  notEditableReason: string | null
}

export interface CapacityCards {
  current: CapacityCard | null
  next: CapacityCard | null
}
