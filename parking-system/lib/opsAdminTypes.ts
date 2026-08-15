// Client-safe ops (notification-queue health) DTOs. No I/O, no imports — just the shape the
// server has already made safe to show.
//
// It lives in lib/, not in the repository/service, because OpsDashboard is a Client Component
// and both server/repositories/parkingRepository and server/services/outboxAlertService reach
// lib/supabase/server, which builds a SERVICE-ROLE client. That module is now `server-only`,
// so a value import from a client component is a build error rather than a silent bundle —
// but the cleanest outcome is that the UI has no reason to import from the server module at
// all. (Same reasoning as lib/memberAdminTypes.ts.)
//
// Everything here is OPERATION-SAFE by construction: counts, notification-template names,
// sanitized error codes and timestamps only — never a per-row or per-member field.

// Phase 4 Slice C — aggregate health of notification_outbox (from the outbox_health RPC).
export interface OutboxHealth {
  due: number
  due_by_template: Record<string, number>
  pending: number
  retrying: number
  processing: number
  stale_processing: number
  failed: number
  failed_by_error: Record<string, number>
  sent_last_24h: number
  oldest_pending_at: string | null
  oldest_due_at: string | null     // oldest row DUE now (drives the "backlog not draining" alert)
  oldest_failed_at: string | null
  next_retry_at: string | null
}

export interface AlertThresholds {
  failedMax: number            // alert when failed > this
  staleMax: number             // alert when stale_processing > this
  pendingStaleMinutes: number  // alert when the oldest DUE row is older than this (minutes)
}

export interface OutboxAlert {
  healthy: boolean
  breaches: string[]           // operation-safe reason codes
  thresholds: AlertThresholds
  failed: number
  stale_processing: number
  oldest_due_at: string | null
}
