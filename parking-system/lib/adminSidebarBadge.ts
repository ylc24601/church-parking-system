import type { AdminTodoCounts } from '@/lib/adminTodoTypes'

// Which sidebar nav item shows which todo count (Wave 3 / #9). Pulled out of the
// client AdminSidebar as a pure function so the mapping is unit-testable (the repo
// has no page-component test harness — logic lives in lib/, tested there).
//
// A null result means "no badge for this item". The ops item uses `attention`, NOT
// a raw failed+stale count: `attention` already folds in due_backlog_stale, so the
// badge lights whenever the ops page's health verdict is 異常 — the two can't disagree.
export function badgeForHref(href: string, counts: AdminTodoCounts): number | null {
  switch (href) {
    case '/admin/eligibility':
      return counts.p2Review
    case '/admin/pastoral':
      return counts.pastoralOpen
    case '/admin/ops':
      return counts.ops?.attention ?? null
    default:
      return null
  }
}
