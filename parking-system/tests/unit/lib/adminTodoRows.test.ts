import { describe, expect, it } from 'vitest'
import { buildAdminTodoRows } from '@/lib/adminTodoRows'
import type { AdminTodoCounts } from '@/lib/adminTodoTypes'

const counts = (over: Partial<AdminTodoCounts> = {}): AdminTodoCounts => ({
  p2Review: 0,
  pastoralOpen: 0,
  notificationHealth: 'healthy',
  ops: null,
  ...over,
})

describe('buildAdminTodoRows', () => {
  it('P2 + pastoral rows when > 0', () => {
    const rows = buildAdminTodoRows(counts({ p2Review: 1, pastoralOpen: 2 }))
    expect(rows).toEqual([
      { id: 'p2-review', href: '/admin/eligibility', label: '資格待審', count: 1, tone: 'warning' },
      { id: 'pastoral-open', href: '/admin/pastoral', label: '牧養關懷待跟進', count: 2, tone: 'warning' },
    ])
  })

  it('superadmin healthy backlog (attention 0, backlog 4) → 通知待送 4 row — NOT empty, so no 🎉', () => {
    const rows = buildAdminTodoRows(counts({ ops: { backlog: 4, attention: 0 } }))
    expect(rows).toEqual([{ id: 'ops-backlog', href: '/admin/ops', label: '通知待送', count: 4, tone: 'info' }])
  })

  it('superadmin unhealthy (attention 4) → 通知系統異常 4 (danger); backlog is not also shown', () => {
    const rows = buildAdminTodoRows(counts({ notificationHealth: 'attention', ops: { backlog: 4, attention: 4 } }))
    expect(rows).toEqual([{ id: 'ops-attention', href: '/admin/ops', label: '通知系統異常', count: 4, tone: 'danger' }])
  })

  it('superadmin all clear (everything 0, backlog 0) → no rows → the overview shows 🎉', () => {
    expect(buildAdminTodoRows(counts({ ops: { backlog: 0, attention: 0 } }))).toEqual([])
  })

  // ── #17 C: clerk plain verdict (ops null, notificationHealth drives a linkless row) ──

  it('clerk 異常 → linkless, countless 通知系統異常 escalation row (no /admin/ops href)', () => {
    const rows = buildAdminTodoRows(counts({ notificationHealth: 'attention' }))
    expect(rows).toEqual([
      { id: 'notification-health-attention', label: '通知系統異常，請聯絡系統管理員', tone: 'danger' },
    ])
    expect(rows[0].href).toBeUndefined()
    expect(rows[0].count).toBeUndefined()
  })

  it('health unavailable (either role) → linkless info notice, never a false 正常', () => {
    const rows = buildAdminTodoRows(counts({ notificationHealth: 'unavailable' }))
    expect(rows).toEqual([
      { id: 'notification-health-unavailable', label: '通知系統狀態暫時無法確認，請稍後重新整理', tone: 'info' },
    ])
    expect(rows[0].href).toBeUndefined()
  })

  it('clerk healthy → no notification row (a draining backlog is not their action — role decision, not a 3a regression)', () => {
    // The clerk verdict is a boolean-ish enum; a healthy-but-draining queue (due>0) is
    // indistinguishable from an empty one and, by product decision, shows nothing.
    expect(buildAdminTodoRows(counts({ notificationHealth: 'healthy' }))).toEqual([])
  })

  it('clerk with member-facing work but healthy notifications → only the member row', () => {
    const rows = buildAdminTodoRows(counts({ p2Review: 3, notificationHealth: 'healthy' }))
    expect(rows).toEqual([{ id: 'p2-review', href: '/admin/eligibility', label: '資格待審', count: 3, tone: 'warning' }])
  })
})
