import type { WeekStage } from '@/lib/weekStage'
import type { DemandCounts } from '@/lib/weekDemand'

// Client-safe admin overview / todo DTOs (Wave 3 / #8 + #9). No I/O, no server
// imports — AdminSidebar and AdminTodoProvider are client components that consume
// these, and importing server/services/* would bundle the service-role Supabase
// client into the client (see lib/capacityAdminTypes.ts for the same reasoning).

// Plain-language notification-system verdict, available to EVERY admin (#17 C). Split out
// from `ops` on purpose: a non-null `ops` ⇒ this admin has view_ops (never the reverse — see
// the field comment), while this three-state readout is the cross-role signal a clerk sees on
// the overview. 'attention' ⟺ the ops page's 異常; 'unavailable' ⟺ the health query
// couldn't be reached — never treated as healthy (fail-safe).
export type NotificationHealth = 'healthy' | 'attention' | 'unavailable'

export interface AdminTodoCounts {
  // Members whose P2 eligibility is due for a human review as of today. An EXACT count
  // over a minimal date-only candidate set (listEligibilityTodoCandidates), classified by
  // deriveEligibilityStatus (expired + review_due) — the authoritative classifier, not a
  // re-hand-coded date boundary, and with no list-page display cap.
  p2Review: number
  // Open pastoral-care alerts (v1: a single count; open/overdue split is deferred).
  pastoralOpen: number
  // Cross-role plain verdict (clerks see this on the overview; carries NO technical counts).
  notificationHealth: NotificationHealth
  // Technical ops data. ops non-null ⇒ view_ops — but NOT the reverse: it is non-null only
  // when the admin has view_ops AND the health query succeeded. A clerk always gets null (no
  // counts leak to their client); a superadmin gets null when health failed (notificationHealth
  // === 'unavailable'). Authorization is by role/capability, never by inspecting `ops`.
  ops: {
    backlog: number    // rows due to send now (informational "通知待送 N")
    attention: number  // drives the badge; 0 when the ops verdict is healthy (⟺ 正常)
  } | null
}

// The todo counts are AUXILIARY: a query failure must never take down the whole
// admin shell (the layout that fetches this wraps every /admin page). So the snapshot
// carries counts OR an explicit null — null means "couldn't fetch", NOT "all zero".
export interface AdminTodoSnapshot {
  counts: AdminTodoCounts | null
  snapshotAt: string  // ISO; shown on the overview + used by its "重新整理" affordance
}

export interface WeekOverview {
  sunday: string       // YYYY-MM-DD (Taipei calendar, upcomingSundayISO)
  stage: WeekStage
  capacity: {
    allocatable: number  // computeCapacity(...) TOTAL — the formula result, not "spaces left"
    blocked: number      // 保留·停用 (blocked_spaces, the single post-0031 number)
    promised: number     // approved + temp_approved
  } | null               // null = no weekly_events row yet (stage 'no_event')
  // The demand half (#32). Capacity alone leaves the dashboard blank during
  // application_open — everything is still `pending`, so 已核准 sits at 0 exactly when a
  // clerk most needs to judge supply against demand. The priority/general split comes from
  // the reservation's FROZEN effective_priority (see lib/weekDemand.ts); it is never
  // recomputed from today's eligibility.
  //
  // waiting carries its split even though the v1 UI only breaks down pending — the split
  // costs nothing here, and putting it in the DTO now means surfacing it later is a UI
  // change instead of a service change.
  demand: {
    pending: DemandCounts
    waiting: DemandCounts
  } | null               // null ⟺ capacity is null (no weekly_events row)
}
