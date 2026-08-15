import { afterEach, describe, expect, it, vi } from 'vitest'
import { readRetentionDays, redactBindingPii } from '@/server/services/bindingPiiRetentionService'
import { asRepo, makeMockRepo } from './mockRepo'

const NOW = new Date('2026-07-13T02:00:00Z')

describe('readRetentionDays', () => {
  const saved = { ...process.env }
  afterEach(() => { process.env = { ...saved } })

  it('defaults to 90 when unset / blank', () => {
    delete process.env.BINDING_PII_RETENTION_DAYS
    expect(readRetentionDays()).toBe(90)
    process.env.BINDING_PII_RETENTION_DAYS = '  '
    expect(readRetentionDays()).toBe(90)
  })

  it('reads a valid integer >= 30', () => {
    process.env.BINDING_PII_RETENTION_DAYS = '120'
    expect(readRetentionDays()).toBe(120)
    process.env.BINDING_PII_RETENTION_DAYS = '30'
    expect(readRetentionDays()).toBe(30)
  })

  it('below the 30-day floor / non-numeric / negative → fallback 90 (never shorter by typo)', () => {
    for (const bad of ['29', '1', '0', '-5', 'abc', '90.5']) {
      process.env.BINDING_PII_RETENTION_DAYS = bad
      expect(readRetentionDays()).toBe(90)
    }
  })
})

describe('redactBindingPii', () => {
  const saved = { ...process.env }
  afterEach(() => { process.env = { ...saved } })

  it('dryRun DEFAULTS to true — the repo is called with dryRun:true unless explicitly false', async () => {
    const repo = makeMockRepo()
    await redactBindingPii({ now: NOW }, asRepo(repo))
    expect(repo.redactDecidedBindingPii).toHaveBeenCalledWith(NOW.toISOString(), 90, 200, true)
  })

  it('explicit dryRun:false applies', async () => {
    const repo = makeMockRepo({ redactDecidedBindingPii: vi.fn(async () => ({ count: 3, hasMore: false })) })
    const res = await redactBindingPii({ now: NOW, dryRun: false }, asRepo(repo))
    expect(repo.redactDecidedBindingPii).toHaveBeenCalledWith(NOW.toISOString(), 90, 200, false)
    expect(res).toEqual({ dryRun: false, redacted: 3, retentionDays: 90, cutoff: '2026-04-14T02:00:00.000Z' })
  })

  it('max: default 200, hard cap 500, truncated', async () => {
    const repo = makeMockRepo()
    await redactBindingPii({ now: NOW, max: 9999 }, asRepo(repo))
    expect(repo.redactDecidedBindingPii).toHaveBeenLastCalledWith(NOW.toISOString(), 90, 500, true)
    await redactBindingPii({ now: NOW, max: 10.9 }, asRepo(repo))
    expect(repo.redactDecidedBindingPii).toHaveBeenLastCalledWith(NOW.toISOString(), 90, 10, true)
  })

  it('uses the env retention window and derives cutoff from the SAME now', async () => {
    process.env.BINDING_PII_RETENTION_DAYS = '120'
    const repo = makeMockRepo({ redactDecidedBindingPii: vi.fn(async () => ({ count: 1, hasMore: false })) })
    const res = await redactBindingPii({ now: NOW }, asRepo(repo))
    expect(repo.redactDecidedBindingPii).toHaveBeenCalledWith(NOW.toISOString(), 120, 200, true)
    expect(res.retentionDays).toBe(120)
    expect(res.cutoff).toBe(new Date(NOW.getTime() - 120 * 86_400_000).toISOString())
  })

  it('dry-run summary passes hasMore through (backlog beyond this batch)', async () => {
    const repo = makeMockRepo({ redactDecidedBindingPii: vi.fn(async () => ({ count: 200, hasMore: true })) })
    const res = await redactBindingPii({ now: NOW, dryRun: true }, asRepo(repo))
    expect(res).toEqual({ dryRun: true, wouldRedact: 200, hasMore: true, retentionDays: 90, cutoff: expect.any(String) })
  })

  it('summary is operation-safe — no claim values / PII keys ever', async () => {
    const repo = makeMockRepo({ redactDecidedBindingPii: vi.fn(async () => ({ count: 2, hasMore: false })) })
    for (const dryRun of [true, false]) {
      const json = JSON.stringify(await redactBindingPii({ now: NOW, dryRun }, asRepo(repo)))
      for (const k of ['claimed_phone', 'claimed_name', 'submitted_code', 'line_user_id', 'phone', 'user_id']) {
        expect(json).not.toContain(k)
      }
    }
  })
})
