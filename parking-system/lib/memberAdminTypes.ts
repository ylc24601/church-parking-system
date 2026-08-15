// Client-safe admin member DTOs. No I/O, no imports — just the shape the server has already
// made safe to show.
//
// It lives in lib/, not in the service, because the UI that renders it (MemberTable, and through
// it MemberSearch) is client-reachable, and server/services/memberAdminService pulls in
// createParkingRepository → lib/supabase/server, which builds a SERVICE-ROLE client. That module
// is protected by a comment, not by the `server-only` package, so a value import from a client
// component would bundle it silently. Keeping the type here means the UI never has a reason to
// import from the server module at all. (Same reasoning as lib/memberImportSchema.ts.)

// The admin-facing Chinese label for a users.role value. ONE copy (MemberTable, the detail
// page, and the roster export all read it) so the wording can't drift. Unknown roles fall
// back to the raw value at the call site.
export const ROLE_LABEL: Record<string, string> = {
  user: '會友',
  full_time_staff: '全職同工',
  staff: '同工',
  admin: '管理員',
}

// What an admin may see in a LIST: the phone is already masked and line_id is already reduced to
// a boolean. The full number lives only on the session-gated detail page.
export interface MemberSearchItem {
  id: string
  displayName: string
  phoneMasked: string
  plateSummary: string // '' when no active plate; 'ABC-1234'; 'ABC-1234 ＋2'
  role: string
  bound: boolean
}
