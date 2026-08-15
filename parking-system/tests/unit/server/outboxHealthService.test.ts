import { describe, expect, it, vi } from 'vitest'
import { makeMockRepo, asRepo } from './mockRepo'
import { getOutboxHealth } from '@/server/services/outboxHealthService'
import { NOTIFICATION_LEASE_SECONDS } from '@/lib/allocation/rules'

const NOW = new Date('2026-06-21T02:00:00Z')

describe('getOutboxHealth', () => {
  it('calls the repo RPC with the ISO now + dispatcher lease and returns it', async () => {
    const health = {
      due: 1, due_by_template: { move_car_request: 1 }, pending: 1, retrying: 0, processing: 0,
      stale_processing: 0, failed: 0, failed_by_error: {}, sent_last_24h: 0,
      oldest_pending_at: null, oldest_due_at: null, oldest_failed_at: null, next_retry_at: null,
    }
    const repo = makeMockRepo({ getOutboxHealth: vi.fn(async () => health) })
    const res = await getOutboxHealth({ now: NOW }, asRepo(repo))
    expect(res).toBe(health)
    expect(repo.getOutboxHealth).toHaveBeenCalledWith(NOW.toISOString(), NOTIFICATION_LEASE_SECONDS)
  })
})
