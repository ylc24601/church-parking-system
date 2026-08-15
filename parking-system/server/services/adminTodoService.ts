import { cache } from 'react'
import { can, type AdminRole } from '@/lib/adminRoles'
import { deriveEligibilityStatus } from '@/lib/eligibilityStatus'
import { taipeiToday } from '@/lib/taipeiDate'
import type { AdminTodoCounts, AdminTodoSnapshot, NotificationHealth } from '@/lib/adminTodoTypes'
import {
  createParkingRepository,
  type EligibilityTodoCandidate,
  type ParkingRepository,
} from '@/server/repositories/parkingRepository'
import { getOutboxHealth } from '@/server/services/outboxHealthService'
import { buildOutboxAlertFromHealth, readAlertThresholds } from '@/server/services/outboxAlertService'

// ── Admin overview / sidebar todo counts (Wave 3 / #8 + #9) ──────────────────
// One snapshot drives both the /admin dashboard "下待辦" list and the sidebar
// badges. business semantics live HERE, not in the client (triage: "不硬 RPC").

// Per-request clock, memoized so the layout and the /admin page agree on "now"
// (and therefore on today / this Sunday / the alert age / the snapshot time).
// React cache() is scoped to a single Server Component render request and cleared
// after it — this is the same "one snapshot + one now" discipline the ops page uses.
export const getAdminRequestNow = cache((): Date => new Date())

// P2 "needs a human today" = expired + review_due, decided by the AUTHORITATIVE
// classifier (deriveEligibilityStatus) — the repo's SQL filter is only a superset that
// narrows candidates, never a second source of truth. This is an EXACT count over minimal
// columns (no display cap, no names/reasons pulled), unlike the list-page query.
export function p2ReviewCount(candidates: EligibilityTodoCandidate[], today: string): number {
  let n = 0
  for (const c of candidates) {
    const status = deriveEligibilityStatus(
      { validUntil: c.p2_valid_until, reviewDate: c.p2_review_date, validFrom: c.p2_valid_from },
      today,
    )
    if (status === 'expired' || status === 'review_due') n += 1
  }
  return n
}

export async function computeAdminTodoCounts(
  params: { now: Date; role: AdminRole },
  repo: ParkingRepository = createParkingRepository(),
): Promise<AdminTodoCounts> {
  const { now, role } = params
  const today = taipeiToday(now)

  // Fetch core todos AND notification health in ONE parallel batch. Health is wrapped so
  // its rejection resolves to a sentinel rather than rejecting the whole batch: a health
  // outage must NOT take down the core todos (the primary reason to render the overview),
  // while a core (P2/pastoral) rejection still propagates → fails the whole snapshot.
  // getOutboxHealth MUST receive the same repo — a default would build a real service-role
  // client and break unit tests that inject a mock.
  const [p2Review, pastoralOpen, healthResult] = await Promise.all([
    repo.listEligibilityTodoCandidates(today).then(rows => p2ReviewCount(rows, today)),
    repo.countOpenPastoralAlerts(),
    getOutboxHealth({ now }, repo).then(
      health => ({ ok: true as const, health }),
      () => ({ ok: false as const }),
    ),
  ])

  let notificationHealth: NotificationHealth = 'unavailable'
  let ops: AdminTodoCounts['ops'] = null
  if (healthResult.ok) {
    const health = healthResult.health
    const alert = buildOutboxAlertFromHealth(health, readAlertThresholds(), now)
    notificationHealth = alert.healthy ? 'healthy' : 'attention'

    // Technical ops data is only for view_ops (superadmin); a clerk gets the plain verdict
    // above but never the raw counts (they don't reach the clerk's client).
    if (can(role, 'view_ops')) {
      // A due backlog that has aged past the threshold is itself a breach even with
      // failed=0 / stale=0 — so fold it into attention. Gate the whole sum by `healthy`
      // so the badge lights EXACTLY when the ops page shows 異常 (raising a threshold
      // could otherwise leave failed>0 while healthy stays true, and the two would disagree).
      const staleBacklog = alert.breaches.includes('due_backlog_stale') ? health.due : 0
      const attention = alert.healthy ? 0 : health.failed + health.stale_processing + staleBacklog
      // backlog = rows due to send now (informational "通知待送"); attention drives the badge.
      ops = { backlog: health.due, attention }
    }
  } else {
    // Only the health query failed — keep the core todos, report the verdict as
    // 'unavailable' (never fail-open to 'healthy'), and light no ops data. Fixed PII-free
    // code, no error object / query data.
    console.error('admin_notification_health_failed')
  }

  return { p2Review, pastoralOpen, notificationHealth, ops }
}

// Fail-soft wrapper for the admin shell. The layout renders on EVERY /admin page, so
// a thrown count query must not 500 the whole back-office — badges are auxiliary.
// On failure: log a fixed, PII-free code (no error object, no request data) and return
// counts:null. A null snapshot means "couldn't fetch", never "all zero" — the sidebar
// shows no badges and the overview says so explicitly instead of a false 🎉.
export async function getAdminTodoSnapshot(
  role: AdminRole,
  repo: ParkingRepository = createParkingRepository(),
  // Defaults to the shared per-request clock (only evaluated when omitted, i.e. in the
  // RSC render); tests pass a fixed Date so they never touch React cache().
  now: Date = getAdminRequestNow(),
): Promise<AdminTodoSnapshot> {
  try {
    const counts = await computeAdminTodoCounts({ now, role }, repo)
    return { counts, snapshotAt: now.toISOString() }
  } catch {
    console.error('admin_todo_snapshot_failed')
    return { counts: null, snapshotAt: now.toISOString() }
  }
}
