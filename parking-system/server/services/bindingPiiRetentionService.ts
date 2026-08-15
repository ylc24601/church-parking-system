import type { ParkingRepository } from '@/server/repositories/parkingRepository'
import { createParkingRepository } from '@/server/repositories/parkingRepository'

// Phase 8 Slice 7 — binding PII retention (binding-ops.md「PII 保留」): clear
// claimed_phone / claimed_name / submitted_code on pending_binding rows decided
// (approved/rejected) at least BINDING_PII_RETENTION_DAYS ago, keeping claim_source,
// timestamps, status, approved_user_id, rejected_reason and decided_by_admin_id.
// Scheduled-eligible (unlike requeueFailed) — PII must not linger because nobody
// remembered to run a CLI. Conservative:
//   * dryRun defaults to true at THIS layer (fail-safe floor); only the GET
//     scheduler entry point explicitly passes false.
//   * the retention window is env-only — no caller-supplied override, so nobody
//     holding the job secret can shorten it to wipe fresh audit data early. The
//     RPC re-enforces the same >= 30 floor.
//   * `now` exists for tests and for the route to pass server current time; it is
//     never exposed as an HTTP/CLI parameter (an arbitrary future `now` would be
//     an equivalent bypass of the window).
// Output is counts / timestamps only — never the claim values or line_user_id.

const DEFAULT_RETENTION_DAYS = 90
const MIN_RETENTION_DAYS = 30
const DEFAULT_MAX = 200
const HARD_CAP = 500

export type RedactBindingPiiSummary =
  | { dryRun: true; wouldRedact: number; hasMore: boolean; retentionDays: number; cutoff: string }
  | { dryRun: false; redacted: number; retentionDays: number; cutoff: string }

export interface RedactBindingPiiParams {
  now?: Date
  dryRun?: boolean       // defaults to true — must pass false to mutate
  max?: number           // bounded to [1, 500]; defaults to 200
}

// Read the retention window from env. Valid = integer >= 30; anything else
// (unset / non-numeric / too short) falls back to 90 — the fail-safe direction is
// "keep data longer", never "delete earlier because of a typo'd env var".
export function readRetentionDays(): number {
  const raw = process.env.BINDING_PII_RETENTION_DAYS
  if (raw === undefined || raw.trim() === '') return DEFAULT_RETENTION_DAYS
  const n = Number(raw)
  if (!Number.isInteger(n) || n < MIN_RETENTION_DAYS) return DEFAULT_RETENTION_DAYS
  return n
}

export async function redactBindingPii(
  params: RedactBindingPiiParams = {},
  repo: ParkingRepository = createParkingRepository(),
): Promise<RedactBindingPiiSummary> {
  const { now = new Date(), dryRun = true, max } = params
  // Bound the batch: default 200, hard cap 500 (a positive-integer `max` is validated at the route;
  // the clamp here covers any other caller).
  const effectiveMax = Math.min(max && max > 0 ? Math.trunc(max) : DEFAULT_MAX, HARD_CAP)
  const retentionDays = readRetentionDays()
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString()

  const res = await repo.redactDecidedBindingPii(now.toISOString(), retentionDays, effectiveMax, dryRun)
  if (dryRun) {
    // wouldRedact is THIS batch's size (capped at max); hasMore flags a backlog
    // beyond one batch — with a daily schedule a large backlog drains over days.
    return { dryRun: true, wouldRedact: res.count, hasMore: res.hasMore, retentionDays, cutoff }
  }
  return { dryRun: false, redacted: res.count, retentionDays, cutoff }
}
