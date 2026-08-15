import { can, type AdminCapability, type AdminRole } from '@/lib/adminRoles'

// Admin sidebar navigation data + zone split (Wave 3 / #18). Client-safe (no I/O, no server
// imports) — AdminSidebar is a client component. The logic lives here and is tested in
// tests/unit/lib because the repo has no page-component test harness (same reasoning as
// lib/adminSidebarBadge.ts).
//
// Two IA zones: 「日常」 (everyday church-admin work) and 「系統維運」 (system maintenance).
// The zone split is INFORMATION ARCHITECTURE, not an auth boundary — the real gate is the
// per-page/API capability check; `capability` here only hides an item the operator cannot
// open (UX). Today every system-zone item happens to be capability-gated (⟺ the #19 role
// boundary), but `zone` is declared EXPLICITLY rather than inferred from `capability`, so IA
// and permissions stay decoupled: a future daily item that gains a capability must still read
// `zone: 'daily'` and not drift into the system zone.

export type AdminNavZone = 'daily' | 'system'

export interface AdminNavItem {
  href: string
  label: string
  icon: string
  zone: AdminNavZone
  capability?: AdminCapability
}

// `as const satisfies` pins the shape AND makes the array readonly, so no consumer can mutate
// the nav order (same discipline as ADMIN_ROLES in lib/adminRoles.ts). System items are
// collected at the end; daily items keep their established relative order.
export const ADMIN_NAV = [
  { href: '/admin/bindings', label: '綁定審核', icon: '🔗', zone: 'daily' },
  { href: '/admin/members', label: '會友管理', icon: '👥', zone: 'daily' },
  { href: '/admin/eligibility', label: '資格審查', icon: '🏷️', zone: 'daily' },
  { href: '/admin/import', label: '名單匯入', icon: '📥', zone: 'daily' },
  { href: '/admin/print', label: '列印點名表', icon: '🖨', zone: 'daily' },
  { href: '/admin/capacity', label: '車位設定', icon: '🅿️', zone: 'daily' },
  { href: '/admin/pastoral', label: '牧養關懷', icon: '💚', zone: 'daily' },
  { href: '/admin/staff-pin', label: '現場 PIN 管理', icon: '🔑', zone: 'daily' },
  { href: '/admin/accounts', label: '帳號管理', icon: '⚙️', zone: 'system', capability: 'manage_admin_accounts' },
  { href: '/admin/audit', label: '稽核記錄', icon: '📜', zone: 'system', capability: 'view_audit' },
  { href: '/admin/ops', label: '通知系統狀態', icon: '📊', zone: 'system', capability: 'view_ops' },
] as const satisfies readonly AdminNavItem[]

// Visible items for a role, split by zone. The capability filter (visibility) is applied
// FIRST, then the zone grouping — so a role with no system-zone visibility gets system: [],
// and the sidebar then renders neither the divider nor the system group.
export function buildAdminNav(role: AdminRole): { daily: AdminNavItem[]; system: AdminNavItem[] } {
  // Widen the `as const` tuple to the interface array so the optional `capability` is
  // reachable on every element (the narrowed literals omit it on ungated items).
  const items: readonly AdminNavItem[] = ADMIN_NAV
  const visible = items.filter(item => !item.capability || can(role, item.capability))
  return {
    daily: visible.filter(item => item.zone === 'daily'),
    system: visible.filter(item => item.zone === 'system'),
  }
}
