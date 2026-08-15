'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { AdminRole } from '@/lib/adminRoles'
import { buildAdminNav, type AdminNavItem } from '@/lib/adminNav'
import { badgeForHref } from '@/lib/adminSidebarBadge'
import LogoutButton from './LogoutButton'
import { useAdminTodos } from './AdminTodoProvider'

// Persistent back-office nav (Slice 3.5 follow-up; two-zone IA in Wave 3 / #18). Routes are
// unchanged — this is a shared shell over the existing admin pages, not an SPA. Rendered only
// when the layout has a session; it does NOT gate auth (pages/APIs keep their own checks).
// print:hidden on the shell: no admin page should print its navigation, and /admin/print
// is a paper sheet that must come out clean.
//
// #18: items split into 「日常」 / 「系統維運」 zones (see lib/adminNav.ts). The divider shows
// ONLY when the system zone is non-empty (i.e. a superadmin) — a clerk sees the flat daily
// list with no divider, exactly as before. The zones carry meaning to assistive tech via
// role="group"/aria-label; the divider itself is decorative. Hiding an item is UX ONLY —
// the real gate is the server-side check on each page and API.

// Boundary-safe: /admin matches only itself; a section matches itself and its nested
// routes (so /admin/members/[id] keeps 會友管理 active) — never a bare startsWith that
// would let /admin/member falsely match /admin/members.
function isActive(pathname: string, href: string): boolean {
  if (href === '/admin') return pathname === '/admin'
  return pathname === href || pathname.startsWith(`${href}/`)
}

// Wave 3 (#9): a small count pill on nav items with outstanding todos. UX ONLY — a
// snapshot from the last full load / router.refresh(), and never an auth gate. The
// ops count uses `danger` (a broken pipeline); member-facing work uses `warning`.
function CountPill({ href, count }: { href: string; count: number }) {
  const tone = href === '/admin/ops' ? 'bg-danger-bg text-danger-fg' : 'bg-warning-bg text-warning-fg'
  return (
    <span
      className={`inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-xs font-bold leading-none ${tone}`}
    >
      {count}
      <span className="sr-only"> 件待處理</span>
    </span>
  )
}

// The separator between the two zones (#18). Purely decorative (aria-hidden) — the grouping
// meaning is on the role="group" wrappers. A vertical hairline in the mobile row, a
// horizontal rule in the desktop column.
function ZoneDivider() {
  return (
    <span
      aria-hidden
      className="w-px shrink-0 self-stretch bg-border mx-1 lg:mx-0 lg:my-2 lg:h-px lg:w-full lg:self-auto"
    />
  )
}

// Each zone lays out like the old flat nav did (mobile: a shrink-0 row; desktop: a full-width
// column), so the visual is unchanged apart from the divider between the two groups.
const ZONE_CLASS = 'flex shrink-0 gap-1 lg:w-full lg:flex-col lg:gap-0.5'

export default function AdminSidebar({ username, role }: { username: string; role: AdminRole }) {
  const pathname = usePathname()
  const homeActive = pathname === '/admin'
  const { daily, system } = buildAdminNav(role)
  // Snapshot counts (null = couldn't fetch → no badges, never treated as "all zero").
  const { counts } = useAdminTodos()

  const renderLink = (item: AdminNavItem) => {
    const active = isActive(pathname, item.href)
    const badge = counts ? badgeForHref(item.href, counts) : null
    return (
      <Link
        key={item.href}
        href={item.href}
        aria-current={active ? 'page' : undefined}
        className={`inline-flex min-h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-lg border-b-2 px-3 text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 lg:border-b-0 ${
          active
            ? 'border-primary font-semibold text-primary lg:bg-success-bg lg:shadow-[inset_2px_0_0_var(--color-primary)]'
            : 'border-transparent text-ink hover:text-primary lg:hover:bg-page'
        }`}
      >
        <span aria-hidden>{item.icon}</span>
        {item.label}
        {badge !== null && badge > 0 && <CountPill href={item.href} count={badge} />}
      </Link>
    )
  }

  return (
    <div className="sticky top-0 z-20 flex flex-col border-b border-border bg-surface print:hidden lg:h-dvh lg:w-56 lg:shrink-0 lg:overflow-y-auto lg:border-b-0 lg:border-r">
      {/* brand + username (mobile: logout shares this row) */}
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <Link
            href="/admin"
            aria-current={homeActive ? 'page' : undefined}
            className="inline-flex min-h-11 items-center text-base font-bold text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
          >
            ⛪ 管理後台
          </Link>
          <p className="truncate text-xs text-muted">{username}</p>
        </div>
        <div className="shrink-0 lg:hidden">
          <LogoutButton />
        </div>
      </div>

      {/* nav — mobile: one horizontally-scrollable row; desktop: vertical, grows to push logout down.
          #18: two zones (日常 / 系統維運) with a divider that shows only when the system zone exists. */}
      <nav
        aria-label="管理後台導覽"
        className="flex gap-1 overflow-x-auto overscroll-x-contain px-3 pb-2 lg:flex-1 lg:flex-col lg:gap-0.5 lg:overflow-x-visible lg:px-2 lg:pb-2"
      >
        <div role="group" aria-label="日常管理" className={ZONE_CLASS}>
          {daily.map(renderLink)}
        </div>
        {system.length > 0 && <ZoneDivider />}
        {system.length > 0 && (
          <div role="group" aria-label="系統維運" className={ZONE_CLASS}>
            {system.map(renderLink)}
          </div>
        )}
      </nav>

      {/* desktop: logout pinned at the bottom (reachable via the sidebar's own scroll) */}
      <div className="hidden px-4 pb-4 lg:block">
        <LogoutButton />
      </div>
    </div>
  )
}
