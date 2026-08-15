import { randomUUID } from 'node:crypto'
import {
  NOTIFICATION_DISPATCH_BATCH,
  NOTIFICATION_LEASE_SECONDS,
  NOTIFICATION_MAX_RETRIES,
  NOTIFICATION_RETRY_BACKOFF_MINUTES,
} from '@/lib/allocation/rules'
import {
  createParkingRepository,
  type ClaimedOutboxRow,
  type ParkingRepository,
} from '@/server/repositories/parkingRepository'
import { renderTemplate } from './notification/templates'
import {
  deriveRetryKey,
  getLineTransport,
  TransportConfigError,
  TransportRetryableError,
  TransportTerminalError,
  type LineTransport,
} from './notification/lineTransport'

// Phase 4 Slice A — drain due notification_outbox rows to LINE.
//
// Flow: resolve transport (config error → abort before touching anything) → atomically CLAIM
// a leased batch → per-row: resolve line_id, render, push, transition sent / retrying / failed.
// Per-row isolation mirrors autoFinalizeService: one row's terminal/retryable error never
// aborts the batch. A TransportConfigError mid-batch (a SYSTEM fault, e.g. LINE 401) is the
// one exception — it aborts and leaves already-claimed-but-unsent rows 'processing' (NOT
// failed); lease expiry re-claims them once config is fixed, so nothing is lost or false-sent.
//
// Operation-safe: the summary is counts only — never line_id, message text, or member detail.

export interface DispatchSummary {
  scanned: number          // rows claimed this run
  sent: number
  retried: number
  failed: number
  skippedNoLineId: number  // subset of `failed`: undeliverable (recipient has no LINE binding)
}

function backoffMinutes(retryCount: number): number {
  const arr = NOTIFICATION_RETRY_BACKOFF_MINUTES
  return arr[Math.min(retryCount, arr.length - 1)]
}

export async function dispatchNotifications(
  params: { now?: Date; limit?: number; worker?: string } = {},
  repo: ParkingRepository = createParkingRepository(),
  transport?: LineTransport,
): Promise<DispatchSummary> {
  // Resolve the transport FIRST. A config error here (NOTIFICATION_TRANSPORT unset/invalid, or
  // 'line' with no token) aborts before any claim/mutation → a misconfigured run marks nothing.
  const tx = transport ?? getLineTransport()

  const now = params.now ?? new Date()
  const nowIso = now.toISOString()
  const limit = params.limit ?? NOTIFICATION_DISPATCH_BATCH
  const worker = params.worker ?? randomUUID()

  const rows = await repo.claimOutbox(worker, nowIso, limit, NOTIFICATION_LEASE_SECONDS)
  const summary: DispatchSummary = { scanned: rows.length, sent: 0, retried: 0, failed: 0, skippedNoLineId: 0 }

  for (const row of rows) {
    // dispatchRow handles row-level outcomes itself; it rethrows ONLY a TransportConfigError,
    // which we let propagate to abort the batch (leaving remaining claimed rows 'processing').
    await dispatchRow(row, worker, now, tx, repo, summary)
  }
  return summary
}

// Phase 4 Slice C — no-mutation dispatch preview. Reads the operation-safe outbox_health
// aggregate and returns the "what a real run would attempt" subset. It NEVER resolves the
// transport and NEVER claims/mutates — a separate function so no mutation path is reachable.
export interface DispatchPreview {
  dryRun: true
  due: number
  dueByTemplate: Record<string, number>
  staleProcessing: number
  batchLimit: number
}

export async function previewDispatch(
  params: { now?: Date; limit?: number } = {},
  repo: ParkingRepository = createParkingRepository(),
): Promise<DispatchPreview> {
  const now = params.now ?? new Date()
  const batchLimit = params.limit ?? NOTIFICATION_DISPATCH_BATCH
  const health = await repo.getOutboxHealth(now.toISOString(), NOTIFICATION_LEASE_SECONDS)
  return {
    dryRun: true,
    due: health.due,
    dueByTemplate: health.due_by_template,
    staleProcessing: health.stale_processing,
    batchLimit,
  }
}

async function dispatchRow(
  row: ClaimedOutboxRow,
  worker: string,
  now: Date,
  tx: LineTransport,
  repo: ParkingRepository,
  summary: DispatchSummary,
): Promise<void> {
  // Undeliverable: recipient has no LINE binding (hasn't joined the OA). Retrying can't fix it.
  if (!row.line_id) {
    await repo.markOutboxFailed(row.id, worker, 'no_line_id')
    summary.failed++
    summary.skippedNoLineId++
    return
  }

  let text: string
  try {
    text = renderTemplate(row.template_key, row.payload_json)
  } catch {
    await repo.markOutboxFailed(row.id, worker, 'render_error')
    summary.failed++
    return
  }

  try {
    await tx.push(row.line_id, text, { retryKey: deriveRetryKey(row.dedupe_key) })
  } catch (err) {
    if (err instanceof TransportConfigError) throw err // abort batch, do NOT touch this row

    if (err instanceof TransportRetryableError) {
      const failures = row.retry_count + 1
      if (failures >= NOTIFICATION_MAX_RETRIES) {
        await repo.markOutboxFailed(row.id, worker, err.code)
        summary.failed++
      } else {
        const nextRetryAt = new Date(now.getTime() + backoffMinutes(row.retry_count) * 60_000).toISOString()
        await repo.markOutboxRetry(row.id, worker, nextRetryAt, failures, err.code)
        summary.retried++
      }
      return
    }

    // TransportTerminalError, or any other unexpected throw from push → terminal, no retry.
    const code = err instanceof TransportTerminalError ? err.code : 'push_error'
    await repo.markOutboxFailed(row.id, worker, code)
    summary.failed++
    return
  }

  await repo.markOutboxSent(row.id, worker, now.toISOString())
  summary.sent++
}
