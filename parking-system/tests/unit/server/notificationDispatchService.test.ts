import { describe, expect, it, vi } from 'vitest'
import { makeMockRepo, asRepo, type MockRepo } from './mockRepo'
import { dispatchNotifications, previewDispatch } from '@/server/services/notificationDispatchService'
import {
  NOTIFICATION_DISPATCH_BATCH,
  NOTIFICATION_LEASE_SECONDS,
} from '@/lib/allocation/rules'
import {
  TransportConfigError,
  TransportRetryableError,
  TransportTerminalError,
  type LineTransport,
} from '@/server/services/notification/lineTransport'
import type { ClaimedOutboxRow } from '@/server/repositories/parkingRepository'

const NOW = new Date('2026-06-21T02:00:00Z')
const WORKER = 'worker-1'

function row(over: Partial<ClaimedOutboxRow> = {}): ClaimedOutboxRow {
  return {
    id: 'row-1',
    template_key: 'reservation_approved',
    user_id: 'u1',
    line_id: 'U-line-1',
    payload_json: {},
    retry_count: 0,
    dedupe_key: 'dk-1',
    ...over,
  }
}

// A transport whose push behaviour is scripted per call (rows are processed in order).
function transportWith(behaviour: LineTransport['push']): LineTransport {
  return { push: vi.fn(behaviour) }
}

const okTransport = (): LineTransport => transportWith(async () => {})

function run(rows: ClaimedOutboxRow[], transport: LineTransport, repoOver: Partial<MockRepo> = {}) {
  const repo = makeMockRepo({ claimOutbox: vi.fn(async () => rows), ...repoOver })
  return { repo, promise: dispatchNotifications({ now: NOW, worker: WORKER }, asRepo(repo), transport) }
}

describe('dispatchNotifications', () => {
  it('claims a leased batch with the worker id, batch size, and lease seconds', async () => {
    const { repo } = run([], okTransport())
    await Promise.resolve()
    expect(repo.claimOutbox).toHaveBeenCalledWith(
      WORKER,
      NOW.toISOString(),
      NOTIFICATION_DISPATCH_BATCH,
      NOTIFICATION_LEASE_SECONDS,
    )
  })

  it('sends a deliverable row and marks it sent (worker-guarded)', async () => {
    const { repo, promise } = run([row()], okTransport())
    const summary = await promise
    expect(repo.markOutboxSent).toHaveBeenCalledWith('row-1', WORKER, NOW.toISOString())
    expect(summary).toEqual({ scanned: 1, sent: 1, retried: 0, failed: 0, skippedNoLineId: 0 })
  })

  it('marks a recipient with no line_id failed (no_line_id) and counts skippedNoLineId', async () => {
    const tx = okTransport()
    const { repo, promise } = run([row({ line_id: null })], tx)
    const summary = await promise
    expect(tx.push).not.toHaveBeenCalled()
    expect(repo.markOutboxFailed).toHaveBeenCalledWith('row-1', WORKER, 'no_line_id')
    expect(summary).toMatchObject({ failed: 1, skippedNoLineId: 1, sent: 0 })
  })

  it('marks a row failed (render_error) when its template_key cannot render', async () => {
    const tx = okTransport()
    const { repo, promise } = run([row({ template_key: 'nope' })], tx)
    const summary = await promise
    expect(tx.push).not.toHaveBeenCalled()
    expect(repo.markOutboxFailed).toHaveBeenCalledWith('row-1', WORKER, 'render_error')
    expect(summary).toMatchObject({ failed: 1, skippedNoLineId: 0 })
  })

  it('schedules a retry (backoff) on a retryable transport error', async () => {
    const tx = transportWith(async () => {
      throw new TransportRetryableError('http_500')
    })
    const { repo, promise } = run([row({ retry_count: 0 })], tx)
    const summary = await promise
    // retry_count 0 → backoff[0] = 1 minute
    const expectedNext = new Date(NOW.getTime() + 1 * 60_000).toISOString()
    expect(repo.markOutboxRetry).toHaveBeenCalledWith('row-1', WORKER, expectedNext, 1, 'http_500')
    expect(summary).toMatchObject({ retried: 1, failed: 0, sent: 0 })
  })

  it('gives up (failed) once retries reach NOTIFICATION_MAX_RETRIES', async () => {
    const tx = transportWith(async () => {
      throw new TransportRetryableError('http_503')
    })
    // retry_count 4 → failures 5 >= MAX(5) → terminal failure, no further retry scheduled
    const { repo, promise } = run([row({ retry_count: 4 })], tx)
    const summary = await promise
    expect(repo.markOutboxRetry).not.toHaveBeenCalled()
    expect(repo.markOutboxFailed).toHaveBeenCalledWith('row-1', WORKER, 'http_503')
    expect(summary).toMatchObject({ failed: 1, retried: 0 })
  })

  it('marks a row failed (no retry) on a terminal transport error', async () => {
    const tx = transportWith(async () => {
      throw new TransportTerminalError('terminal_403')
    })
    const { repo, promise } = run([row()], tx)
    const summary = await promise
    expect(repo.markOutboxRetry).not.toHaveBeenCalled()
    expect(repo.markOutboxFailed).toHaveBeenCalledWith('row-1', WORKER, 'terminal_403')
    expect(summary).toMatchObject({ failed: 1 })
  })

  it('isolates rows: one terminal failure does not abort the rest of the batch', async () => {
    const tx = transportWith(async (lineId: string) => {
      if (lineId === 'bad') throw new TransportTerminalError('terminal_400')
    })
    const rows = [row({ id: 'a', line_id: 'bad' }), row({ id: 'b', line_id: 'good' })]
    const { repo, promise } = run(rows, tx)
    const summary = await promise
    expect(repo.markOutboxFailed).toHaveBeenCalledWith('a', WORKER, 'terminal_400')
    expect(repo.markOutboxSent).toHaveBeenCalledWith('b', WORKER, NOW.toISOString())
    expect(summary).toMatchObject({ scanned: 2, sent: 1, failed: 1 })
  })

  it('config error BEFORE claim aborts and mutates nothing (no claim, no marks)', async () => {
    const saved = process.env.NOTIFICATION_TRANSPORT
    delete process.env.NOTIFICATION_TRANSPORT // getLineTransport() will throw
    const repo = makeMockRepo({ claimOutbox: vi.fn(async () => [row()]) })
    // no injected transport → falls through to getLineTransport()
    await expect(dispatchNotifications({ now: NOW, worker: WORKER }, asRepo(repo))).rejects.toBeInstanceOf(
      TransportConfigError,
    )
    expect(repo.claimOutbox).not.toHaveBeenCalled()
    expect(repo.markOutboxSent).not.toHaveBeenCalled()
    expect(repo.markOutboxFailed).not.toHaveBeenCalled()
    if (saved === undefined) delete process.env.NOTIFICATION_TRANSPORT
    else process.env.NOTIFICATION_TRANSPORT = saved
  })

  it('config error mid-batch AFTER claim leaves the claimed row processing (not failed/sent) and aborts', async () => {
    const tx = transportWith(async () => {
      throw new TransportConfigError('http_401')
    })
    const rows = [row({ id: 'a' }), row({ id: 'b' })]
    const { repo, promise } = run(rows, tx)
    await expect(promise).rejects.toBeInstanceOf(TransportConfigError)
    // row 'a' interrupted by a system fault: never marked; row 'b' never attempted
    expect(repo.markOutboxSent).not.toHaveBeenCalled()
    expect(repo.markOutboxFailed).not.toHaveBeenCalled()
    expect(repo.markOutboxRetry).not.toHaveBeenCalled()
    expect((tx.push as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1) // aborted before row 'b'
  })
})

describe('previewDispatch (dryRun — no mutation)', () => {
  const HEALTH = {
    due: 3, due_by_template: { move_car_request: 2, broadcast_release: 1 },
    pending: 5, retrying: 1, processing: 1, stale_processing: 1, failed: 2,
    failed_by_error: { no_line_id: 1, terminal_403: 1 }, sent_last_24h: 9,
    oldest_pending_at: '2026-06-21T01:00:00Z', oldest_due_at: '2026-06-21T01:00:00Z', oldest_failed_at: null, next_retry_at: '2026-06-21T03:00:00Z',
  }

  it('returns the due-preview subset from getOutboxHealth and mutates nothing', async () => {
    const repo = makeMockRepo({ getOutboxHealth: vi.fn(async () => HEALTH) })
    const res = await previewDispatch({ now: NOW, limit: 50 }, asRepo(repo))
    expect(res).toEqual({
      dryRun: true,
      due: 3,
      dueByTemplate: { move_car_request: 2, broadcast_release: 1 },
      staleProcessing: 1,
      batchLimit: 50,
    })
    expect(repo.getOutboxHealth).toHaveBeenCalledWith(NOW.toISOString(), NOTIFICATION_LEASE_SECONDS)
    // never claims, never marks, never sends
    expect(repo.claimOutbox).not.toHaveBeenCalled()
    expect(repo.markOutboxSent).not.toHaveBeenCalled()
    expect(repo.markOutboxRetry).not.toHaveBeenCalled()
    expect(repo.markOutboxFailed).not.toHaveBeenCalled()
  })

  it('defaults batchLimit to NOTIFICATION_DISPATCH_BATCH', async () => {
    const repo = makeMockRepo({ getOutboxHealth: vi.fn(async () => HEALTH) })
    const res = await previewDispatch({ now: NOW }, asRepo(repo))
    expect(res.batchLimit).toBe(NOTIFICATION_DISPATCH_BATCH)
  })

  it('is aggregate-only — never surfaces per-row / sensitive keys', async () => {
    const repo = makeMockRepo({ getOutboxHealth: vi.fn(async () => HEALTH) })
    const res = await previewDispatch({ now: NOW }, asRepo(repo))
    const json = JSON.stringify(res)
    for (const k of ['payload_json', 'user_id', 'reservation_id', 'dedupe_key', 'line_id', 'license_plate', 'phone']) {
      expect(json).not.toContain(k)
    }
  })
})
