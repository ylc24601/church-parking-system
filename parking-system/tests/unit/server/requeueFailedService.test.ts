import { describe, expect, it, vi } from 'vitest'
import { asRepo, makeMockRepo } from './mockRepo'
import { requeueFailed } from '@/server/services/requeueFailedService'
import type { OutboxHealth } from '@/server/repositories/parkingRepository'

const NOW = new Date('2026-06-21T02:00:00Z')

function health(over: Partial<OutboxHealth> = {}): OutboxHealth {
  return {
    due: 0, due_by_template: {}, pending: 0, retrying: 0, processing: 0, stale_processing: 0,
    failed: 0, failed_by_error: {}, sent_last_24h: 0,
    oldest_pending_at: null, oldest_due_at: null, oldest_failed_at: null, next_retry_at: null,
    ...over,
  }
}

describe('requeueFailed', () => {
  it('defaults to dryRun: reads health for wouldRequeue and NEVER calls the RPC', async () => {
    const repo = makeMockRepo({ getOutboxHealth: vi.fn(async () => health({ failed: 8 })) })
    const res = await requeueFailed({ now: NOW }, asRepo(repo))
    expect(res).toEqual({ dryRun: true, wouldRequeue: 8 })
    expect(repo.requeueFailedOutbox).not.toHaveBeenCalled()
  })

  it('dryRun caps wouldRequeue at the effective max (default 50)', async () => {
    const repo = makeMockRepo({ getOutboxHealth: vi.fn(async () => health({ failed: 200 })) })
    const res = await requeueFailed({ now: NOW }, asRepo(repo))
    expect(res).toEqual({ dryRun: true, wouldRequeue: 50 })
  })

  it('dryRun with an errorCode filters via failed_by_error', async () => {
    const repo = makeMockRepo({
      getOutboxHealth: vi.fn(async () => health({ failed: 5, failed_by_error: { terminal_403: 2, no_line_id: 3 } })),
    })
    const res = await requeueFailed({ now: NOW, errorCode: 'terminal_403' }, asRepo(repo))
    expect(res).toEqual({ dryRun: true, wouldRequeue: 2 })
  })

  it('apply (dryRun:false) calls the RPC with the bounded max + trimmed code', async () => {
    const repo = makeMockRepo({ requeueFailedOutbox: vi.fn(async () => ({ requeued: 3 })) })
    const res = await requeueFailed({ now: NOW, dryRun: false, max: 3, errorCode: '  terminal_403  ' }, asRepo(repo))
    expect(res).toEqual({ dryRun: false, requeued: 3 })
    expect(repo.requeueFailedOutbox).toHaveBeenCalledWith(NOW.toISOString(), 3, 'terminal_403')
  })

  it('apply hard-caps max at 500 and normalizes a blank errorCode to null', async () => {
    const repo = makeMockRepo({ requeueFailedOutbox: vi.fn(async () => ({ requeued: 0 })) })
    await requeueFailed({ now: NOW, dryRun: false, max: 99_999, errorCode: '   ' }, asRepo(repo))
    expect(repo.requeueFailedOutbox).toHaveBeenCalledWith(NOW.toISOString(), 500, null)
  })

  it('apply uses the default max 50 when none supplied', async () => {
    const repo = makeMockRepo({ requeueFailedOutbox: vi.fn(async () => ({ requeued: 0 })) })
    await requeueFailed({ now: NOW, dryRun: false }, asRepo(repo))
    expect(repo.requeueFailedOutbox).toHaveBeenCalledWith(NOW.toISOString(), 50, null)
  })
})
