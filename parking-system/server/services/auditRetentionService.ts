import { randomUUID } from 'node:crypto'
import type { ParkingRepository } from '@/server/repositories/parkingRepository'
import { createParkingRepository } from '@/server/repositories/parkingRepository'

// Wave 2A-3 (#15) — audit_logs retention purge. Delete governance-audit rows older
// than AUDIT_RETENTION_MONTHS (policy: 24), keeping audit.substrate_enabled and
// audit.retention_purge forever. Scheduled-eligible (a monthly cron applies it).
//
// The safety-critical decisions live in the RPC, not here (see 0034):
//   * the clock is the DATABASE's — this service passes NO `now`, so nobody holding
//     the service-role key can push the cutoff into the future and wipe fresh rows;
//   * the 24-month floor is re-enforced in SQL.
// This layer only: reads the env window (fail-safe = keep longer), defaults to dry-run,
// and — because the cron runs only MONTHLY — drains the backlog in a bounded loop so a
// large batch is not stranded for a whole month. Output is counts / timestamps only.

const DEFAULT_RETENTION_MONTHS = 24
const MIN_RETENTION_MONTHS = 24 // == default on purpose: the window may only be LENGTHENED
const DEFAULT_MAX = 200
const HARD_CAP = 500
// A monthly run may face a backlog; drain it across several bounded batches (each its
// own DB transaction, so locks are held only briefly) rather than one batch per month.
const MAX_BATCHES = 20
const MAX_TOTAL = 10_000

export type PurgeAuditLogsSummary =
  | { dryRun: true; wouldPurge: number; deletedBefore: string; retentionMonths: number }
  | { dryRun: false; deletedCount: number; batches: number; hasMore: boolean; deletedBefore: string; retentionMonths: number }

export interface PurgeAuditLogsParams {
  dryRun?: boolean // defaults to true — must pass false to delete
  max?: number     // per-batch bound [1, 500]; defaults to 200
}

// Read the retention window from env. Valid = integer >= 24; anything else
// (unset / non-numeric / too short) falls back to 24 — the fail-safe direction is
// "keep data longer", never "delete earlier because of a typo'd env var".
export function readRetentionMonths(): number {
  const raw = process.env.AUDIT_RETENTION_MONTHS
  if (raw === undefined || raw.trim() === '') return DEFAULT_RETENTION_MONTHS
  const n = Number(raw)
  if (!Number.isInteger(n) || n < MIN_RETENTION_MONTHS) return DEFAULT_RETENTION_MONTHS
  return n
}

export async function purgeAuditLogs(
  params: PurgeAuditLogsParams = {},
  repo: ParkingRepository = createParkingRepository(),
): Promise<PurgeAuditLogsSummary> {
  const { dryRun = true, max } = params
  const effectiveMax = Math.min(max && max > 0 ? Math.trunc(max) : DEFAULT_MAX, HARD_CAP)
  const retentionMonths = readRetentionMonths()

  if (dryRun) {
    // Single read: the RPC returns the TRUE total (count(*)) so the operator sees the
    // real backlog, plus the DB-computed cutoff we cannot recompute here.
    const res = await repo.purgeAuditLogs(retentionMonths, effectiveMax, true, randomUUID())
    return { dryRun: true, wouldPurge: res.count, deletedBefore: res.deletedBefore, retentionMonths: res.retentionMonths }
  }

  // One request id for the whole run, threaded to every batch, so the markers the RPC
  // writes correlate with this invocation.
  const requestId = randomUUID()
  let deletedCount = 0
  let batches = 0
  let hasMore = true
  let deletedBefore = ''
  let months = retentionMonths
  while (hasMore && batches < MAX_BATCHES && deletedCount < MAX_TOTAL) {
    const res = await repo.purgeAuditLogs(retentionMonths, effectiveMax, false, requestId)
    deletedCount += res.count
    batches += 1
    hasMore = res.hasMore
    deletedBefore = res.deletedBefore
    months = res.retentionMonths
    // No progress (nothing matched, or the whole batch was skip-locked by a concurrent
    // run) — stop rather than spin; the next run picks it up.
    if (res.count === 0) break
  }

  return { dryRun: false, deletedCount, batches, hasMore, deletedBefore, retentionMonths: months }
}
