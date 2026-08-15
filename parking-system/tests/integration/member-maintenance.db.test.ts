import { randomInt, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Tier 0-2 (0038) — the four maintenance mutations through the REAL stack: service →
// repository → PostgREST → RPC → audit row.
//
// The SQL semantics are already asserted in supabase/tests/verify_schema.sql (§42–42f),
// which calls the functions directly. This file exists for what that cannot see:
//
//   * PostgREST invokes by NAMED argument. A renamed p_* parameter type-checks fine,
//     passes db:verify, and then fails only at runtime — in production.
//   * jsonb → TypeScript marshalling: snake_case keys, absent-vs-null fields, and the
//     typed refusals surviving as refusals instead of thrown errors.
//   * the audit row is really written by the app path, with the acting session's ids.
//
// Gated: `RUN_DB_TESTS=1` (prereq: `npm run db:reset`). No weekly fixture needed except
// for the deactivation guard, which owns Sunday 2099-11-15.
try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may already be exported */
}
const RUN = process.env.RUN_DB_TESTS === '1'

type Sb = import('@supabase/supabase-js').SupabaseClient
type AuditActor = import('@/server/services/auditContext').AuditActor

// Letters-only isolation tag so names and plates stay clean substrings.
const TAG = randomUUID().replace(/[0-9-]/g, '').slice(0, 6).toUpperCase()
const phone = () => `09${String(randomInt(1e8)).padStart(8, '0')}`
// ⚠️ This file OWNS Sunday 2099-11-15 — no other suite may use it.
const SUNDAY = '2099-11-15'

describe.skipIf(!RUN)('member maintenance (Tier 0-2 / 0038) — local DB integration', () => {
  let sb: Sb
  let repo: import('@/server/repositories/parkingRepository').ParkingRepository
  let svc: typeof import('@/server/services/memberMaintenanceService')
  let actor: AuditActor
  let adminId: string
  let eventId: string
  const userIds: string[] = []

  const req = () => randomUUID()
  const auditFor = async (requestId: string) => {
    const { data } = await sb.from('audit_logs').select('*').eq('request_id', requestId)
    return data ?? []
  }
  const create = async (name: string, phoneNo: string, confirmed: string[] | null = null) => {
    const r = await svc.createMember(
      { displayName: name, phone: phoneNo, confirmedCandidateIds: confirmed, actor, requestId: req() },
      repo,
    )
    if (r.ok) userIds.push(r.userId)
    return r
  }
  const vehiclesOf = async (userId: string) => {
    const { data } = await sb
      .from('vehicles')
      .select('id, license_plate_normalized, is_active')
      .eq('user_id', userId)
      .order('created_at')
    return data ?? []
  }

  beforeAll(async () => {
    sb = (await import('@/lib/supabase/server')).getServiceClient()
    repo = (await import('@/server/repositories/parkingRepository')).createParkingRepository(sb)
    svc = await import('@/server/services/memberMaintenanceService')

    // admin_accounts_username_ck: lowercase, [a-z0-9_.-]{3,32}.
    const { data: admin } = await sb
      .from('admin_accounts')
      .insert({ username: `maint-${TAG.toLowerCase()}`, password_hash: 'scrypt$notarealhash', role: 'clerk' })
      .select('id')
      .single()
      .throwOnError()
    adminId = (admin as { id: string }).id
    // A clerk, deliberately: this surface is day-to-day 幹事 work and has no extra
    // capability gate. If it ever grows one, this test starts failing — which is correct.
    actor = {
      actorType: 'admin',
      actorId: adminId,
      actorSessionId: randomUUID(),
      actorRoleSnapshot: null,
    }

    const { data: existing } = await sb
      .from('weekly_events').select('id').eq('sunday_date', SUNDAY).maybeSingle()
    if (existing) {
      eventId = (existing as { id: string }).id
      await sb.from('weekly_events').update({ status: 'open' }).eq('id', eventId).throwOnError()
    } else {
      const { data } = await sb
        .from('weekly_events')
        .insert({ sunday_date: SUNDAY, status: 'open', total_capacity: 20, blocked_spaces: 0 })
        .select('id')
        .single()
      eventId = (data as { id: string }).id
    }
  })

  afterAll(async () => {
    if (!RUN) return
    for (const id of userIds) {
      await sb.from('reservations').delete().eq('user_id', id)
      await sb.from('pending_binding').delete().eq('matched_user_id_at_capture', id)
      await sb.from('vehicles').delete().eq('user_id', id)
      await sb.from('users').delete().eq('id', id)
    }
    // audit_logs deliberately has no FK to admin_accounts — the log outlives its actors —
    // so the account can go even though the rows it wrote cannot.
    await sb.from('admin_accounts').delete().eq('id', adminId)
    await sb.from('weekly_events').update({ status: 'finalized' }).eq('id', eventId)
  })

  it('creates a member and writes ONE audit row carrying the acting session', async () => {
    const requestId = randomUUID()
    const result = await svc.createMember(
      { displayName: `${TAG}單獨新增`, phone: phone(), confirmedCandidateIds: null, actor, requestId },
      repo,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    userIds.push(result.userId)

    const rows = await auditFor(requestId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      action: 'member.create',
      result: 'success',
      entity_type: 'member',
      entity_id: result.userId,
      actor_type: 'admin',
      actor_id: adminId,
      actor_session_id: actor.actorSessionId,
      // Read by the RPC from the account it locked — never taken from the caller.
      actor_role_snapshot: 'clerk',
    })
    // No name or phone in the audit metadata: the row records that a member was created
    // and points at them by id.
    expect(JSON.stringify(rows[0].metadata_redacted)).not.toContain(TAG)
  })

  it('gates a homonym, then accepts the exact confirmed SET — and rejects a stale one', async () => {
    const name = `${TAG}同名`
    const first = await create(name, phone())
    expect(first.ok).toBe(true)
    if (!first.ok) return

    // Step one: no confirmation → candidates, nothing written.
    const gated = await create(name, phone())
    expect(gated).toMatchObject({ ok: false, reason: 'homonym_requires_confirmation' })
    if (gated.ok) return
    expect(gated.candidates).toEqual([
      { id: first.userId, phoneMasked: expect.any(String), evidence: 'same_name' },
    ])
    // Masked across the boundary, not raw.
    expect(gated.candidates?.[0].phoneMasked).not.toMatch(/^09\d{8}$/)

    // A confirmation of the WRONG set (empty) is a conflict, and it is audited: somebody
    // decided against a picture of the roster that was not true.
    const staleReq = randomUUID()
    const stale = await svc.createMember(
      { displayName: name, phone: phone(), confirmedCandidateIds: [], actor, requestId: staleReq },
      repo,
    )
    expect(stale).toMatchObject({ ok: false, reason: 'homonym_confirmation_stale' })
    expect(await auditFor(staleReq)).toMatchObject([{ action: 'member.create', result: 'conflict' }])

    // The right set → a second member with the same name, on purpose.
    const confirmed = await create(name, phone(), [first.userId])
    expect(confirmed.ok).toBe(true)
    if (!confirmed.ok) return
    expect(confirmed.userId).not.toBe(first.userId)
  })

  it('a phone change keeps the SAME users.id and invalidates that member\'s LINE claims', async () => {
    const oldPhone = phone()
    const created = await create(`${TAG}改號`, oldPhone)
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const lineUserId = `U-${TAG}-maint`

    // The member submits a LIFF claim against their CURRENT phone; capture resolves and
    // FREEZES who that is.
    await repo.captureLiffBindingClaim({
      lineUserId, phone: oldPhone, name: `${TAG}改號`, nowIso: new Date().toISOString(),
    })
    const { data: captured } = await sb
      .from('pending_binding')
      .select('id, matched_user_id_at_capture, status')
      .eq('line_user_id', lineUserId)
      .eq('status', 'pending')
      .single()
    expect((captured as { matched_user_id_at_capture: string }).matched_user_id_at_capture)
      .toBe(created.userId)

    const newPhone = phone()
    const changed = await svc.updateMemberIdentity(
      { userId: created.userId, displayName: `${TAG}改號`, phone: newPhone, actor, requestId: req() },
      repo,
    )
    expect(changed).toEqual({ ok: true, changed: true, bindingsInvalidated: 1 })

    // Same identity, new attribute — this is the whole point. A re-import would have made
    // a second member here.
    const { data: after } = await sb
      .from('users').select('phone_number').eq('id', created.userId).single()
    expect((after as { phone_number: string }).phone_number).toBe(newPhone)

    // The outstanding claim is fully decided, including rejected_at — the retention scan
    // keys on coalesce(approved_at, rejected_at), so a null there would keep its PII forever.
    const { data: claim } = await sb
      .from('pending_binding')
      .select('status, rejected_reason, rejected_at, decided_by_admin_id')
      .eq('id', (captured as { id: string }).id)
      .single()
    expect(claim).toMatchObject({
      status: 'rejected',
      rejected_reason: 'phone_changed_by_admin',
      decided_by_admin_id: adminId,
    })
    expect((claim as { rejected_at: string | null }).rejected_at).not.toBeNull()

    // An unchanged write is inert and reports so.
    const noop = await svc.updateMemberIdentity(
      { userId: created.userId, displayName: `${TAG}改號`, phone: newPhone, actor, requestId: req() },
      repo,
    )
    expect(noop).toEqual({ ok: true, changed: false, bindingsInvalidated: 0 })
  })

  it('refuses a phone another member holds, as a typed denial rather than a 23505', async () => {
    const held = phone()
    const a = await create(`${TAG}佔號A`, held)
    const b = await create(`${TAG}佔號B`, phone())
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return

    const requestId = randomUUID()
    const result = await svc.updateMemberIdentity(
      { userId: b.userId, displayName: `${TAG}佔號B`, phone: held, actor, requestId },
      repo,
    )
    // A unique violation must never reach the caller as an exception.
    expect(result).toEqual({ ok: false, reason: 'phone_in_use' })
    expect(await auditFor(requestId)).toMatchObject([{ action: 'member.identity_change', result: 'denied' }])
  })

  it('retires a car, re-issues the plate, and leaves the previous owner\'s row intact', async () => {
    const plate = `${TAG}9001`
    const a = await create(`${TAG}車主甲`, phone())
    const b = await create(`${TAG}車主乙`, phone())
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return

    const added = await svc.addMemberVehicle(
      { userId: a.userId, licensePlate: plate, actor, requestId: req() },
      repo,
    )
    expect(added.ok).toBe(true)
    if (!added.ok) return

    // Another member cannot take an ACTIVE plate…
    expect(await svc.addMemberVehicle(
      { userId: b.userId, licensePlate: plate, actor, requestId: req() }, repo,
    )).toMatchObject({ ok: false, reason: 'active_plate_owned_by_other' })

    // …and neither can its own owner add it twice.
    expect(await svc.addMemberVehicle(
      { userId: a.userId, licensePlate: plate, actor, requestId: req() }, repo,
    )).toMatchObject({ ok: false, reason: 'active_plate_owned_by_self' })

    expect(await svc.setMemberVehicleActive(
      { vehicleId: added.vehicleId, isActive: false, actor, requestId: req() }, repo,
    )).toEqual({ ok: true, vehicleId: added.vehicleId, isActive: false })

    // Now it is re-issuable — and A's row survives, because reservations reference
    // (vehicle_id, user_id): that car AND who drove it at the time.
    const reissued = await svc.addMemberVehicle(
      { userId: b.userId, licensePlate: plate, actor, requestId: req() },
      repo,
    )
    expect(reissued.ok).toBe(true)
    const aRows = await vehiclesOf(a.userId)
    expect(aRows).toHaveLength(1)
    expect(aRows[0]).toMatchObject({ id: added.vehicleId, is_active: false })

    if (!reissued.ok) return

    // While B actively holds it, "A owned this once" does not enter into it: the CURRENT
    // holder is the answer, both for a re-add and for reactivating A's old row.
    expect(await svc.addMemberVehicle(
      { userId: a.userId, licensePlate: plate, actor, requestId: req() }, repo,
    )).toMatchObject({ ok: false, reason: 'active_plate_owned_by_other' })
    expect(await svc.setMemberVehicleActive(
      { vehicleId: added.vehicleId, isActive: true, actor, requestId: req() }, repo,
    )).toMatchObject({ ok: false, reason: 'active_plate_owned_by_other' })

    // Once B releases it, a re-add by the original owner points at the row to reactivate
    // rather than stacking a second one — and carries its id so the UI can offer exactly
    // that. Stacking rows would make the history meaningless.
    await svc.setMemberVehicleActive(
      { vehicleId: reissued.vehicleId, isActive: false, actor, requestId: req() }, repo,
    )
    expect(await svc.addMemberVehicle(
      { userId: a.userId, licensePlate: plate, actor, requestId: req() }, repo,
    )).toEqual({ ok: false, reason: 'inactive_plate_exists', vehicleId: added.vehicleId })

    expect(await svc.setMemberVehicleActive(
      { vehicleId: added.vehicleId, isActive: true, actor, requestId: req() }, repo,
    )).toEqual({ ok: true, vehicleId: added.vehicleId, isActive: true })
    // Reactivated, not duplicated: still one row for A.
    expect(await vehiclesOf(a.userId)).toHaveLength(1)
  })

  it('refuses to retire a car with an unfinished reservation, and says how many', async () => {
    const a = await create(`${TAG}有預約`, phone())
    expect(a.ok).toBe(true)
    if (!a.ok) return
    const added = await svc.addMemberVehicle(
      { userId: a.userId, licensePlate: `${TAG}9002`, actor, requestId: req() },
      repo,
    )
    expect(added.ok).toBe(true)
    if (!added.ok) return

    await sb.from('reservations').insert({
      weekly_event_id: eventId,
      user_id: a.userId,
      vehicle_id: added.vehicleId,
      effective_priority: 3,
      status: 'pending',
    }).throwOnError()

    const requestId = randomUUID()
    const refused = await svc.setMemberVehicleActive(
      { vehicleId: added.vehicleId, isActive: false, actor, requestId },
      repo,
    )
    // The count is the actionable part: it tells the operator what they must go and settle.
    expect(refused).toEqual({ ok: false, reason: 'unfinished_reservations', unfinished: 1 })
    expect(await auditFor(requestId)).toMatchObject([{ action: 'vehicle.deactivate', result: 'denied' }])
    expect((await vehiclesOf(a.userId))[0]).toMatchObject({ is_active: true })

    // A terminal reservation is no obstacle — the car's week is over.
    await sb.from('reservations')
      .update({ status: 'cancelled_by_user', cancelled_at: new Date().toISOString() })
      .eq('vehicle_id', added.vehicleId)
      .throwOnError()
    expect(await svc.setMemberVehicleActive(
      { vehicleId: added.vehicleId, isActive: false, actor, requestId: req() }, repo,
    )).toMatchObject({ ok: true, isActive: false })
    // A second deactivation is inert, and typed as such.
    expect(await svc.setMemberVehicleActive(
      { vehicleId: added.vehicleId, isActive: false, actor, requestId: req() }, repo,
    )).toMatchObject({ ok: false, reason: 'already_inactive' })
  })

  it('the member detail carries retired rows too, with their ids, active first', async () => {
    const memberAdmin = await import('@/server/services/memberAdminService')
    const a = await create(`${TAG}車史`, phone())
    expect(a.ok).toBe(true)
    if (!a.ok) return
    const old = await svc.addMemberVehicle(
      { userId: a.userId, licensePlate: `${TAG}9003`, actor, requestId: req() }, repo,
    )
    expect(old.ok).toBe(true)
    if (!old.ok) return
    await svc.setMemberVehicleActive(
      { vehicleId: old.vehicleId, isActive: false, actor, requestId: req() }, repo,
    )
    const current = await svc.addMemberVehicle(
      { userId: a.userId, licensePlate: `${TAG}9004`, actor, requestId: req() }, repo,
    )
    expect(current.ok).toBe(true)
    if (!current.ok) return

    const detail = await memberAdmin.getMemberDetail(a.userId, repo)
    // Retired rows are visible, not filtered away: "never had it" and "sold it" are
    // different answers, and the reactivate path needs the row.
    expect(detail?.vehicles).toEqual([
      { id: current.vehicleId, plate: `${TAG}9004`, nickname: null, isActive: true },
      { id: old.vehicleId, plate: `${TAG}9003`, nickname: null, isActive: false },
    ])
  })

  it('a disabled acting admin is refused and the refusal is audited', async () => {
    const { data: gone } = await sb
      .from('admin_accounts')
      .insert({ username: `maint-${TAG.toLowerCase()}-off`, password_hash: 'scrypt$notarealhash', role: 'clerk' })
      .select('id')
      .single()
      .throwOnError()
    const offId = (gone as { id: string }).id
    await sb.from('admin_accounts')
      .update({ disabled_at: new Date().toISOString() }).eq('id', offId).throwOnError()

    const requestId = randomUUID()
    const result = await svc.createMember(
      {
        displayName: `${TAG}不該存在`,
        phone: phone(),
        confirmedCandidateIds: null,
        actor: { actorType: 'admin', actorId: offId, actorSessionId: randomUUID(), actorRoleSnapshot: null },
        requestId,
      },
      repo,
    )
    expect(result).toMatchObject({ ok: false, reason: 'acting_admin_disabled' })
    // A refusal by a disabled operator is exactly the kind of thing the log exists for.
    expect(await auditFor(requestId)).toMatchObject([{ action: 'member.create', result: 'denied' }])

    const { data: leaked } = await sb
      .from('users').select('id').eq('display_name', `${TAG}不該存在`)
    expect(leaked ?? []).toHaveLength(0)
    await sb.from('admin_accounts').delete().eq('id', offId)
  })

  it('bad input is refused WITHOUT an audit row — a rejected request is not an event', async () => {
    const before = await sb
      .from('audit_logs').select('id', { count: 'exact', head: true }).eq('action', 'member.create')
    const requestId = randomUUID()
    expect(await svc.createMember(
      { displayName: '   ', phone: phone(), confirmedCandidateIds: null, actor, requestId }, repo,
    )).toMatchObject({ ok: false, reason: 'invalid_name' })
    expect(await svc.createMember(
      { displayName: `${TAG}壞號`, phone: '12345', confirmedCandidateIds: null, actor, requestId: req() }, repo,
    )).toMatchObject({ ok: false, reason: 'invalid_phone' })

    expect(await auditFor(requestId)).toHaveLength(0)
    const after = await sb
      .from('audit_logs').select('id', { count: 'exact', head: true }).eq('action', 'member.create')
    expect(after.count).toBe(before.count)
  })
})
