import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

vi.mock('@/server/services/memberMaintenanceService', async importOriginal => {
  const actual = await importOriginal<typeof import('@/server/services/memberMaintenanceService')>()
  return {
    ...actual,
    createMember: vi.fn(),
    updateMemberIdentity: vi.fn(),
    addMemberVehicle: vi.fn(),
    setMemberVehicleActive: vi.fn(),
  }
})
vi.mock('@/server/http/adminAuth', async importOriginal => {
  const actual = await importOriginal<typeof import('@/server/http/adminAuth')>()
  return { ...actual, getAdminSession: vi.fn() }
})

import { POST as createPOST } from '@/app/api/admin/members/create/route'
import { POST as identityPOST } from '@/app/api/admin/members/identity/route'
import { POST as vehiclesPOST } from '@/app/api/admin/members/vehicles/route'
import { getAdminSession } from '@/server/http/adminAuth'
import {
  addMemberVehicle,
  createMember,
  setMemberVehicleActive,
  updateMemberIdentity,
} from '@/server/services/memberMaintenanceService'

// Tier 0-2 (0038). These routes carry a member's real name and phone in the body, and the
// mutations behind them are audited — so what is pinned here is the boundary: who may call,
// what shape is accepted, which status a typed refusal becomes, and that nothing about the
// member's identity is echoed into a log line.

const SESSION = { sessionId: 's1', adminId: 'admin-1', username: 'alice', role: 'superadmin' as const }
// A 幹事 may do all of this: they can already bulk-import the roster and read every
// member's PII, so there is deliberately no extra capability gate here.
const CLERK_SESSION = { ...SESSION, role: 'clerk' as const }
const USER_ID = 'a1b2c3d4-1111-4222-8333-000000000001'
const VEHICLE_ID = 'a1b2c3d4-1111-4222-8333-000000000002'

type Handler = typeof createPOST

const post = (handler: Handler, path: string, body: unknown, headers: Record<string, string> = {}) =>
  handler(new Request(`http://localhost/api/admin/members/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }))

describe('POST /api/admin/members/create', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getAdminSession as Mock).mockResolvedValue(SESSION)
    ;(createMember as Mock).mockResolvedValue({ ok: true, userId: USER_ID })
  })

  it('no session → 401 and the service is never reached', async () => {
    ;(getAdminSession as Mock).mockResolvedValue(null)
    const res = await post(createPOST, 'create', { displayName: '王小明', phone: '0912345678' })
    expect(res.status).toBe(401)
    expect(createMember).not.toHaveBeenCalled()
  })

  it('a clerk may create members', async () => {
    ;(getAdminSession as Mock).mockResolvedValue(CLERK_SESSION)
    const res = await post(createPOST, 'create', { displayName: '王小明', phone: '0912345678' })
    expect(res.status).toBe(200)
  })

  it('refuses a foreign Origin and a non-JSON body before touching the service', async () => {
    const foreign = await post(createPOST, 'create', { displayName: '王', phone: '0912345678' }, {
      origin: 'https://evil.example',
    })
    expect(foreign.status).toBe(403)
    const nonJson = await createPOST(new Request('http://localhost/api/admin/members/create', {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x',
    }))
    expect(nonJson.status).toBe(415)
    expect(createMember).not.toHaveBeenCalled()
  })

  it('distinguishes "not asked yet" (absent) from a confirmed EMPTY set', async () => {
    await post(createPOST, 'create', { displayName: '王小明', phone: '0912345678' })
    expect(createMember).toHaveBeenLastCalledWith(
      expect.objectContaining({ confirmedCandidateIds: null }),
    )
    // An explicit [] must survive as [] — collapsing it to null would re-prompt forever.
    await post(createPOST, 'create', {
      displayName: '王小明', phone: '0912345678', confirmedCandidateIds: [],
    })
    expect(createMember).toHaveBeenLastCalledWith(
      expect.objectContaining({ confirmedCandidateIds: [] }),
    )
    // An explicit null is the same statement as omitting it.
    await post(createPOST, 'create', {
      displayName: '王小明', phone: '0912345678', confirmedCandidateIds: null,
    })
    expect(createMember).toHaveBeenLastCalledWith(
      expect.objectContaining({ confirmedCandidateIds: null }),
    )
  })

  it('400s on a malformed confirmation list rather than passing junk to the DB', async () => {
    for (const bad of [['not-a-uuid'], [1, 2], 'abc', {}, Array(51).fill(USER_ID)]) {
      const res = await post(createPOST, 'create', {
        displayName: '王小明', phone: '0912345678', confirmedCandidateIds: bad,
      })
      expect(res.status, JSON.stringify(bad)).toBe(400)
    }
    expect(createMember).not.toHaveBeenCalled()
  })

  it('does NOT validate the name/phone format — that rule lives in one place, the RPC', async () => {
    // The route must not grow a second copy of the phone rule: the CSV import answers the
    // same question, and two copies drift. A malformed phone reaches the RPC and comes
    // back as a typed 422.
    ;(createMember as Mock).mockResolvedValue({ ok: false, reason: 'invalid_phone' })
    const res = await post(createPOST, 'create', { displayName: '王小明', phone: '12345' })
    expect(createMember).toHaveBeenCalled()
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ ok: false, reason: 'invalid_phone' })
  })

  it('returns the candidate list with a 409 so the client can render step two', async () => {
    ;(createMember as Mock).mockResolvedValue({
      ok: false,
      reason: 'homonym_requires_confirmation',
      candidates: [{ id: USER_ID, phoneMasked: '0912***678', evidence: 'same_name' }],
    })
    const res = await post(createPOST, 'create', { displayName: '王小明', phone: '0987654321' })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.candidates).toHaveLength(1)
    // Masked on the way out — a full number never leaves the server here.
    expect(JSON.stringify(body)).not.toMatch(/09\d{8}/)
  })

  it('a service throw becomes a 500 that echoes nothing from the body', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    ;(createMember as Mock).mockRejectedValue(new Error('boom 王小明 0912345678'))
    const res = await post(createPOST, 'create', { displayName: '王小明', phone: '0912345678' })
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('王小明')
    for (const call of spy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('0912345678')
      expect(JSON.stringify(call)).not.toContain('王小明')
    }
    spy.mockRestore()
  })
})

describe('POST /api/admin/members/identity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getAdminSession as Mock).mockResolvedValue(SESSION)
    ;(updateMemberIdentity as Mock).mockResolvedValue({ ok: true, changed: true, bindingsInvalidated: 0 })
  })

  it('requires a uuid target — a member is never addressed by phone here', async () => {
    for (const bad of [{ phone: '0912345678', displayName: '王' }, { userId: '0912345678', displayName: '王', phone: '0900000000' }]) {
      const res = await post(identityPOST, 'identity', bad)
      expect(res.status).toBe(400)
    }
    expect(updateMemberIdentity).not.toHaveBeenCalled()
  })

  it('passes the invalidated-binding count through to the client', async () => {
    ;(updateMemberIdentity as Mock).mockResolvedValue({ ok: true, changed: true, bindingsInvalidated: 2 })
    const res = await post(identityPOST, 'identity', {
      userId: USER_ID, displayName: '王大明', phone: '0900111222',
    })
    expect(await res.json()).toEqual({ ok: true, changed: true, bindingsInvalidated: 2 })
  })

  it('maps phone_in_use to 409 and a missing member to 404', async () => {
    ;(updateMemberIdentity as Mock).mockResolvedValue({ ok: false, reason: 'phone_in_use' })
    expect((await post(identityPOST, 'identity', {
      userId: USER_ID, displayName: '王', phone: '0900111222',
    })).status).toBe(409)

    ;(updateMemberIdentity as Mock).mockResolvedValue({ ok: false, reason: 'not_found' })
    expect((await post(identityPOST, 'identity', {
      userId: USER_ID, displayName: '王', phone: '0900111222',
    })).status).toBe(404)
  })
})

describe('POST /api/admin/members/vehicles', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getAdminSession as Mock).mockResolvedValue(SESSION)
    ;(addMemberVehicle as Mock).mockResolvedValue({ ok: true, vehicleId: VEHICLE_ID })
    ;(setMemberVehicleActive as Mock).mockResolvedValue({ ok: true, vehicleId: VEHICLE_ID, isActive: false })
  })

  it('400s an unknown or missing action instead of guessing one', async () => {
    for (const body of [{}, { action: 'delete', vehicleId: VEHICLE_ID }, { action: 'add' }]) {
      expect((await post(vehiclesPOST, 'vehicles', body)).status).toBe(400)
    }
    expect(addMemberVehicle).not.toHaveBeenCalled()
    expect(setMemberVehicleActive).not.toHaveBeenCalled()
  })

  it('requires an explicit boolean for set_active — a missing flag must not read as false', async () => {
    // Coercing here would let a malformed request RETIRE a car, which is the destructive
    // direction of the pair.
    for (const isActive of [undefined, 'true', 1, null]) {
      const res = await post(vehiclesPOST, 'vehicles', { action: 'set_active', vehicleId: VEHICLE_ID, isActive })
      expect(res.status, String(isActive)).toBe(400)
    }
    expect(setMemberVehicleActive).not.toHaveBeenCalled()
  })

  it('returns the reactivate target with inactive_plate_exists (409)', async () => {
    ;(addMemberVehicle as Mock).mockResolvedValue({
      ok: false, reason: 'inactive_plate_exists', vehicleId: VEHICLE_ID,
    })
    const res = await post(vehiclesPOST, 'vehicles', {
      action: 'add', userId: USER_ID, licensePlate: 'ABC-1234',
    })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ ok: false, reason: 'inactive_plate_exists', vehicleId: VEHICLE_ID })
  })

  it('returns the unfinished count with a refused deactivation (409)', async () => {
    ;(setMemberVehicleActive as Mock).mockResolvedValue({
      ok: false, reason: 'unfinished_reservations', unfinished: 3,
    })
    const res = await post(vehiclesPOST, 'vehicles', {
      action: 'set_active', vehicleId: VEHICLE_ID, isActive: false,
    })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ ok: false, reason: 'unfinished_reservations', unfinished: 3 })
  })
})
