import { describe, expect, it, vi } from 'vitest'
import { listPastoralAlerts, resolvePastoralAlert } from '@/server/services/pastoralAlertService'
import { asRepo, makeMockRepo } from './mockRepo'
import type { PastoralAlertRow } from '@/server/repositories/parkingRepository'

const ALERT_ID = '11111111-2222-3333-4444-555555555555'
const ADMIN_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

function alertRow(over: Partial<PastoralAlertRow> = {}): PastoralAlertRow {
  return {
    id: ALERT_ID,
    user_id: 'user-1',
    display_name: '王小明',
    reason: 'consecutive_no_show',
    trigger_count: 4,
    sunday_date: '2026-06-21',
    status: 'open',
    created_at: '2026-06-21T05:00:00Z',
    resolved_at: null,
    resolved_by_username: null,
    counter_reset: false,
    note: null,
    ...over,
  }
}

describe('listPastoralAlerts', () => {
  it('pairs open alerts with the CURRENT counter; a missing user_penalties row → null (alert still listed)', async () => {
    const repo = makeMockRepo({
      listPastoralAlerts: vi.fn(async (status: string) =>
        status === 'open'
          ? [alertRow(), alertRow({ id: 'a2', user_id: 'user-2', display_name: '李四' })]
          : []),
      getPenaltyCountersForUsers: vi.fn(async () => [
        { user_id: 'user-1', penalty_score: 0, consecutive_no_show: 5, last_successful_attended_at: null },
        // user-2 has NO penalty row
      ]),
    })
    const res = await listPastoralAlerts({}, asRepo(repo))
    expect(res.open).toHaveLength(2)
    expect(res.open[0].currentConsecutiveNoShow).toBe(5)
    expect(res.open[1].currentConsecutiveNoShow).toBeNull()
    expect(res.openHasMore).toBe(false)
  })

  it('open and resolved hasMore are computed independently (limit+1 each)', async () => {
    const repo = makeMockRepo({
      listPastoralAlerts: vi.fn(async (status: string, limit: number) =>
        status === 'open'
          ? Array.from({ length: limit }, (_, i) => alertRow({ id: `o${i}`, user_id: `u${i}` }))
          : [alertRow({ id: 'r1', status: 'resolved', resolved_at: '2026-06-22T00:00:00Z' })]),
      getPenaltyCountersForUsers: vi.fn(async () => []),
    })
    const res = await listPastoralAlerts({}, asRepo(repo))
    expect(res.open).toHaveLength(100) // limit 100, repo returned 101
    expect(res.openHasMore).toBe(true)
    expect(res.recentResolved).toHaveLength(1)
    expect(res.resolvedHasMore).toBe(false)
  })

  it('DTO is name+counts+dates only — no phone / line_id / plate keys anywhere', async () => {
    const repo = makeMockRepo({
      listPastoralAlerts: vi.fn(async (status: string) =>
        status === 'open'
          ? [alertRow()]
          : [alertRow({ id: 'r1', status: 'resolved', resolved_at: '2026-06-22T00:00:00Z', resolved_by_username: 'alice', note: '已聯繫' })]),
      getPenaltyCountersForUsers: vi.fn(async () => []),
    })
    const json = JSON.stringify(await listPastoralAlerts({}, asRepo(repo)))
    for (const k of ['phone', 'line_id', 'line_user_id', 'license_plate', 'plate', 'penalty_score']) {
      expect(json).not.toContain(k)
    }
  })
})

describe('resolvePastoralAlert', () => {
  it('passes the session adminId + server now through; resetCounter defaults to false', async () => {
    const repo = makeMockRepo()
    const res = await resolvePastoralAlert({ alertId: ALERT_ID, adminId: ADMIN_ID }, asRepo(repo))
    expect(res).toEqual({ ok: true, counterReset: false })
    expect(repo.resolvePastoralAlert).toHaveBeenCalledWith({
      alertId: ALERT_ID,
      adminId: ADMIN_ID,
      note: null,
      resetCounter: false,
      nowIso: expect.any(String),
    })
  })

  it('note: trimmed-empty → null; 200 code points pass; 201 rejected (emoji/CJK count as 1)', async () => {
    const repo = makeMockRepo()
    await resolvePastoralAlert({ alertId: ALERT_ID, adminId: ADMIN_ID, note: '   ' }, asRepo(repo))
    expect((repo.resolvePastoralAlert as ReturnType<typeof vi.fn>).mock.calls[0][0].note).toBeNull()

    const twoHundred = '安'.repeat(198) + '🙏🙏' // 200 code points
    await resolvePastoralAlert({ alertId: ALERT_ID, adminId: ADMIN_ID, note: twoHundred }, asRepo(repo))
    expect((repo.resolvePastoralAlert as ReturnType<typeof vi.fn>).mock.calls[1][0].note).toBe(twoHundred)

    await expect(resolvePastoralAlert({ alertId: ALERT_ID, adminId: ADMIN_ID, note: '安'.repeat(201) }, asRepo(repo)))
      .rejects.toThrow('note too long')
  })

  it('invalid alertId rejected before any repo call', async () => {
    const repo = makeMockRepo()
    await expect(resolvePastoralAlert({ alertId: 'not-a-uuid', adminId: ADMIN_ID }, asRepo(repo)))
      .rejects.toThrow('invalid alertId')
    expect(repo.resolvePastoralAlert).not.toHaveBeenCalled()
  })

  it('typed RPC outcomes pass through as ok:false', async () => {
    const repo = makeMockRepo({
      resolvePastoralAlert: vi.fn(async () => ({ resolved: 0, reason: 'already_resolved' })),
    })
    expect(await resolvePastoralAlert({ alertId: ALERT_ID, adminId: ADMIN_ID }, asRepo(repo)))
      .toEqual({ ok: false, reason: 'already_resolved' })
  })
})
