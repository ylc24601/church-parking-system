import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildOutboxAlertFromHealth,
  DEFAULT_ALERT_THRESHOLDS,
  evaluateOutboxAlert,
  getOutboxAlert,
  readAlertThresholds,
} from '@/server/services/outboxAlertService'
import { asRepo, makeMockRepo } from './mockRepo'
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
const T = { failedMax: 0, staleMax: 0, pendingStaleMinutes: 15 }

describe('evaluateOutboxAlert', () => {
  it('healthy when nothing breaches', () => {
    expect(evaluateOutboxAlert(health(), T, NOW)).toEqual({ healthy: true, breaches: [] })
  })

  it('failed_over_max: default 0 → any terminal failed row trips', () => {
    const r = evaluateOutboxAlert(health({ failed: 1 }), T, NOW)
    expect(r.healthy).toBe(false)
    expect(r.breaches).toContain('failed_over_max')
  })

  it('stale_processing_over_max: default 0 → any stale lease trips', () => {
    expect(evaluateOutboxAlert(health({ stale_processing: 1 }), T, NOW).breaches)
      .toContain('stale_processing_over_max')
  })

  it('due_backlog_stale when the oldest DUE row is older than the threshold', () => {
    const old = new Date(NOW.getTime() - 20 * 60_000).toISOString() // 20 min > 15
    expect(evaluateOutboxAlert(health({ oldest_due_at: old }), T, NOW).breaches).toContain('due_backlog_stale')
  })

  it('does NOT trip the backlog breach for a recent due row, or when nothing is due', () => {
    const recent = new Date(NOW.getTime() - 5 * 60_000).toISOString()
    expect(evaluateOutboxAlert(health({ oldest_due_at: recent }), T, NOW).breaches).not.toContain('due_backlog_stale')
    expect(evaluateOutboxAlert(health({ oldest_due_at: null }), T, NOW).breaches).not.toContain('due_backlog_stale')
  })

  it('higher thresholds suppress small counts', () => {
    const r = evaluateOutboxAlert(health({ failed: 3, stale_processing: 2 }), { failedMax: 5, staleMax: 5, pendingStaleMinutes: 15 }, NOW)
    expect(r.healthy).toBe(true)
  })
})

describe('readAlertThresholds', () => {
  const saved = { ...process.env }
  afterEach(() => { process.env = { ...saved } })

  it('defaults to 0 / 0 / 15 when unset', () => {
    delete process.env.OUTBOX_ALERT_FAILED_MAX
    delete process.env.OUTBOX_ALERT_STALE_MAX
    delete process.env.OUTBOX_ALERT_PENDING_STALE_MINUTES
    expect(readAlertThresholds()).toEqual(DEFAULT_ALERT_THRESHOLDS)
    expect(DEFAULT_ALERT_THRESHOLDS).toEqual({ failedMax: 0, staleMax: 0, pendingStaleMinutes: 15 })
  })

  it('reads valid integer overrides', () => {
    process.env.OUTBOX_ALERT_FAILED_MAX = '10'
    process.env.OUTBOX_ALERT_STALE_MAX = '3'
    process.env.OUTBOX_ALERT_PENDING_STALE_MINUTES = '30'
    expect(readAlertThresholds()).toEqual({ failedMax: 10, staleMax: 3, pendingStaleMinutes: 30 })
  })

  it('falls back to defaults on non-numeric / negative / blank', () => {
    process.env.OUTBOX_ALERT_FAILED_MAX = 'abc'
    process.env.OUTBOX_ALERT_STALE_MAX = '-1'
    process.env.OUTBOX_ALERT_PENDING_STALE_MINUTES = ''
    expect(readAlertThresholds()).toEqual(DEFAULT_ALERT_THRESHOLDS)
  })
})

describe('buildOutboxAlertFromHealth (no DB read — same snapshot as the counts)', () => {
  it('derives the verdict from a provided health snapshot + thresholds + now', () => {
    const old = new Date(NOW.getTime() - 20 * 60_000).toISOString()
    const h = health({ failed: 2, stale_processing: 1, oldest_due_at: old })
    const alert = buildOutboxAlertFromHealth(h, T, NOW)
    expect(alert.healthy).toBe(false)
    expect(alert.breaches).toEqual(expect.arrayContaining(['failed_over_max', 'stale_processing_over_max', 'due_backlog_stale']))
    // Mirrors the health snapshot exactly (single source of truth for the page).
    expect(alert.failed).toBe(2)
    expect(alert.stale_processing).toBe(1)
    expect(alert.oldest_due_at).toBe(old)
    expect(alert.thresholds).toEqual(T)
  })

  it('the same `now` drives both the stale-age and backlog-age decisions', () => {
    const due14 = new Date(NOW.getTime() - 14 * 60_000).toISOString() // under 15 → healthy
    expect(buildOutboxAlertFromHealth(health({ oldest_due_at: due14 }), T, NOW).healthy).toBe(true)
    const due16 = new Date(NOW.getTime() - 16 * 60_000).toISOString()
    expect(buildOutboxAlertFromHealth(health({ oldest_due_at: due16 }), T, NOW).healthy).toBe(false)
  })
})

describe('getOutboxAlert', () => {
  it('returns an aggregate-only verdict — no per-row / member keys', async () => {
    const repo = makeMockRepo({ getOutboxHealth: vi.fn(async () => health({ failed: 2 })) })
    const res = await getOutboxAlert({ now: NOW }, asRepo(repo))
    expect(res.healthy).toBe(false)
    expect(res.breaches).toContain('failed_over_max')
    expect(res.failed).toBe(2)
    const json = JSON.stringify(res)
    for (const k of ['payload_json', 'user_id', 'reservation_id', 'dedupe_key', 'line_id', 'license_plate', 'phone']) {
      expect(json).not.toContain(k)
    }
  })

  it('reads health exactly ONCE (no double snapshot)', async () => {
    const getHealth = vi.fn(async () => health({ failed: 1 }))
    const repo = makeMockRepo({ getOutboxHealth: getHealth })
    await getOutboxAlert({ now: NOW }, asRepo(repo))
    expect(getHealth).toHaveBeenCalledTimes(1)
  })
})
