import { describe, expect, it, vi } from 'vitest'
import { makeMockRepo, asRepo } from './mockRepo'
import { exportMembersCsv, formatPhoneForExport } from '@/server/services/memberExportService'
import type { AuditActor } from '@/server/services/auditContext'
import type { MemberExportRow } from '@/server/repositories/parkingRepository'

const actor: AuditActor = { actorType: 'admin', actorId: 'admin-1', actorSessionId: 'sess-1', actorRoleSnapshot: null }
const NOW = new Date('2026-07-26T15:00:00Z')

const row = (over: Partial<MemberExportRow> = {}): MemberExportRow => ({
  id: '11111111-1111-4111-8111-111111111111',
  display_name: '王小明',
  phone_number: '0912345678',
  role: 'user',
  line_id: 'U123',
  created_at: '2026-01-01T00:00:00.000000+00:00',
  plates: ['ABC-1234', 'DEF-5678'],
  ...over,
})

describe('formatPhoneForExport', () => {
  it('dash-groups a canonical mobile so Excel keeps the leading 0', () => {
    expect(formatPhoneForExport('0912345678')).toBe('0912-345-678')
  })
  it('null → empty cell', () => {
    expect(formatPhoneForExport(null)).toBe('')
  })
  it('leaves a non-canonical value unchanged (defensive; DB constraint prevents these)', () => {
    expect(formatPhoneForExport('123')).toBe('123')
  })
})

describe('exportMembersCsv', () => {
  it('superadmin → CSV of the minimal fields (full phone, joined active plates, 中文 role, 是/否), then audited', async () => {
    const repo = makeMockRepo({ listMembersForExportPage: vi.fn(async () => [row()]) })
    const res = await exportMembersCsv({ role: 'superadmin', actor, requestId: 'req-1', now: NOW }, asRepo(repo))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.filename).toBe('members-20260726.csv')
    expect(res.rowCount).toBe(1)
    expect(res.csv.charCodeAt(0)).toBe(0xfeff) // BOM
    expect(res.csv).toContain('姓名,電話,車牌,角色,LINE綁定\r\n')
    // Phone is dash-grouped so Excel keeps the leading 0 (see formatPhoneForExport).
    expect(res.csv).toContain('王小明,0912-345-678,ABC-1234；DEF-5678,會友,是')
    // No sensitive-eligibility columns are even representable (rows never carry them).
    expect(res.csv).not.toContain('事由')
    expect(repo.logMemberRosterExport).toHaveBeenCalledWith(
      expect.objectContaining({ actingAdminId: 'admin-1', actingSessionId: 'sess-1', requestId: 'req-1', rowCount: 1 }),
    )
  })

  it('clerk → forbidden WITHOUT reading the roster or auditing', async () => {
    const repo = makeMockRepo({ listMembersForExportPage: vi.fn(async () => [row()]) })
    const res = await exportMembersCsv({ role: 'clerk', actor, requestId: 'req-1', now: NOW }, asRepo(repo))
    expect(res).toEqual({ ok: false, reason: 'forbidden' })
    expect(repo.listMembersForExportPage).not.toHaveBeenCalled()
    expect(repo.logMemberRosterExport).not.toHaveBeenCalled()
  })

  it('non-admin actor → throws (bulk-PII boundary distrusts the plain actor); roster/audit untouched', async () => {
    const repo = makeMockRepo({ listMembersForExportPage: vi.fn(async () => [row()]) })
    const memberActor: AuditActor = { actorType: 'member', actorId: 'm-1', actorSessionId: 's-1', actorRoleSnapshot: null }
    await expect(
      exportMembersCsv({ role: 'superadmin', actor: memberActor, requestId: 'req-1', now: NOW }, asRepo(repo)),
    ).rejects.toThrow()
    expect(repo.listMembersForExportPage).not.toHaveBeenCalled()
    expect(repo.logMemberRosterExport).not.toHaveBeenCalled()
  })

  it('DB reauth forbidden (demoted mid-request) → typed forbidden, no CSV', async () => {
    const repo = makeMockRepo({
      listMembersForExportPage: vi.fn(async () => [row()]),
      logMemberRosterExport: vi.fn(async () => ({ ok: false, reason: 'forbidden_role' })),
    })
    const res = await exportMembersCsv({ role: 'superadmin', actor, requestId: 'req-1', now: NOW }, asRepo(repo))
    expect(res).toEqual({ ok: false, reason: 'forbidden' })
  })

  it('null phone / no plates / unbound → empty cells + 否', async () => {
    const repo = makeMockRepo({
      listMembersForExportPage: vi.fn(async () => [row({ phone_number: null, line_id: null, plates: [] })]),
    })
    const res = await exportMembersCsv({ role: 'superadmin', actor, requestId: 'req-1', now: NOW }, asRepo(repo))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.csv).toContain('王小明,,,會友,否')
  })

  it('pages the keyset to completion, threading the RAW created_at cursor', async () => {
    const page1 = Array.from({ length: 200 }, (_, i) =>
      row({ id: `id-${String(i).padStart(3, '0')}`, created_at: `2026-01-01T00:00:0${i % 10}.000000+00:00` }),
    )
    const last = page1[page1.length - 1]
    const spy = vi.fn(async (args: { afterCreatedAt: string | null }) =>
      args.afterCreatedAt === null ? page1 : [row({ id: 'id-final' })],
    )
    const repo = makeMockRepo({ listMembersForExportPage: spy })
    const res = await exportMembersCsv({ role: 'superadmin', actor, requestId: 'req-1', now: NOW }, asRepo(repo))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.rowCount).toBe(201)
    expect(spy).toHaveBeenNthCalledWith(2, expect.objectContaining({ afterCreatedAt: last.created_at, afterId: last.id }))
  })
})
