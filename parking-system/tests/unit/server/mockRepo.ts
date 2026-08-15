import { vi } from 'vitest'
import type { ParkingRepository } from '@/server/repositories/parkingRepository'

// A ParkingRepository of vi.fn() spies with sensible defaults; override per test.
export type MockRepo = { [K in keyof ParkingRepository]: ReturnType<typeof vi.fn> }

export function makeMockRepo(overrides: Partial<MockRepo> = {}): MockRepo {
  const repo: MockRepo = {
    getWeeklyEvent: vi.fn(async () => ({ id: 'event-1', sunday_date: '2026-06-21', status: 'open' })),
    getActiveEvent: vi.fn(async () => ({ id: 'event-1', sunday_date: '2026-06-21', status: 'open' })),
    getWeeklyEventBySunday: vi.fn(async () => ({ id: 'event-1', sunday_date: '2026-06-21', status: 'open' })),
    getWaitingRank: vi.fn(async () => 1),
    listMembers: vi.fn(async () => ({ rows: [], total: 0 })),
    listMembersForExportPage: vi.fn(async () => []),
    logMemberRosterExport: vi.fn(async () => ({ ok: true })),
    getDbNow: vi.fn(async () => '2026-07-26T15:00:00.000000+00:00'),
    // Wave 2A-2 — audit timeline read. Empty by default: an empty log is the
    // graceful case, so tests that don't care stay unaffected.
    listAuditLogs: vi.fn(async () => ({ rows: [] })),
    // Wave 2B-1 (#14A) — capacity admin. Defaults describe the seed's shape post-fold
    // (23 total, 3 blocked, 0 admin_reserved, 1 reserved staff ⇒ 19 effective).
    getWeeklyCapacityAdmin: vi.fn(async () => ({
      id: 'event-1',
      sunday_date: '2026-06-21',
      status: 'open',
      total_capacity: 23,
      blocked_spaces: 3,
      admin_reserved: 0,
      capacity_version: 0,
      active_full_time_staff_reserved: 1,
    })),
    countPromisedReservations: vi.fn(async () => 0),
    // Wave 3 3e (#32) — overview supply + demand in one read. All-zero default: an empty
    // week is the graceful case, so tests that don't care stay unaffected.
    countWeekReservations: vi.fn(async () => ({
      promised: 0,
      pending: { total: 0, priority: 0, general: 0 },
      waiting: { total: 0, priority: 0, general: 0 },
    })),
    // #35 — pending/waiting drilldown. Empty by default, same reasoning as countWeekReservations.
    listWeekApplications: vi.fn(async () => []),
    setWeeklyCapacity: vi.fn(async () => ({
      ok: true, noop: false, effective_capacity: 19, promised_count: 0, capacity_version: 1,
    })),
    // Wave 2B-2b (#10) — the audited eligibility writes.
    setP2Eligibility: vi.fn(async () => ({ ok: true, noop: false, review_version: 1 })),
    markP2Reviewed: vi.fn(async () => ({ ok: true, review_version: 2 })),
    // Wave 1d (#27) — notification plate lookup. Empty by default: a payload with no plate is
    // the graceful case, so tests that don't care about it stay unaffected.
    getPlatesForReservations: vi.fn(async () => new Map<string, string>()),
    // Phase 9 Slice 1 — scheduler-facing upcoming event + idempotent ensure
    getUpcomingScheduledEvent: vi.fn(async () => ({ id: 'event-1', sunday_date: '2026-06-21', status: 'open' })),
    ensureWeeklyEvent: vi.fn(async () => ({
      created: true,
      event: { id: 'event-1', sunday_date: '2026-06-21', status: 'open' },
    })),
    finalizeWeeklyEvent: vi.fn(async () => {}),
    getStaleOpenEvents: vi.fn(async () => []),
    getStaffCheckInList: vi.fn(async () => []),
    createWalkInReservation: vi.fn(async () => ({
      row: {
        reservation_id: 'walkin-1',
        weekly_event_id: 'event-1',
        display_name: null,
        license_plate: null,
        walk_in_name: '現場散客',
        walk_in_license_plate: 'WALK-0001',
        is_priority: false,
        status: 'walk_in',
        attended_at: new Date('2026-06-21T02:00:00Z'),
      },
    })),
    getCapacityInputs: vi.fn(),
    getPendingForAllocation: vi.fn(async () => []),
    applyFridayAllocation: vi.fn(async () => ({ skipped: false, updated: 0, outbox_enqueued: 0 })),
    markJobFailed: vi.fn(async () => {}),
    getReservation: vi.fn(async () => null),
    getWaitingForSubstitution: vi.fn(async () => []),
    getExpiredOffers: vi.fn(async () => []),
    getTempApproved: vi.fn(async () => []),
    applyCancellation: vi.fn(async () => ({ cancelled: 1, substitute_applied: 1, outbox_enqueued: 1, cancel_notice_enqueued: 1 })),
    applyOffer: vi.fn(async () => ({ offered: 1, outbox_enqueued: 1 })),
    applyOfferResolution: vi.fn(async () => ({ resolved: 1, next_applied: 1, outbox_enqueued: 1, expired_blocked: false })),
    // Slice 3
    getReservationsForRelease: vi.fn(async () => []),
    getPenaltyCounters: vi.fn(async () => ({ penalty_score: 0, consecutive_no_show: 0, last_successful_attended_at: null })),
    getP2ArrivalReminderTargets: vi.fn(async () => []),
    applyRelease: vi.fn(async () => ({ released: 0, outbox_enqueued: 0, owner_notices_enqueued: 0 })),
    applyAttendance: vi.fn(async () => ({ attended: 1, penalty_updated: 1 })),
    setOnTheWay: vi.fn(async () => 1),
    enqueueOutbox: vi.fn(async () => 0),
    // Phase 4 Slice A — notification dispatcher
    claimOutbox: vi.fn(async () => []),
    markOutboxSent: vi.fn(async () => {}),
    markOutboxRetry: vi.fn(async () => {}),
    markOutboxFailed: vi.fn(async () => {}),
    // Phase 4 Slice C — outbox health
    getOutboxHealth: vi.fn(async () => ({
      due: 0, due_by_template: {}, pending: 0, retrying: 0, processing: 0, stale_processing: 0,
      failed: 0, failed_by_error: {}, sent_last_24h: 0,
      oldest_pending_at: null, oldest_due_at: null, oldest_failed_at: null, next_retry_at: null,
    })),
    // Phase 4 Slice F — dead-letter requeue
    requeueFailedOutbox: vi.fn(async () => ({ requeued: 0 })),
    // Phase 8 Slice 7 — binding PII retention
    redactDecidedBindingPii: vi.fn(async () => ({ count: 0, hasMore: false })),
    // Wave 2A-3 — audit retention purge
    purgeAuditLogs: vi.fn(async () => ({ count: 0, hasMore: false, deletedBefore: '2024-01-01T00:00:00+00:00', retentionMonths: 24 })),
    // Phase 5A — pending LINE binding capture
    capturePendingBinding: vi.fn(async () => ({ captured: 1, superseded: false })),
    // Phase 5B — approve / reject pending binding
    approvePendingBinding: vi.fn(async () => ({ approved: 1, would_approve: true, reason: 'approved' })),
    rejectPendingBinding: vi.fn(async () => ({ rejected: 1, reason: 'rejected' })),
    // Phase 5B Slice 2 — issue + approve preview
    insertBindingCode: vi.fn(async () => ({ inserted: true })),
    getUserDisplayName: vi.fn(async () => '王小明'),
    // Phase 7 Slice 2 — LIFF binding claim
    captureLiffBindingClaim: vi.fn(async () => ({ captured: 1, superseded: false })),
    listPendingBindings: vi.fn(async () => []),
    // Phase 6 — member import
    importMember: vi.fn(async () => ({ status: 'imported' as const, vehicles_added: 1, dependents_added: 0, plate_conflicts: [] })),
    getBindingApprovalPreview: vi.fn(async () => ({
      pending_status: 'pending',
      claim_source: 'keyword',
      line_user_id: 'Udeadbeefdeadbeefdeadbeefdeadbeef',
      submitted_code: 'ABCD-2345',
      claimed_phone: null,
      claimed_name: null,
      superseded_count: 0,
      last_submitted_at: '2026-07-05T00:00:00.000Z',
      matched_user_id: 'user-1',
      matched_display_name: '王小明',
    })),
    // Phase 4 Slice B — move-car
    getMoveCarTarget: vi.fn(async () => ({
      weekly_event_id: 'event-1',
      user_id: 'u1',
      status: 'attended' as const,
      license_plate: 'ABC-1234',
      notifiable: true,
    })),
    // Slice 4
    getReleasedLateForSettlement: vi.fn(async () => []),
    getPenaltyCountersForUsers: vi.fn(async () => []),
    applySettlement: vi.fn(async () => ({ settled: 0, penalties_applied: 0, alerts_created: 0 })),
    // Phase 8 Slice 8 — pastoral alert admin list + resolve
    listPastoralAlerts: vi.fn(async () => []),
    countOpenPastoralAlerts: vi.fn(async () => 0),
    resolvePastoralAlert: vi.fn(async () => ({ resolved: 1, reason: 'resolved' })),
    // Phase 3 v2 — Staff PIN session
    getStaffSessionByEvent: vi.fn(async () => null),
    getStaffSessionById: vi.fn(async () => null),
    resetStaffSessionFailures: vi.fn(async () => {}),
    applyStaffPinFailure: vi.fn(async () => ({ failed_attempts: 1, locked_at: null })),
    upsertStaffSessionPin: vi.fn(async () => {}),
    // Phase 7 Slice 1 — member LIFF auth + week status
    getUserByLineId: vi.fn(async () => ({ id: 'user-1', display_name: '王小明' })),
    createMemberSession: vi.fn(async () => {}),
    getMemberSessionByTokenHash: vi.fn(async () => null),
    deleteMemberSessionByTokenHash: vi.fn(async () => {}),
    deleteExpiredMemberSessions: vi.fn(async () => {}),
    // Phase 8 Slice 1 — admin accounts + sessions
    getAdminAccountByUsername: vi.fn(async () => null),
    insertAdminAccount: vi.fn(async () => ({ inserted: true })),
    resetAdminLoginFailures: vi.fn(async () => {}),
    applyAdminLoginFailure: vi.fn(async () => ({ failed_attempts: 1, locked_at: null })),
    createAdminSession: vi.fn(async () => {}),
    getAdminSessionByTokenHash: vi.fn(async () => null),
    deleteAdminSessionByTokenHash: vi.fn(async () => {}),
    deleteExpiredAdminSessions: vi.fn(async () => {}),
    // Phase 8 Slice 3 — admin account management
    getAdminAccountById: vi.fn(async () => null),
    listAdminAccounts: vi.fn(async () => []),
    setAdminDisabled: vi.fn(async () => ({ ok: true })),
    resetAdminPassword: vi.fn(async () => ({ ok: true, username: 'alice', disabled: false })),
    deleteAdminSessionsByAdminId: vi.fn(async () => ({ deleted: 0 })),
    // Wave 2C-2 — role management RPCs
    createAdminAccount: vi.fn(async () => ({
      ok: true, id: '11111111-1111-4111-8111-111111111111', username: 'alice',
      display_name: null, role: 'clerk', created_at: '2026-07-24T00:00:00Z',
      disabled_at: null, locked_at: null,
    })),
    setAdminRole: vi.fn(async () => ({ ok: true, changed: true, role: 'superadmin' })),
    revokeAdminSessions: vi.fn(async () => ({ ok: true, sessions_revoked: 0 })),
    getMemberEvent: vi.fn(async () => ({ id: 'event-1', sunday_date: '2026-06-21', status: 'open' })),
    getMemberWeekReservation: vi.fn(async () => null),
    // Phase 7 Slice 3 — member apply/cancel
    getMemberVehicles: vi.fn(async () => [{ id: '00000000-0000-4000-8000-000000000001', license_plate: 'ABC-1234', nickname: null }]),
    getMemberEligibility: vi.fn(async () => null),
    getUserRole: vi.fn(async () => 'user'),
    // Phase 8 Slice 2 — admin member search + detail
    searchMembers: vi.fn(async () => []),
    getMemberAdminDetail: vi.fn(async () => null),
    // Tier 0-2 (0038) — admin member maintenance. Defaults are the SUCCESS path; a test
    // that cares about a refusal overrides with the typed { ok: false, reason } the RPC
    // would actually return.
    createMember: vi.fn(async () => ({ ok: true, user_id: '00000000-0000-4000-8000-00000000e001' })),
    updateMemberIdentity: vi.fn(async () => ({ ok: true, changed: true, bindings_invalidated: 0 })),
    addMemberVehicle: vi.fn(async () => ({ ok: true, vehicle_id: '00000000-0000-4000-8000-00000000f001' })),
    setMemberVehicleActive: vi.fn(async () => ({ ok: true, vehicle_id: '00000000-0000-4000-8000-00000000f001', is_active: false })),
    // Phase 8 Slice 4 — P2 eligibility review
    listEligibilityReview: vi.fn(async () => []),
    listEligibilityTodoCandidates: vi.fn(async () => []),
    hasFridayAllocationRun: vi.fn(async () => false),
    applyReservation: vi.fn(async () => ({ applied: 1, reason: 'applied' })),
    claimFridayAllocation: vi.fn(async () => ({ claimed: true, reason: 'claimed' })),
    ...overrides,
  }
  return repo
}

// MockRepo is structurally a ParkingRepository; cast at the call site.
export const asRepo = (m: MockRepo): ParkingRepository => m as unknown as ParkingRepository
