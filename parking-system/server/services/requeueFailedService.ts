import type { ParkingRepository } from '@/server/repositories/parkingRepository'
import { createParkingRepository } from '@/server/repositories/parkingRepository'
import { getOutboxHealth } from './outboxHealthService'

// Phase 4 Slice F — dead-letter recovery: requeue terminal `failed` outbox rows back to `pending`
// for a fresh delivery attempt, AFTER the root cause (token/config/provider) is fixed. Conservative:
//   * MANUAL-ONLY — must never be scheduled.
//   * dryRun defaults to true; a real mutation requires an explicit dryRun:false.
//   * only failed → pending (enforced in the RPC); bounded batch; optional sanitized error filter.
// Output is counts-only / operation-safe.

const DEFAULT_MAX = 50
const HARD_CAP = 500

export type RequeueFailedSummary =
  | { dryRun: true; wouldRequeue: number }
  | { dryRun: false; requeued: number }

export interface RequeueFailedParams {
  now?: Date
  dryRun?: boolean       // defaults to true — must pass false to mutate
  max?: number           // bounded to [1, 500]; defaults to 50
  errorCode?: string | null
}

export async function requeueFailed(
  params: RequeueFailedParams = {},
  repo: ParkingRepository = createParkingRepository(),
): Promise<RequeueFailedSummary> {
  const { now = new Date(), dryRun = true, max, errorCode } = params
  // Bound the batch: default 50, hard cap 500 (a positive-integer `max` is validated at the route).
  const effectiveMax = Math.min(max && max > 0 ? Math.trunc(max) : DEFAULT_MAX, HARD_CAP)
  // Blank / whitespace error filter → null (all failed). Only ever matched against stored sanitized codes.
  const code = typeof errorCode === 'string' && errorCode.trim() !== '' ? errorCode.trim() : null

  if (dryRun) {
    // Reuse the health aggregate — no separate read, no mutation.
    const health = await getOutboxHealth({ now }, repo)
    const failedForFilter = code ? health.failed_by_error[code] ?? 0 : health.failed
    return { dryRun: true, wouldRequeue: Math.min(effectiveMax, failedForFilter) }
  }

  const res = await repo.requeueFailedOutbox(now.toISOString(), effectiveMax, code)
  return { dryRun: false, requeued: res.requeued }
}
