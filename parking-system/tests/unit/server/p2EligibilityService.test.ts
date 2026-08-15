import { describe, expect, it, vi } from 'vitest'
import { makeMockRepo, asRepo, type MockRepo } from './mockRepo'
import { markP2Reviewed, setP2Eligibility } from '@/server/services/p2EligibilityService'
import type { AuditActor } from '@/server/services/auditContext'

function run(over: Partial<MockRepo> = {}) {
  const repo = makeMockRepo(over)
  return { repo, r: asRepo(repo) }
}

const ACTOR: AuditActor = {
  actorType: 'admin', actorId: 'admin-1', actorSessionId: 'sess-1', actorRoleSnapshot: null,
}
const BASE = {
  userId: 'user-1', expectedVersion: 0, reviewStatus: 'approved' as const,
  reason: 'pregnancy', validFrom: null, validUntil: '2027-01-01',
  childBirthdate: null, nextReviewDate: '2026-12-01', note: null,
  actor: ACTOR, requestId: 'req-1',
}

describe('setP2Eligibility', () => {
  it('threads actor, session and requestId through to the RPC', async () => {
    const { repo, r } = run()
    await setP2Eligibility(BASE, r)
    expect(repo.setP2Eligibility).toHaveBeenCalledWith({
      userId: 'user-1', expectedVersion: 0, reviewStatus: 'approved', reason: 'pregnancy',
      validFrom: null, validUntil: '2027-01-01', childBirthdate: null,
      nextReviewDate: '2026-12-01', note: null,
      actingAdminId: 'admin-1', actingSessionId: 'sess-1', requestId: 'req-1',
    })
  })

  it('refuses an actor it cannot attribute, without touching the repo', async () => {
    // The audit row is written inside the RPC's transaction, so an eligibility change that
    // cannot be pinned on a named admin must not happen at all.
    const { repo, r } = run()
    await expect(
      setP2Eligibility({ ...BASE, actor: { ...ACTOR, actorSessionId: null } }, r),
    ).rejects.toThrow(/admin actor/)
    expect(repo.setP2Eligibility).not.toHaveBeenCalled()
  })

  it('does NOT sanitize a child_companion expiry away — the RPC must get to refuse it', async () => {
    // This service originally nulled the expiry out "helpfully" for child_companion. The
    // result: set_p2_eligibility's expiry_not_settable guard became unreachable through the
    // route, and a caller who sent an expiry got a silent 200 with their value discarded —
    // exactly the silently-ignored behaviour the guard exists to prevent. Only the end-to-end
    // run caught it; the unit test that replaced this one asserted the bug was correct.
    //
    // A service must not "fix" input on the caller's behalf when a guard downstream is there
    // to tell them they were wrong.
    const { repo, r } = run()
    await setP2Eligibility({ ...BASE, reason: 'child_companion', validUntil: '2099-01-01', childBirthdate: '2020-01-01' }, r)
    expect(repo.setP2Eligibility).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'child_companion', validUntil: '2099-01-01', childBirthdate: '2020-01-01' }),
    )
  })

  it('forwards the expiry unchanged for every other reason', async () => {
    const { repo, r } = run()
    await setP2Eligibility({ ...BASE, reason: 'mobility_short', validUntil: '2027-01-01' }, r)
    expect(repo.setP2Eligibility).toHaveBeenCalledWith(
      expect.objectContaining({ validUntil: '2027-01-01' }),
    )
  })

  it.each([
    ['conflict'], ['not_found'], ['nothing_to_revoke'], ['reason_required'],
    ['review_date_required'], ['review_date_in_past'], ['child_birthdate_required'],
    ['child_birthdate_in_future'], ['child_birthdate_not_applicable'],
    ['expiry_not_settable'], ['window_inverted'], ['invalid_status'],
  ])('passes the typed refusal %s straight through', async reason => {
    const { r } = run({ setP2Eligibility: vi.fn(async () => ({ ok: false, reason })) })
    expect(await setP2Eligibility(BASE, r)).toMatchObject({ ok: false, reason })
  })

  it('surfaces actual_version on a conflict so the UI can explain the race', async () => {
    const { r } = run({ setP2Eligibility: vi.fn(async () => ({ ok: false, reason: 'conflict', actual_version: 4 })) })
    expect(await setP2Eligibility(BASE, r)).toMatchObject({ ok: false, reason: 'conflict', actualVersion: 4 })
  })

  it('reports a no-op as success without pretending anything changed', async () => {
    const { r } = run({ setP2Eligibility: vi.fn(async () => ({ ok: true, noop: true, review_version: 3 })) })
    expect(await setP2Eligibility(BASE, r)).toEqual({ ok: true, noop: true, reviewVersion: 3 })
  })
})

describe('markP2Reviewed', () => {
  it('threads actor, session and requestId through to the RPC', async () => {
    const { repo, r } = run()
    await markP2Reviewed({
      userId: 'user-1', expectedVersion: 2, nextReviewDate: '2027-06-30',
      actor: ACTOR, requestId: 'req-2',
    }, r)
    expect(repo.markP2Reviewed).toHaveBeenCalledWith({
      userId: 'user-1', expectedVersion: 2, nextReviewDate: '2027-06-30',
      actingAdminId: 'admin-1', actingSessionId: 'sess-1', requestId: 'req-2',
    })
  })

  it('refuses an unattributable actor', async () => {
    const { repo, r } = run()
    await expect(markP2Reviewed({
      userId: 'user-1', expectedVersion: 2, nextReviewDate: '2027-06-30',
      actor: { ...ACTOR, actorId: null }, requestId: 'req-2',
    }, r)).rejects.toThrow(/admin actor/)
    expect(repo.markP2Reviewed).not.toHaveBeenCalled()
  })

  it.each([['conflict'], ['not_found'], ['eligibility_not_approved'], ['review_date_in_past']])(
    'passes the typed refusal %s straight through', async reason => {
      const { r } = run({ markP2Reviewed: vi.fn(async () => ({ ok: false, reason })) })
      expect(await markP2Reviewed({
        userId: 'user-1', expectedVersion: 2, nextReviewDate: '2027-06-30',
        actor: ACTOR, requestId: 'req-2',
      }, r)).toMatchObject({ ok: false, reason })
    },
  )

  it('has no no-op branch at all — this action is never inert', async () => {
    // If a "nothing changed" shortcut ever appears here it would erase a governance fact:
    // two people checking on two different days are two real reviews (0033).
    const { r } = run({ markP2Reviewed: vi.fn(async () => ({ ok: true, review_version: 9 })) })
    expect(await markP2Reviewed({
      userId: 'user-1', expectedVersion: 8, nextReviewDate: '2027-06-30',
      actor: ACTOR, requestId: 'req-2',
    }, r)).toEqual({ ok: true, reviewVersion: 9 })
  })
})
