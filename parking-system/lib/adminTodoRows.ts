import type { AdminTodoCounts } from '@/lib/adminTodoTypes'

// Dashboard "下待辦" rows (Wave 3 / #8, extended in #17 C). Pure + client-safe so the
// row/empty-state logic is unit-testable (the repo has no page-component harness).
//
// 🎉 (an empty return) means "nothing THIS ROLE needs to attend to" — NOT "the system is
// completely empty" (#17 C review). For a superadmin a healthy-but-draining backlog still
// produces its own "通知待送" row, so their 🎉 is genuine. For a clerk the plain verdict
// carries no backlog number and a healthy-draining queue is not theirs to act on, so it
// correctly shows no row. This is a role product decision, not a 3a regression.
export type AdminTodoTone = 'warning' | 'danger' | 'info'

// Stable per-row identity for React keys — never key on the (translatable) label, and a
// linkless row has no href to key on either.
export type AdminTodoRowId =
  | 'p2-review'
  | 'pastoral-open'
  | 'ops-attention'
  | 'ops-backlog'
  | 'notification-health-attention'
  | 'notification-health-unavailable'

export interface AdminTodoRow {
  id: AdminTodoRowId
  label: string
  tone: AdminTodoTone
  href?: string    // absent = non-interactive row (a clerk's notification verdict)
  count?: number   // absent = no badge (the clerk verdict carries no technical number)
}

export function buildAdminTodoRows(counts: AdminTodoCounts): AdminTodoRow[] {
  const rows: AdminTodoRow[] = []
  if (counts.p2Review > 0) {
    rows.push({ id: 'p2-review', href: '/admin/eligibility', label: '資格待審', count: counts.p2Review, tone: 'warning' })
  }
  if (counts.pastoralOpen > 0) {
    rows.push({ id: 'pastoral-open', href: '/admin/pastoral', label: '牧養關懷待跟進', count: counts.pastoralOpen, tone: 'warning' })
  }
  // Notification status. A superadmin (ops non-null) gets the full technical rows linking to
  // the ops page; otherwise the cross-role plain verdict drives a linkless, countless row —
  // 'attention' for a clerk's 異常, 'unavailable' when the health query couldn't be reached
  // (either role). 'healthy' shows nothing.
  if (counts.ops) {
    if (counts.ops.attention > 0) {
      rows.push({ id: 'ops-attention', href: '/admin/ops', label: '通知系統異常', count: counts.ops.attention, tone: 'danger' })
    } else if (counts.ops.backlog > 0) {
      rows.push({ id: 'ops-backlog', href: '/admin/ops', label: '通知待送', count: counts.ops.backlog, tone: 'info' })
    }
  } else if (counts.notificationHealth === 'attention') {
    rows.push({ id: 'notification-health-attention', label: '通知系統異常，請聯絡系統管理員', tone: 'danger' })
  } else if (counts.notificationHealth === 'unavailable') {
    rows.push({ id: 'notification-health-unavailable', label: '通知系統狀態暫時無法確認，請稍後重新整理', tone: 'info' })
  }
  return rows
}
