// Admin role tiers and what each one may reach (Wave 2C-1 / #19).
//
// Client-safe by construction: no I/O, no imports. It lives in lib/ rather than in the
// auth module because AdminSidebar is a client component and needs the same matrix to
// hide what the operator cannot open — and server/http/adminAuth pulls in
// createParkingRepository → lib/supabase/server, which builds a SERVICE-ROLE client.
// (Same reasoning as lib/memberAdminTypes.ts.)
//
// ⚠️ Hiding a nav item is UX. The gate is the server-side check on every page and API
// route; this module is only what both sides agree on.

export type AdminRole = 'superadmin' | 'clerk'

// The enum values, for a runtime guard (lib/adminAccountInput.ts isAdminRole). `satisfies`
// keeps this in step with the AdminRole union — drop a value and it stops compiling.
export const ADMIN_ROLES = ['superadmin', 'clerk'] as const satisfies readonly AdminRole[]

export const ADMIN_ROLE_LABEL: Record<AdminRole, string> = {
  superadmin: '系統管理員',
  clerk: '幹事',
}

// One capability per surface that is NOT open to every admin. Everything else —
// bindings, members, eligibility, import, print, capacity, pastoral, staff PIN — is
// available to any authenticated admin and deliberately has no entry here: inventing a
// capability for "what everyone can do" invites a future reader to think the absence of
// a check is an oversight.
export type AdminCapability =
  | 'manage_admin_accounts' // /admin/accounts + its three write APIs
  | 'view_ops'              // /admin/ops + ops/requeue
  | 'view_audit'            // /admin/audit
  | 'export_members'        // POST /api/admin/members/export (bulk-PII roster CSV)

// A matrix rather than `role === 'superadmin'`, and `satisfies` rather than a switch:
// adding a role OR a capability then fails to compile at exactly this table, which is
// the only place the answer should live. A switch without a `default` would not
// reliably error under this project's TS config, and a bare inequality against
// 'superadmin' would silently grant a future third role everything a clerk can do.
const ROLE_CAPABILITIES = {
  superadmin: { manage_admin_accounts: true, view_ops: true, view_audit: true, export_members: true },
  clerk: { manage_admin_accounts: false, view_ops: false, view_audit: false, export_members: false },
} satisfies Record<AdminRole, Record<AdminCapability, boolean>>

export function can(role: AdminRole, capability: AdminCapability): boolean {
  return ROLE_CAPABILITIES[role][capability]
}
