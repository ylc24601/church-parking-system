// Client-safe pastoral-alert DTOs. No I/O, no imports — just the shape the server has
// already made safe to show.
//
// It lives in lib/, not in the service, because PastoralAlerts is a Client Component and
// server/services/pastoralAlertService pulls in createParkingRepository → lib/supabase/server,
// which builds a SERVICE-ROLE client. That module is now `server-only`, so a value import
// from a client component is a build error rather than a silent bundle — but the cleanest
// outcome is that the UI has no reason to import from the server module at all.
// (Same reasoning as lib/memberAdminTypes.ts.)

export interface OpenAlertItem {
  id: string
  displayName: string
  reason: string
  triggerCount: number
  currentConsecutiveNoShow: number | null   // null = no user_penalties row (no counter data)
  sunday: string
  createdAt: string
}

export interface ResolvedAlertItem {
  id: string
  displayName: string
  reason: string
  triggerCount: number
  sunday: string
  resolvedAt: string | null
  resolvedByUsername: string | null          // null = CLI/unknown/deleted account
  counterReset: boolean
  note: string | null
}
