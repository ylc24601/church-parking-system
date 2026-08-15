// Client-safe binding-review DTO. No I/O, no imports — just the shape the server has already
// made safe to show.
//
// It lives in lib/, not in the service, because BindingReview is a Client Component and
// server/services/bindingAdminService pulls in createParkingRepository → lib/supabase/server,
// which builds a SERVICE-ROLE client. That module is now `server-only`, so a value import
// from a client component is a build error rather than a silent bundle — but the cleanest
// outcome is that the UI has no reason to import from the server module at all.
// (Same reasoning as lib/memberAdminTypes.ts.)

// `claim` is ALREADY masked by the service (keyword → masked code; liff → name / masked
// phone). The raw code and the full phone never leave the server.
export interface PendingClaimListItem {
  id: string
  shortId: string
  source: string
  submittedAt: string
  lastUpdatedAt: string
  resubmits: number
  claim: string
}
