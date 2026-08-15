import { describe, expect, it, vi } from 'vitest'
import { asRepo, makeMockRepo, type MockRepo } from './mockRepo'
import {
  addMemberVehicle,
  createMember,
  MEMBER_MAINTENANCE_STATUS,
  setMemberVehicleActive,
  updateMemberIdentity,
} from '@/server/services/memberMaintenanceService'
import type { AuditActor } from '@/server/services/auditContext'

// Tier 0-2 (0038). The RPCs' own semantics are asserted in SQL (verify_schema.sql §42–42f)
// and end-to-end in member-maintenance.db.test.ts; what is pinned HERE is the thin layer
// between them and HTTP — the part that could silently mis-thread an actor, leak a phone,
// or turn a typed refusal into a 500.

function run(over: Partial<MockRepo> = {}) {
  const repo = makeMockRepo(over)
  return { repo, r: asRepo(repo) }
}

const ADMIN = '11111111-1111-4111-8111-111111111111'
const SESSION = '22222222-2222-4222-8222-222222222222'
const REQ = '33333333-3333-4333-8333-333333333333'
const USER = '44444444-4444-4444-8444-444444444444'
const VEHICLE = '55555555-5555-4555-8555-555555555555'

const ACTOR: AuditActor = {
  actorType: 'admin',
  actorId: ADMIN,
  actorSessionId: SESSION,
  actorRoleSnapshot: null,
}

describe('createMember', () => {
  it('threads the actor from the session and passes the confirmation through UNCHANGED', async () => {
    const createMemberRpc = vi.fn(async () => ({ ok: true, user_id: USER }))
    const { repo, r } = run({ createMember: createMemberRpc })

    // null is not "no candidates" — it is "the operator has not been shown them yet". If
    // this were coalesced to [], the RPC would read it as a CONFIRMED empty set and create
    // the member without ever asking.
    await createMember(
      { displayName: '王小明', phone: '0912345678', confirmedCandidateIds: null, actor: ACTOR, requestId: REQ },
      r,
    )
    expect(repo.createMember).toHaveBeenCalledWith({
      displayName: '王小明',
      phone: '0912345678',
      confirmedCandidateIds: null,
      actingAdminId: ADMIN,
      actingSessionId: SESSION,
      requestId: REQ,
    })

    await createMember(
      { displayName: '王小明', phone: '0912345678', confirmedCandidateIds: [], actor: ACTOR, requestId: REQ },
      r,
    )
    expect(repo.createMember).toHaveBeenLastCalledWith(
      expect.objectContaining({ confirmedCandidateIds: [] }),
    )
  })

  it('masks candidate phones — the operator is deciding about people, not reading their numbers', async () => {
    const { r } = run({
      createMember: vi.fn(async () => ({
        ok: false,
        reason: 'homonym_requires_confirmation',
        candidates: [
          { id: 'u-1', phone: '0912345678', evidence: 'same_name' },
          { id: 'u-2', phone: null, evidence: 'same_name' },
        ],
      })),
    })
    const result = await createMember(
      { displayName: '王小明', phone: '0987654321', confirmedCandidateIds: null, actor: ACTOR, requestId: REQ },
      r,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('homonym_requires_confirmation')
    expect(result.candidates).toEqual([
      { id: 'u-1', phoneMasked: expect.not.stringContaining('0912345678'), evidence: 'same_name' },
      { id: 'u-2', phoneMasked: '—', evidence: 'same_name' },
    ])
    // The whole response, not just the field we looked at.
    expect(JSON.stringify(result)).not.toContain('0912345678')
  })

  it('fails loud when the RPC reports success without an id', async () => {
    // ok:true with no user_id is a contract violation, not a business state: the caller
    // would have "created" a member it cannot link to or act on. Better a 500 than a
    // success message pointing nowhere.
    const { r } = run({ createMember: vi.fn(async () => ({ ok: true })) })
    await expect(
      createMember(
        { displayName: '王小明', phone: '0912345678', confirmedCandidateIds: null, actor: ACTOR, requestId: REQ },
        r,
      ),
    ).rejects.toThrow(/user_id/)
  })

  it('refuses to act on an actor with no session behind it', async () => {
    const { repo, r } = run()
    await expect(
      createMember(
        {
          displayName: '王小明',
          phone: '0912345678',
          confirmedCandidateIds: null,
          actor: { ...ACTOR, actorSessionId: null },
          requestId: REQ,
        },
        r,
      ),
    ).rejects.toThrow()
    // Nothing reached the DB: an unattributable mutation must not be written at all.
    expect(repo.createMember).not.toHaveBeenCalled()
  })
})

describe('updateMemberIdentity', () => {
  it('addresses the member by id and stamps the rejection clock from the app', async () => {
    const now = new Date('2026-07-27T01:02:03.000Z')
    const { repo, r } = run()
    await updateMemberIdentity(
      { userId: USER, displayName: '王大明', phone: '0900111222', actor: ACTOR, requestId: REQ },
      r,
      now,
    )
    // No phone-based lookup anywhere in the call: the OLD number is not part of the
    // request, so it cannot be used as a key by accident.
    expect(repo.updateMemberIdentity).toHaveBeenCalledWith({
      userId: USER,
      displayName: '王大明',
      phone: '0900111222',
      actingAdminId: ADMIN,
      actingSessionId: SESSION,
      requestId: REQ,
      nowIso: now.toISOString(),
    })
  })

  it('reports invalidated bindings, and treats an unchanged write as changed:false', async () => {
    const { r } = run({
      updateMemberIdentity: vi.fn(async () => ({ ok: true, changed: true, bindings_invalidated: 2 })),
    })
    await expect(
      updateMemberIdentity(
        { userId: USER, displayName: '王大明', phone: '0900111222', actor: ACTOR, requestId: REQ },
        r,
      ),
    ).resolves.toEqual({ ok: true, changed: true, bindingsInvalidated: 2 })

    // The no-op shape: ok, changed:false, and NO bindings_invalidated key at all.
    const { r: r2 } = run({ updateMemberIdentity: vi.fn(async () => ({ ok: true, changed: false })) })
    await expect(
      updateMemberIdentity(
        { userId: USER, displayName: '王大明', phone: '0900111222', actor: ACTOR, requestId: REQ },
        r2,
      ),
    ).resolves.toEqual({ ok: true, changed: false, bindingsInvalidated: 0 })
  })
})

describe('vehicle maintenance', () => {
  it('carries the reactivate target back with inactive_plate_exists', async () => {
    // The refusal is only useful WITH the id — it is the row the operator is being sent to.
    const { r } = run({
      addMemberVehicle: vi.fn(async () => ({
        ok: false,
        reason: 'inactive_plate_exists',
        vehicle_id: VEHICLE,
      })),
    })
    await expect(
      addMemberVehicle({ userId: USER, licensePlate: 'ABC-1234', actor: ACTOR, requestId: REQ }, r),
    ).resolves.toEqual({ ok: false, reason: 'inactive_plate_exists', vehicleId: VEHICLE })
  })

  it('carries the unfinished count back with a refused deactivation', async () => {
    const { r } = run({
      setMemberVehicleActive: vi.fn(async () => ({
        ok: false,
        reason: 'unfinished_reservations',
        unfinished: 3,
      })),
    })
    await expect(
      setMemberVehicleActive({ vehicleId: VEHICLE, isActive: false, actor: ACTOR, requestId: REQ }, r),
    ).resolves.toEqual({ ok: false, reason: 'unfinished_reservations', unfinished: 3 })
  })

  it('believes the DB about the state it committed, not the request', async () => {
    // If the two ever disagree the DB is right — reporting the requested value would tell
    // the operator the car is retired when it is not.
    const { r } = run({
      setMemberVehicleActive: vi.fn(async () => ({ ok: true, vehicle_id: VEHICLE, is_active: true })),
    })
    await expect(
      setMemberVehicleActive({ vehicleId: VEHICLE, isActive: false, actor: ACTOR, requestId: REQ }, r),
    ).resolves.toEqual({ ok: true, vehicleId: VEHICLE, isActive: true })
  })
})

describe('reason mapping', () => {
  it('maps an unknown reason to a refusal rather than a crash (new DB + old app)', async () => {
    // Deployment case A: the DB is ahead of this build and returns a reason it has never
    // heard of. The mutation genuinely did not happen — the operator must be told that,
    // not shown a 500 that reads as "unknown, maybe it worked".
    const { r } = run({
      addMemberVehicle: vi.fn(async () => ({ ok: false, reason: 'some_future_guard' })),
    })
    const result = await addMemberVehicle(
      { userId: USER, licensePlate: 'ABC-1234', actor: ACTOR, requestId: REQ },
      r,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(MEMBER_MAINTENANCE_STATUS[result.reason]).toBeGreaterThanOrEqual(400)
    expect(MEMBER_MAINTENANCE_STATUS[result.reason]).toBeLessThan(500)
  })

  it('gives every reason exactly one status, and never a 2xx', async () => {
    // A 2xx on a refusal would make "created" and "refused" the same to any caller that
    // checks only the status code.
    for (const [reason, status] of Object.entries(MEMBER_MAINTENANCE_STATUS)) {
      expect(status, reason).toBeGreaterThanOrEqual(400)
      expect(status, reason).toBeLessThan(500)
    }
    // The identity gate is a 409, NOT a 200: nothing was created.
    expect(MEMBER_MAINTENANCE_STATUS.homonym_requires_confirmation).toBe(409)
    // Malformed input vs. a state refusal stay distinguishable — retrying an unchanged
    // 422 fails identically forever, while a 409 may well succeed after a refresh.
    expect(MEMBER_MAINTENANCE_STATUS.invalid_phone).toBe(422)
    expect(MEMBER_MAINTENANCE_STATUS.phone_in_use).toBe(409)
  })
})
