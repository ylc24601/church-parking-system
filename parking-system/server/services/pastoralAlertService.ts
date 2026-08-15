import { createParkingRepository, type ParkingRepository } from '@/server/repositories/parkingRepository'

// Phase 8 Slice 8 — pastoral-care alert handling (sensitive: admin surface ONLY, never
// Staff — the table's data never reaches any staff view). Listing pairs each open alert
// with the member's CURRENT consecutive_no_show via a separate user_penalties lookup
// (left-join semantics: a missing penalty row yields null and can never drop the alert).
// Resolution is atomic in the resolve_pastoral_alert RPC: status flip + audit fields +
// optional counter reset in one transaction. penalty_score is never touched and nothing
// is notified — per policy, these alerts are care, not punishment.

const OPEN_LIMIT = 100
const RESOLVED_LIMIT = 20
const NOTE_MAX_CODE_POINTS = 200
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// The DTOs now live in lib/ so the Client Component that renders them never imports this
// (server-only) module. Re-exported so server-side callers keep one import site.
export type { OpenAlertItem, ResolvedAlertItem } from '@/lib/pastoralAdminTypes'
import type { OpenAlertItem, ResolvedAlertItem } from '@/lib/pastoralAdminTypes'

export async function listPastoralAlerts(
  params: Record<never, never> = {},
  repo: ParkingRepository = createParkingRepository(),
): Promise<{
  open: OpenAlertItem[]
  openHasMore: boolean
  recentResolved: ResolvedAlertItem[]
  resolvedHasMore: boolean
}> {
  void params
  const [openRows, resolvedRows] = await Promise.all([
    repo.listPastoralAlerts('open', OPEN_LIMIT + 1),
    repo.listPastoralAlerts('resolved', RESOLVED_LIMIT + 1),
  ])
  const openHasMore = openRows.length > OPEN_LIMIT
  const resolvedHasMore = resolvedRows.length > RESOLVED_LIMIT
  const openSlice = openRows.slice(0, OPEN_LIMIT)
  const resolvedSlice = resolvedRows.slice(0, RESOLVED_LIMIT)

  // Current counters for the open list only — separate lookup, left-join semantics.
  const counters = await repo.getPenaltyCountersForUsers(openSlice.map(r => r.user_id))
  const byUser = new Map(counters.map(c => [c.user_id, c.consecutive_no_show]))

  return {
    open: openSlice.map(r => ({
      id: r.id,
      displayName: r.display_name,
      reason: r.reason,
      triggerCount: r.trigger_count,
      currentConsecutiveNoShow: byUser.get(r.user_id) ?? null,
      sunday: r.sunday_date,
      createdAt: r.created_at,
    })),
    openHasMore,
    recentResolved: resolvedSlice.map(r => ({
      id: r.id,
      displayName: r.display_name,
      reason: r.reason,
      triggerCount: r.trigger_count,
      sunday: r.sunday_date,
      resolvedAt: r.resolved_at,
      resolvedByUsername: r.resolved_by_username,
      counterReset: r.counter_reset,
      note: r.note,
    })),
    resolvedHasMore,
  }
}

export type ResolveAlertResult =
  | { ok: true; counterReset: boolean }
  | { ok: false; reason: 'not_found' | 'already_resolved' }

export async function resolvePastoralAlert(
  args: { alertId: string; adminId: string; note?: string | null; resetCounter?: boolean },
  repo: ParkingRepository = createParkingRepository(),
): Promise<ResolveAlertResult> {
  if (!UUID_RE.test(args.alertId)) throw new Error('invalid alertId')
  // Note: optional; trimmed-empty → null; bounded in CODE POINTS (emoji/CJK count as 1),
  // mirrored by the RPC and the DB check constraint.
  let note: string | null = null
  if (args.note !== undefined && args.note !== null) {
    if (typeof args.note !== 'string') throw new Error('invalid note')
    const trimmed = args.note.trim()
    if (trimmed !== '') {
      if ([...trimmed].length > NOTE_MAX_CODE_POINTS) throw new Error('note too long')
      note = trimmed
    }
  }
  const resetCounter = args.resetCounter ?? false

  const res = await repo.resolvePastoralAlert({
    alertId: args.alertId,
    adminId: args.adminId,
    note,
    resetCounter,
    nowIso: new Date().toISOString(),
  })
  if (res.resolved === 1) return { ok: true, counterReset: resetCounter }
  return { ok: false, reason: res.reason as 'not_found' | 'already_resolved' }
}
