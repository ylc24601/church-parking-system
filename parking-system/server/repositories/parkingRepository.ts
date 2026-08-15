import type { SupabaseClient } from '@supabase/supabase-js'
import type { AdminRole } from '@/lib/adminRoles'
import { getServiceClient } from '@/lib/supabase/server'
import {
  WEEK_DEMAND_STATUSES,
  summarizeWeekReservations,
  type WeekReservationCounts,
} from '@/lib/weekDemand'
import type { WeekApplicationRow } from '@/lib/weekApplications'
import type {
  EffectivePriority,
  Reservation,
  ReservationForAllocation,
  ReservationStatus,
  StaffCheckInRow,
} from '@/lib/types'

// ── Row / DTO shapes ─────────────────────────────────────────────────────────

export interface WeeklyEventRow {
  id: string
  sunday_date: string          // 'YYYY-MM-DD'
  status: string
}

// Phase 3 v2 — Staff PIN session. One shared credential row per weekly_event.
// pin_hash is service-side only and must NEVER reach any Staff DTO.
export interface StaffSessionRow {
  id: string
  weekly_event_id: string
  pin_hash: string
  expires_at: Date
  failed_attempts: number
  locked_at: Date | null
}

// Phase 7 Slice 2 — raw pending-claim row for the admin review queue. Contains raw
// code/phone/name: repo consumers must be the service layer, which masks them.
export interface PendingBindingListRow {
  id: string
  claim_source: string
  submitted_code: string | null
  claimed_phone: string | null
  claimed_name: string | null
  created_at: string
  last_submitted_at: string
  superseded_count: number
}

// Phase 7 Slice 1 — member LIFF session. The cookie token itself is never stored;
// token_hash is its sha256 (see server/http/sessionToken.ts).
export interface MemberSessionRow {
  id: string
  user_id: string
  expires_at: Date
}

// Phase 8 Slice 1 — Admin UI operator account. password_hash stays service-side
// (verifyPin); it must never be copied into any DTO or response.
export interface AdminAccountRow {
  id: string
  username: string
  password_hash: string
  failed_attempts: number
  locked_at: Date | null
  disabled_at: Date | null
  role: AdminRole
}

// Phase 8 Slice 1 — admin session joined with its account so the auth layer can kill
// live sessions of a disabled account on every request. Wave 2C-1 (#19) adds the role
// to that same join: it is re-read per request, so a demotion bites immediately.
export interface AdminSessionRow {
  id: string
  admin_id: string
  expires_at: Date
  username: string
  account_disabled_at: Date | null
  role: AdminRole
}

// Phase 8 Slice 3 — admin account list row. Deliberately omits password_hash and
// failed_attempts (the account-management UI never needs either).
export interface AdminAccountListRow {
  id: string
  username: string
  display_name: string | null
  locked_at: Date | null
  disabled_at: Date | null
  created_at: Date
  role: AdminRole
}

// Phase 8 Slice 2 — admin member search result (raw; the SERVICE masks phone before
// output). plates are the member's ACTIVE license plates only.
export interface MemberSearchRow {
  id: string
  display_name: string
  phone_number: string | null
  role: string
  line_id: string | null
  plates: string[]
}

// Wave 3 3d (#5B-a) — a roster row for the CSV export: MemberSearchRow plus the created_at
// the keyset pager uses as its cursor. created_at is the RAW string as returned by the DB;
// it is never round-tripped through Date (that truncates microseconds and would break the
// cursor at sub-millisecond timestamp ties).
export interface MemberExportRow extends MemberSearchRow {
  created_at: string
}

// Wave 2B-1 (#14A) — the editable capacity state of one week, plus the inputs the
// preview needs. admin_reserved is carried even though 0031 pins it to 0: it is still a
// term in computeCapacity, so passing it explicitly keeps the preview honest rather
// than assuming a constant.
export interface WeeklyCapacityAdminRow {
  id: string
  sunday_date: string
  status: string
  total_capacity: number
  blocked_spaces: number
  admin_reserved: number
  capacity_version: number
  active_full_time_staff_reserved: number
}

// Wave 2A-2 — one row of the audit timeline, exactly as the DB holds it.
// created_at is a RAW ISO string with microsecond precision, deliberately NOT a
// Date: it doubles as half of the keyset cursor, and Date truncates it (see the
// listAuditLogs comment). metadata_redacted stays `unknown` — only an action's own
// allowlisted renderer in auditPresentation may look inside it, and the view DTO
// never carries it.
export interface AuditLogRow {
  id: string
  created_at: string
  actor_type: 'admin' | 'staff_session' | 'member' | 'job' | 'system'
  actor_id: string | null
  actor_session_id: string | null
  actor_role_snapshot: string | null
  action: string
  entity_type: string
  entity_id: string | null
  weekly_event_id: string | null
  request_id: string
  result: 'success' | 'denied' | 'conflict'
  metadata_redacted: unknown
}

// Phase 8 Slice 2 — full admin member detail. Contains complete PII (phone/plates/
// eligibility/dependents); only the session-gated detail page renders it and the
// service DTO drops line_id in favour of a `bound` boolean.
export interface MemberAdminDetailRow {
  display_name: string
  phone_number: string | null
  role: string
  line_id: string | null
  // Tier 0-2 (0038): ALL rows, active and inactive, each with its id. The id is what the
  // maintenance actions target, and the inactive rows are not noise — they are the reason
  // `inactive_plate_exists` exists (reactivate the row rather than stack a second one) and
  // the record of who drove which car when. Consumers that only want the current cars
  // filter on is_active; nothing here decides that for them.
  vehicles: Array<{ id: string; license_plate: string; nickname: string | null; is_active: boolean }>
  eligibility: {
    p2_eligible: boolean
    p2_reason: string | null
    p2_valid_from: string | null
    p2_valid_until: string | null
    p2_review_date: string | null
    p2_child_birthdate: string | null
    review_status: string
    review_note: string | null
    review_version: number
    reviewed_at: string | null
  } | null
  dependents: Array<{ kind: string; name: string; birthdate: string | null }>
}

// Phase 8 Slice 4 — a P2-eligible member whose review/expiry date is at or before the
// review cutoff. No phone/dependents: the review LIST identifies by name and links to
// the detail page. The service computes dueDate = min(valid_until, review_date).
export interface EligibilityReviewRow {
  user_id: string
  display_name: string
  p2_reason: string | null
  p2_valid_from: string | null
  p2_valid_until: string | null
  p2_review_date: string | null
  reviewed_at: string | null
}

// Wave 3 (#8/#9) — MINIMAL projection for the todo badge count. Only the dates the
// classifier needs; NO display_name / reason / reviewed_at. The admin shell reads this
// on every load, so it must not pull P2 names/reasons just to produce a number.
export interface EligibilityTodoCandidate {
  user_id: string
  p2_valid_from: string | null
  p2_valid_until: string | null
  p2_review_date: string | null
}

// Phase 7 Slice 1 — the member's own reservation for one week, plate joined.
// Member-safe projection: own data only, no penalty/eligibility fields. `id`,
// `effective_priority` and `attended_at` are for server-side actions/affordance
// flags (cancel, offer, on-the-way) and must never be copied into a client DTO.
export interface MemberWeekReservationRow {
  id: string
  status: ReservationStatus
  effective_priority: number
  allocation_order: number | null // frozen Friday sort index; server-only (drives getWaitingRank)
  license_plate: string | null
  applied_at: Date
  attended_at: Date | null
  release_deadline_at: Date | null
  offer_expires_at: Date | null
  p2_on_the_way: boolean
}

// Phase 7 Slice 3 — a member's active vehicle for the apply form.
export interface MemberVehicleRow {
  id: string
  license_plate: string
  nickname: string | null
}

export interface CapacityInputs {
  weekly_event_id: string
  total_capacity: number
  blocked_spaces: number
  admin_reserved: number
  active_full_time_staff_reserved: number
}

// Payload rows handed to the apply_friday_allocation RPC.
export interface ReservationUpdate {
  id: string
  status: string
  allocation_order: number | null
  approved_at: string | null            // ISO
  release_deadline_at: string | null    // ISO
}

export interface OutboxRow {
  dedupe_key: string
  template_key: string
  user_id: string | null
  reservation_id: string | null
  payload: Record<string, unknown>
}

export interface ApplyResult {
  skipped: boolean
  updated?: number
  outbox_enqueued?: number
}

// Payload for promoting a waiting reservation into an offer / approval (sent to the
// apply_cancellation / apply_offer / apply_offer_resolution RPCs). All dates are ISO.
export interface SubstitutePayload {
  id: string
  status: 'temp_approved' | 'approved'
  offer_expires_at: string | null
  last_offer_at: string | null
  approved_at: string | null
  release_deadline_at: string | null
}

export interface CancellationResult {
  cancelled: number
  substitute_applied: number
  outbox_enqueued: number         // substitute-offer rows enqueued
  cancel_notice_enqueued: number  // confirmation rows enqueued to the cancelling member
}

export interface OfferResult {
  offered: number
  outbox_enqueued: number
}

export interface OfferResolutionResult {
  resolved: number
  next_applied: number
  outbox_enqueued: number
  // expiryGuard only: resolved=0 because the offer had expired (vs not temp_approved).
  expired_blocked: boolean
}

// Slice 3
export interface PenaltyCounters {
  penalty_score: number
  consecutive_no_show: number
  last_successful_attended_at: Date | null
}

export interface ReleaseResult {
  released: number
  outbox_enqueued: number        // broadcast_release rows enqueued (waiting users)
  owner_notices_enqueued: number // reservation_released rows enqueued (released owners)
}

// Penalty recovery payload for apply_attendance (null for walk-in). Dates are strings:
// last_successful_attended_at is a 'YYYY-MM-DD' (user_penalties stores a date).
export interface AttendancePenaltyPayload {
  user_id: string
  penalty_score: number
  consecutive_no_show: number
  last_successful_attended_at: string
}

export interface AttendanceResult {
  attended: number
  penalty_updated: number
}

// Slice 4
export interface SettlementPenaltyPayload {
  user_id: string
  penalty_score: number
  consecutive_no_show: number
  last_successful_attended_at: string | null   // 'YYYY-MM-DD' or null
}

export interface PastoralAlertPayload {
  user_id: string
  reason: 'consecutive_no_show'
  trigger_count: number
}

// Phase 8 Slice 8 — admin pastoral list row (sensitive; admin surface only). Carries the
// member's display name + counts + the resolution audit fields — never phone/line_id/plate.
export interface PastoralAlertRow {
  id: string
  user_id: string
  display_name: string
  reason: string
  trigger_count: number
  sunday_date: string
  status: 'open' | 'resolved'
  created_at: string
  resolved_at: string | null
  resolved_by_username: string | null
  counter_reset: boolean
  note: string | null
}

export interface SettlementResult {
  settled: number
  penalties_applied: number
  alerts_created: number
}

// Phase 4 Slice C — operation-safe aggregate health of notification_outbox (from the
// outbox_health RPC). Counts / notification-type names / sanitized error codes / timestamps
// only — no per-row or sensitive fields.
// The shape now lives in lib/opsAdminTypes so OpsDashboard (a Client Component) never
// imports this server-only module. Re-exported so existing server-side imports still work.
export type { OutboxHealth } from '@/lib/opsAdminTypes'
import type { OutboxHealth } from '@/lib/opsAdminTypes'

export interface RequeueFailedResult {
  requeued: number
}

// Phase 4 Slice A — a notification_outbox row claimed by the dispatcher (already flipped
// to 'processing' and leased). line_id is joined in the claim RPC (null if the recipient
// has no LINE binding → undeliverable). Sensitive fields never leave this shape.
export interface ClaimedOutboxRow {
  id: string
  template_key: string
  user_id: string | null
  line_id: string | null
  payload_json: Record<string, unknown>
  retry_count: number
  dedupe_key: string
}

// Phase 4 Slice B — server-side resolution for a move-car request. Projects `notifiable`
// (member has a line_id) rather than the line_id itself, and coalesces the plate so a walk-in
// still resolves. Raw line_id never leaves the repo; none of this is returned to Staff.
export interface MoveCarTarget {
  weekly_event_id: string
  user_id: string | null            // null for a walk-in → not notifiable
  status: ReservationStatus
  license_plate: string | null
  notifiable: boolean               // user_id present AND that user has a bound line_id
}

const parseDate = (v: string | null | undefined): Date | null => (v ? new Date(v) : null)

// Max ids per .in() lookup — see getPlatesForReservations.
const PLATE_LOOKUP_CHUNK = 100

// Reservation statuses surfaced on the Staff on-site check-in list (Phase 3).
export const STAFF_CHECKIN_STATUSES: ReservationStatus[] = [
  'approved',
  'released_late',
  'attended',
  'attended_after_release',
  'walk_in',
]

function rowToReservation(row: Record<string, unknown>): Reservation {
  return {
    id: row.id as string,
    weekly_event_id: row.weekly_event_id as string,
    user_id: (row.user_id as string | null) ?? null,
    vehicle_id: (row.vehicle_id as string | null) ?? null,
    requested_p2_this_week: row.requested_p2_this_week as boolean,
    effective_priority: row.effective_priority as EffectivePriority,
    status: row.status as Reservation['status'],
    offer_status: (row.offer_status as Reservation['offer_status']) ?? null,
    last_offer_at: parseDate(row.last_offer_at as string | null),
    offer_expires_at: parseDate(row.offer_expires_at as string | null),
    p2_on_the_way: row.p2_on_the_way as boolean,
    release_deadline_at: parseDate(row.release_deadline_at as string | null),
    allocation_order: (row.allocation_order as number | null) ?? null,
    applied_at: new Date(row.applied_at as string),
    approved_at: parseDate(row.approved_at as string | null),
    attended_at: parseDate(row.attended_at as string | null),
    released_at: parseDate(row.released_at as string | null),
    cancelled_at: parseDate(row.cancelled_at as string | null),
    finalized_at: parseDate(row.finalized_at as string | null),
    walk_in_name: (row.walk_in_name as string | null) ?? null,
    walk_in_license_plate: (row.walk_in_license_plate as string | null) ?? null,
    staff_note: (row.staff_note as string | null) ?? null,
    admin_note: (row.admin_note as string | null) ?? null,
  }
}

// staff_checkin_view rows are already privacy-projected (no sensitive columns to drop).
function rowToStaffCheckIn(row: Record<string, unknown>): StaffCheckInRow {
  return {
    reservation_id: row.reservation_id as string,
    weekly_event_id: row.weekly_event_id as string,
    display_name: (row.display_name as string | null) ?? null,
    license_plate: (row.license_plate as string | null) ?? null,
    walk_in_name: (row.walk_in_name as string | null) ?? null,
    walk_in_license_plate: (row.walk_in_license_plate as string | null) ?? null,
    is_priority: row.is_priority as boolean,
    status: row.status as ReservationStatus,
    attended_at: parseDate(row.attended_at as string | null),
    owner_notifiable: (row.owner_notifiable as boolean | null) ?? false,
  }
}

// Map a raw `reservations` row (a walk-in insert result) to the Staff-safe
// StaffCheckInRow whitelist. The raw row must never reach the client; this drops
// every sensitive column and exposes only name / plate / is_priority / status / time.
function rawReservationToStaffCheckIn(row: Record<string, unknown>): StaffCheckInRow {
  return {
    reservation_id: row.id as string,
    weekly_event_id: row.weekly_event_id as string,
    display_name: null,
    license_plate: null,
    walk_in_name: (row.walk_in_name as string | null) ?? null,
    walk_in_license_plate: (row.walk_in_license_plate as string | null) ?? null,
    is_priority: (row.effective_priority as number) <= 2,
    status: row.status as ReservationStatus,
    attended_at: parseDate(row.attended_at as string | null),
    owner_notifiable: false, // a walk-in has no member owner → never LINE-notifiable
  }
}

function rowToStaffSession(row: Record<string, unknown>): StaffSessionRow {
  return {
    id: row.id as string,
    weekly_event_id: row.weekly_event_id as string,
    pin_hash: row.pin_hash as string,
    expires_at: new Date(row.expires_at as string),
    failed_attempts: (row.failed_attempts as number | null) ?? 0,
    locked_at: parseDate(row.locked_at as string | null),
  }
}

function rowToReservationForAllocation(row: Record<string, unknown>): ReservationForAllocation {
  return {
    ...rowToReservation(row),
    penalty_score: (row.penalty_score as number | null) ?? 0,
    last_successful_attended_at: parseDate(row.last_successful_attended_at as string | null),
  }
}

// ── Repository ───────────────────────────────────────────────────────────────

export interface ParkingRepository {
  getWeeklyEvent(eventId: string): Promise<WeeklyEventRow>
  // Phase 3 Staff: the event the on-site page binds to. Stands in for the PIN
  // session's weekly_event_id until real Staff auth lands. Latest non-finalized
  // Sunday; null if none exists.
  getActiveEvent(): Promise<WeeklyEventRow | null>
  // Phase 3 v2: resolve a weekly_event by its Sunday date (CLI PIN provisioning).
  getWeeklyEventBySunday(sunday: string): Promise<WeeklyEventRow | null>
  // Phase 9 Slice 1 — scheduler-facing "this week": smallest sunday_date >= todayTaipei
  // (any status), the same Taipei-calendar semantics as getMemberEvent, under a name the
  // job routes can share without implying member scope. NOT getActiveEvent (Staff-PIN
  // "latest non-finalized" — stale whenever last week was left unfinalized).
  getUpcomingScheduledEvent(todayTaipei: string): Promise<WeeklyEventRow | null>
  // Phase 9 Slice 1 — idempotent create-if-missing for one Sunday's weekly_event
  // (`on conflict (sunday_date) do nothing` via upsert+ignoreDuplicates, NOT a blanket
  // 23505 catch). Inserts sunday_date ONLY — capacity/blocked/admin_reserved/status take
  // their DB defaults — so an existing row, including admin-tuned capacity, is never
  // modified. created=false when the row already existed.
  ensureWeeklyEvent(sundayDate: string): Promise<{ created: boolean; event: WeeklyEventRow }>
  // Phase 3 v2: close the week after settlement (status → 'finalized'). Idempotent
  // status-guarded write; a finalized event blocks all Staff writes.
  finalizeWeeklyEvent(eventId: string): Promise<void>
  // Phase 3 v2: operational fallback. Past weeks still 'open' (Staff forgot to
  // settle/finalize). cutoff is an exclusive YYYY-MM-DD boundary derived by the
  // caller from now − grace days; returns oldest-first.
  getStaleOpenEvents(cutoff: string): Promise<WeeklyEventRow[]>
  // Phase 3 Staff: privacy-projected check-in list for an event (reads
  // staff_checkin_view — never the raw reservations/penalty tables).
  getStaffCheckInList(eventId: string): Promise<StaffCheckInRow[]>
  // Phase 3 v2: create a walk-in reservation (status='walk_in', present now).
  // Returns the Staff-safe row, or { duplicate } on the walk_in unique-index race.
  createWalkInReservation(
    eventId: string,
    plate: string,
    name: string | null,
    nowIso: string,
  ): Promise<{ row: StaffCheckInRow } | { duplicate: true }>
  getCapacityInputs(eventId: string): Promise<CapacityInputs>
  getPendingForAllocation(eventId: string): Promise<ReservationForAllocation[]>
  applyFridayAllocation(
    eventId: string,
    jobType: string,
    reservations: ReservationUpdate[],
    outbox: OutboxRow[],
  ): Promise<ApplyResult>
  markJobFailed(eventId: string, jobType: string, message: string): Promise<void>
  // Slice 2
  getReservation(id: string): Promise<Reservation | null>
  getWaitingForSubstitution(eventId: string): Promise<Reservation[]>
  // Wave 1d (#27) — plates for a set of reservations, keyed by reservation id, for the
  // notification payload. Walk-ins and reservations whose vehicle is gone are simply absent
  // from the map (they get no notification / no plate line). Decoration only: the CALLER
  // (server/services/notification/context) decides that a failure here must not fail the
  // operation being announced, so this still throws like every other read.
  getPlatesForReservations(ids: string[]): Promise<Map<string, string>>
  // genuine 2-hour expiries: due (offer_expires_at <= now) AND strictly before the
  // Sunday-midnight cap (rows capped at midnight belong to the auto-approve sweep).
  getExpiredOffers(eventId: string, nowIso: string, sundayMidnightIso: string): Promise<Reservation[]>
  getTempApproved(eventId: string): Promise<Reservation[]>
  applyCancellation(args: {
    eventId: string
    cancelId: string
    cancelStatus: string
    expectStatus: string
    nowIso: string
    substitute: SubstitutePayload | null
    outbox: OutboxRow[]
    cancelNotice: OutboxRow[]   // confirmation to the cancelling member (enqueued iff cancel fires)
  }): Promise<CancellationResult>
  applyOffer(eventId: string, substitute: SubstitutePayload, outbox: OutboxRow[]): Promise<OfferResult>
  applyOfferResolution(args: {
    eventId: string
    offerId: string
    outcome: 'confirmed' | 'expired' | 'declined'
    nowIso: string
    approved: { approved_at: string; release_deadline_at: string } | null
    next: SubstitutePayload | null
    outbox: OutboxRow[]
    // member path only: refuse confirm/decline once offer_expires_at <= now, inside
    // the atomic write. Ops sweeps omit it (auto-approve confirms past the cap).
    expiryGuard?: boolean
  }): Promise<OfferResolutionResult>
  // Slice 3
  getReservationsForRelease(eventId: string): Promise<Reservation[]>
  getPenaltyCounters(userId: string): Promise<PenaltyCounters>
  getP2ArrivalReminderTargets(eventId: string): Promise<Reservation[]>
  applyRelease(
    eventId: string,
    nowIso: string,
    broadcast: OutboxRow[],
    ownerNotices: OutboxRow[],
  ): Promise<ReleaseResult>
  applyAttendance(args: {
    eventId: string
    reservationId: string
    targetStatus: 'attended' | 'attended_after_release'
    nowIso: string
    penalty: AttendancePenaltyPayload | null
  }): Promise<AttendanceResult>
  // Sets p2_on_the_way + extends release_deadline_at, but only while the current deadline
  // has not yet passed (release_deadline_at >= now) and the row is still an unattended P2.
  setOnTheWay(reservationId: string, nowIso: string, releaseDeadlineIso: string): Promise<number>
  enqueueOutbox(eventId: string, rows: OutboxRow[]): Promise<number>
  // Phase 4 Slice A — notification dispatcher. claimOutbox atomically leases up to `limit`
  // due rows to `worker` (flip to 'processing'); the mark* writes are the terminal
  // transitions, each guarded on BOTH status='processing' AND locked_by=worker so a row
  // reclaimed after lease expiry is never finalized by its previous owner. last_error holds
  // a sanitized classification code only — never a raw LINE body, message text, or line_id.
  claimOutbox(worker: string, nowIso: string, limit: number, leaseSeconds: number): Promise<ClaimedOutboxRow[]>
  markOutboxSent(id: string, worker: string, sentAtIso: string): Promise<void>
  markOutboxRetry(id: string, worker: string, nextRetryAtIso: string, retryCount: number, lastErrorCode: string): Promise<void>
  markOutboxFailed(id: string, worker: string, lastErrorCode: string): Promise<void>
  // Phase 4 Slice C — operation-safe aggregate health (dryRun preview + ops visibility).
  getOutboxHealth(nowIso: string, leaseSeconds: number): Promise<OutboxHealth>
  // Phase 4 Slice F — manual-only dead-letter recovery: failed → pending (bounded, optional filter).
  requeueFailedOutbox(nowIso: string, max: number, errorCode: string | null): Promise<RequeueFailedResult>
  // Phase 8 Slice 7 — PII retention: clear claimed_phone/claimed_name/submitted_code on rows
  // decided >= retentionDays ago (bounded, idempotent; dry-run probes max+1 rows for hasMore).
  redactDecidedBindingPii(nowIso: string, retentionDays: number, max: number, dryRun: boolean): Promise<{ count: number; hasMore: boolean }>
  // Wave 2A-3 (#15) — audit retention: delete audit_logs older than retentionMonths (bounded,
  // one batch; the RPC's clock is the DB's, so NO nowIso here). deletedBefore/retentionMonths
  // come straight from the RPC (the service can't recompute the DB cutoff). Never via JS Date.
  purgeAuditLogs(
    retentionMonths: number, max: number, dryRun: boolean, requestId: string,
  ): Promise<{ count: number; hasMore: boolean; deletedBefore: string; retentionMonths: number }>
  // Phase 4 Slice B — resolve a move-car target (owner user_id + plate + notifiability).
  // Returns null only when the reservation id doesn't exist (a walk-in still resolves).
  getMoveCarTarget(reservationId: string): Promise<MoveCarTarget | null>
  // Phase 5A — capture a pending LINE binding claim (upserts the member's active pending row).
  // Never writes users.line_id; the returned value is counts-only (no userId / code).
  capturePendingBinding(args: {
    lineUserId: string
    code: string
    eventType: string
    nowIso: string
  }): Promise<{ captured: number; superseded: boolean }>
  // Phase 5B — approve/reject a captured pending binding. Addressed BY pending id; the raw
  // line_user_id / submitted_code never cross this surface. Results are typed + counts-only.
  // Phase 7 Slice 2: expectedSupersededCount is the revision the admin previewed (bumped on every
  // capture upsert — a caller-supplied timestamp could collide) — REQUIRED for an apply
  // (mismatch → 'pending_changed'); pass null/omit for a dry-run.
  // Phase 8 Slice 1: adminId (Admin-UI decider, from the session — never from a request
  // body) lands in pending_binding.decided_by_admin_id; CLI callers omit it → null.
  approvePendingBinding(args: {
    pendingId: string
    nowIso: string
    dryRun: boolean
    expectedSupersededCount?: number | null
    adminId?: string | null
  }): Promise<{ approved: number; would_approve: boolean; reason: string }>
  // Phase 7 Slice 2 — verified-identity LIFF claim capture (upsert of the account's active
  // pending row). Counts-only; the claim payload never comes back.
  captureLiffBindingClaim(args: {
    lineUserId: string
    phone: string
    name: string
    nowIso: string
  }): Promise<{ captured: number; superseded: boolean }>
  // Phase 7 Slice 2 — raw pending-claim rows for the admin list (FIFO by last_submitted_at).
  // The SERVICE masks code/phone before output; raw values never leave the service layer.
  listPendingBindings(limit: number): Promise<PendingBindingListRow[]>
  rejectPendingBinding(args: {
    pendingId: string
    reason: string
    nowIso: string
    adminId?: string | null
  }): Promise<{ rejected: number; reason: string }>
  // Phase 5B Slice 2 — issue a binding code. `inserted:false` iff the code already exists (unique
  // conflict) so the caller can regenerate; other DB errors throw.
  insertBindingCode(args: {
    code: string
    userId: string
    expiresAtIso: string
    createdBy?: string | null
    note?: string | null
  }): Promise<{ inserted: boolean }>
  // Phase 5B Slice 2 — resolve a member's display name (issue validation + confirmation). Null if
  // the user id doesn't exist.
  getUserDisplayName(userId: string): Promise<string | null>
  // Phase 6 — atomic upsert of one member (by phone) + vehicles + eligibility + dependents. Typed,
  // dry-run aware. line_id is never touched.
  importMember(args: {
    name: string
    phone: string
    plates: string[]
    reason: string | null // null = general (P1/P3) roster member: user+vehicles only, no eligibility
    validUntil: string | null
    reviewDate: string | null
    dependents: Array<{ kind: string; name: string; birthdate: string | null }>
    dryRun: boolean
  }): Promise<{
    status: 'imported' | 'updated' | 'phone_name_conflict'
    // Tier 0-2 (0038) — which KIND of conflict, under the status an old client already
    // knows. 'phone_name_mismatch' is the original one (this phone belongs to someone with
    // another name); 'identity_candidate' is the new identity guard: the phone is unknown
    // but the name already belongs to somebody, so creating a second users.id would split
    // one person in two. Optional because a pre-0038 database does not send it.
    conflict_kind?: 'phone_name_mismatch' | 'identity_candidate'
    existing_name?: string          // phone_name_mismatch only
    candidates?: Array<{            // identity_candidate only
      id: string
      phone: string | null
      evidence: 'same_name' | 'same_name_and_plate'
    }>
    vehicles_added?: number
    dependents_added?: number
    plate_conflicts?: string[]
    retained_p2?: boolean // null-reason import landed on a member who already had P2 (kept, not revoked)
    // A P2 row in the CSV landed on a member a 幹事 had explicitly REVOKED. The row is left
    // untouched: an audited human decision outranks a bulk roster (0032). Reported, never silent.
    retained_revoked?: boolean
    // A P2 row landed on a member whose eligibility a 幹事 hand-maintains (reviewed_at is not
    // null). Frozen and reported for the same reason — import may establish an eligibility
    // nobody decided on, never overwrite one somebody did (0033).
    retained_governed?: boolean
  }>
  // Wave 2B-2b (#10) — the audited eligibility writes. Both return typed refusals; a throw
  // here means the RPC itself failed and nothing (including the audit row) was written.
  setP2Eligibility(args: {
    userId: string; expectedVersion: number; reviewStatus: 'approved' | 'revoked'
    reason: string | null; validFrom: string | null; validUntil: string | null
    childBirthdate: string | null; nextReviewDate: string | null; note: string | null
    actingAdminId: string; actingSessionId: string; requestId: string
  }): Promise<{ ok: boolean; reason?: string; noop?: boolean; review_version?: number; actual_version?: number }>
  markP2Reviewed(args: {
    userId: string; expectedVersion: number; nextReviewDate: string
    actingAdminId: string; actingSessionId: string; requestId: string
  }): Promise<{ ok: boolean; reason?: string; review_version?: number; actual_version?: number }>
  // Phase 5B Slice 2 — raw fields for the approve preview (the SERVICE masks them before output;
  // they are never printed/logged raw). Returns null only when the pending id doesn't exist.
  // Phase 7 Slice 2: also carries the claim source/fields + superseded_count (the optimistic-
  // concurrency revision; last_submitted_at is display/audit only); liff claims resolve the
  // matched member by canonical phone.
  getBindingApprovalPreview(pendingId: string): Promise<{
    pending_status: string
    claim_source: string
    line_user_id: string
    submitted_code: string | null
    claimed_phone: string | null
    claimed_name: string | null
    superseded_count: number
    last_submitted_at: string
    matched_user_id: string | null
    matched_display_name: string | null
  } | null>
  // Slice 4
  getReleasedLateForSettlement(eventId: string): Promise<Reservation[]>
  getPenaltyCountersForUsers(userIds: string[]): Promise<Array<{ user_id: string } & PenaltyCounters>>
  applySettlement(args: {
    eventId: string
    nowIso: string
    penalties: SettlementPenaltyPayload[]
    alerts: PastoralAlertPayload[]
  }): Promise<SettlementResult>
  // Phase 8 Slice 8 — pastoral alert admin list + atomic resolve (sensitive: admin surface
  // only, never Staff). Embeds users (inner — FK-guaranteed) and the resolving admin
  // (left — null when unresolved / account gone); the CURRENT consecutive counter is a
  // separate getPenaltyCountersForUsers lookup in the service, so a missing user_penalties
  // row can never drop an alert from the list.
  listPastoralAlerts(status: 'open' | 'resolved', limit: number): Promise<PastoralAlertRow[]>
  // Wave 3 (#9) — head count of open alerts for the admin overview / sidebar badge.
  // A pure count (unlike the P2 badge): "open" is a flat status filter with no
  // date precedence to reproduce, so there is nothing to keep in sync in TS.
  countOpenPastoralAlerts(): Promise<number>
  resolvePastoralAlert(args: {
    alertId: string
    adminId: string
    note: string | null
    resetCounter: boolean
    nowIso: string
  }): Promise<{ resolved: number; reason: string }>
  // Phase 3 v2 — Staff PIN session (staff_sessions). pin_hash stays service-side.
  getStaffSessionByEvent(eventId: string): Promise<StaffSessionRow | null>
  getStaffSessionById(id: string): Promise<StaffSessionRow | null>
  resetStaffSessionFailures(id: string): Promise<void>
  applyStaffPinFailure(id: string, threshold: number): Promise<{ failed_attempts: number; locked_at: Date | null }>
  upsertStaffSessionPin(args: {
    eventId: string
    pinHash: string
    expiresAt: string          // ISO
    createdBy?: string | null
    createdByAdminId?: string | null   // Phase 8 Slice 8 — Admin-UI issuance audit
  }): Promise<void>
  // Phase 7 Slice 1 — member LIFF auth + read-only week status. Raw line_id never
  // leaves the repo surface beyond this lookup's input.
  getUserByLineId(lineUserId: string): Promise<{ id: string; display_name: string } | null>
  createMemberSession(args: { userId: string; tokenHash: string; expiresAt: string }): Promise<void>
  getMemberSessionByTokenHash(tokenHash: string): Promise<MemberSessionRow | null>
  deleteMemberSessionByTokenHash(tokenHash: string): Promise<void>
  // Lazy cleanup at login: drop the member's already-expired session rows.
  deleteExpiredMemberSessions(userId: string, nowIso: string): Promise<void>
  // Phase 8 Slice 1 — Admin UI accounts + sessions (admin_accounts / admin_sessions).
  // password_hash never leaves the service layer; session lookups join the account so
  // disabled_at can evict live sessions.
  getAdminAccountByUsername(username: string): Promise<AdminAccountRow | null>
  // `inserted:false` iff the username already exists (unique conflict); other errors throw.
  // role is required rather than defaulted: the column defaults to the least-privileged
  // value, so a caller that silently omitted it would create a clerk while believing
  // otherwise. The one caller today is the CLI, which always provisions a superadmin.
  insertAdminAccount(args: {
    username: string
    passwordHash: string
    displayName?: string | null
    role: AdminRole
  }): Promise<{ inserted: boolean }>
  resetAdminLoginFailures(id: string): Promise<void>
  // Atomic lock-cycle counter (apply_admin_login_failure, 0025): active lock → no-op,
  // expired lock → new round at 1, else increment; threshold sets locked_at = now.
  applyAdminLoginFailure(args: {
    id: string
    nowIso: string
    threshold: number
    lockMinutes: number
  }): Promise<{ failed_attempts: number; locked_at: Date | null }>
  createAdminSession(args: { adminId: string; tokenHash: string; expiresAt: string }): Promise<void>
  getAdminSessionByTokenHash(tokenHash: string): Promise<AdminSessionRow | null>
  deleteAdminSessionByTokenHash(tokenHash: string): Promise<void>
  deleteExpiredAdminSessions(adminId: string, nowIso: string): Promise<void>
  // Phase 8 Slice 3 — admin account management. The two state-changing operations
  // below wrap single atomic RPCs (0026): see that migration for why a sequence of
  // separate repo calls is not safe here (partial-failure session/credential
  // inconsistency on an offboarding security surface).
  // Wave 2B-1 (#14A) — the admin capacity card. Capacity columns reach the app ONLY
  // via v_weekly_capacity_inputs today (WeeklyEventRow is just {id, sunday_date,
  // status}), and that view has no capacity_version/status, so this reads the base
  // table for the editable fields and the view supplies reserved_staff.
  getWeeklyCapacityAdmin(sunday: string): Promise<WeeklyCapacityAdminRow | null>
  // Seats already promised for an event. temp_approved is included deliberately: it is
  // a held seat, not a pending one (0006:26-36 promotes a waiting row straight into it,
  // and apply_offer_resolution later flips it to approved with no capacity check).
  countPromisedReservations(eventId: string): Promise<number>
  // Wave 3 3e (#32) — the overview's supply AND demand numbers in one read: promised
  // (approved + temp_approved), plus pending / waiting split by frozen effective_priority.
  //
  // One select over the event's live rows, counted in the app: PostgREST has no group-by,
  // and the alternatives are worse — an RPC for two numbers, or three head-counts that can
  // disagree with each other. Volume is this week's reservations (dozens).
  //
  // Bound worth knowing: rows, not an exact count, so PostgREST's max_rows (1000, see
  // supabase/config.toml) caps it — unlike the head-count above. One week would need 1000
  // live reservations against ~20 seats to reach that, so it is recorded rather than
  // guarded; a slice that ever makes it plausible has to revisit this.
  //
  // Deliberately NOT folded into countPromisedReservations: that one is still the capacity
  // page's promised read path (capacityAdminService), and widening its return type would
  // push this change into a page this slice does not touch.
  countWeekReservations(eventId: string): Promise<WeekReservationCounts>
  // #35 — this week's pending/waiting applications, named-row detail (the drilldown
  // #32's 申請中/候補 counts link into). Deliberately its own read, not a widening of
  // countWeekReservations: that one stays counts-only for the overview, this one carries
  // PII (name/plate) and is gated to its own force-dynamic page. member_shape (0002:80-81)
  // guarantees every non-walk_in row has both user_id and vehicle_id, so the join never
  // needs a walk-in fallback the way getMoveCarTarget's does.
  //
  // Same row bound as countWeekReservations: rows rather than a count, so PostgREST's
  // max_rows (1000) caps it. One week would need 1000 live reservations against ~20 seats
  // to reach that, so it is recorded rather than guarded — but note the failure mode here
  // is a silently SHORT list, so a slice that makes the volume plausible must add paging.
  // Ordering is applied in the DB for determinism; splitWeekApplications is still the
  // authority on presentation order (and on waitingRank, which depends on it).
  listWeekApplications(eventId: string): Promise<WeekApplicationRow[]>
  // Wraps set_weekly_capacity (0031): locks the event row, guards, and writes the audit
  // row in the SAME transaction. Refusals come back as typed reasons, never throws.
  setWeeklyCapacity(args: {
    eventId: string
    sunday: string
    totalCapacity: number
    blockedSpaces: number
    expectedVersion: number
    actingAdminId: string
    actingSessionId: string
    requestId: string
  }): Promise<{
    ok: boolean
    reason?: string
    noop?: boolean
    effective_capacity?: number
    promised_count?: number
    capacity_version?: number
    actual_version?: number
  }>
  getAdminAccountById(id: string): Promise<AdminAccountRow | null>
  listAdminAccounts(): Promise<AdminAccountListRow[]>
  // Wave 2A-2 — the audit timeline's only read path (SELECT is the only privilege
  // the app has on this table; 0030 revoked the rest).
  //
  // Keyset, not offset: audit_logs is append-only and read newest-first, so every
  // insert lands at the TOP and would shift every offset page beneath it — a
  // duplicate across the page boundary is the systematic case, not a race.
  // `before` is the exclusive cursor: strictly older than (created_at, id).
  //
  // created_at is returned as the RAW PostgREST string and MUST stay that way — it
  // carries microseconds (…T01:31:40.355854+00:00) that a JS Date round-trip
  // silently truncates to milliseconds, after which the cursor's equality arm
  // matches nothing and rows are skipped. Do not parseDate() this one.
  listAuditLogs(args: {
    limit: number
    before?: { createdAt: string; id: string }
  }): Promise<{ rows: AuditLogRow[] }>
  // Wraps set_admin_disabled (0026): atomic self-guard + last-active invariant
  // (when disabling) + session revoke (on BOTH disable and enable — re-enabling
  // also forces re-login so a missed session-delete during a prior disable can't
  // let a stale cookie come back to life).
  // The actor/requestId pair is not bookkeeping: 0030's RPC writes the audit row
  // inside this same transaction, so the change and its log commit or roll back
  // together. There is deliberately no insertAuditLog() on this interface — its
  // existence would invite a second, non-atomic write after the mutation.
  setAdminDisabled(args: {
    targetId: string
    actingAdminId: string
    actingSessionId: string
    disabled: boolean
    nowIso: string
    requestId: string
  }): Promise<{ ok: boolean; reason?: string }>
  // Wraps reset_admin_password (0026, audited + role-guarded in 0035): atomic hash
  // update + failed_attempts/locked_at clear + session revoke. Receives only the
  // already-hashed password; never sees or returns plaintext. Leaves disabled_at
  // untouched. Same actor/requestId contract as setAdminDisabled above.
  resetAdminPassword(args: {
    targetId: string
    actingAdminId: string
    actingSessionId: string
    passwordHash: string
    requestId: string
  }): Promise<{ ok: boolean; reason?: string; username?: string; disabled?: boolean }>
  // Single-table, single-statement — already atomic without an RPC.
  deleteAdminSessionsByAdminId(id: string): Promise<{ deleted: number }>
  // Wave 2C-2 (#19) account-management RPCs (0036). Same actor/session/requestId
  // contract as setAdminDisabled: each writes its audit row inside the transaction, so
  // a partial failure is impossible and the caller must not build metadata or write a
  // second row. The role is resolved and authorised inside the RPC — never trusted from
  // the app.
  createAdminAccount(args: {
    username: string
    passwordHash: string
    displayName: string | null
    role: AdminRole
    actingAdminId: string
    actingSessionId: string
    requestId: string
  }): Promise<{
    ok: boolean
    reason?: string
    id?: string
    username?: string
    display_name?: string | null
    role?: string
    created_at?: string
    disabled_at?: string | null
    locked_at?: string | null
  }>
  setAdminRole(args: {
    targetId: string
    role: AdminRole
    actingAdminId: string
    actingSessionId: string
    requestId: string
  }): Promise<{ ok: boolean; reason?: string; changed?: boolean; role?: string }>
  revokeAdminSessions(args: {
    targetId: string
    actingAdminId: string
    actingSessionId: string
    requestId: string
  }): Promise<{ ok: boolean; reason?: string; sessions_revoked?: number }>
  // ── Tier 0-2 (0038): admin member maintenance ────────────────────────────────
  // Four audited SECURITY DEFINER RPCs, same actor/requestId contract as the account
  // ones above: each writes its own audit row inside its transaction, so a throw here
  // means nothing was written at all — never report success on a caught error.
  //
  // Every refusal is a TYPED return, never an exception: a raise would roll back the very
  // audit row recording the refusal. A 23505 must never surface — each RPC catches it,
  // re-reads, and answers with a reason.
  //
  // The member is always addressed by users.id. Nothing in this group looks a member up
  // by phone: phone_number is a mutable attribute, and treating it as identity across
  // time is exactly what 0038 exists to stop.
  createMember(args: {
    displayName: string
    phone: string
    actingAdminId: string
    actingSessionId: string
    requestId: string
    // null = "I have not been shown the homonyms yet" → the RPC answers with the candidate
    // set instead of writing. An ARRAY (including an empty one) = "I saw exactly these and
    // they are different people". The comparison is a SET comparison, so it fails closed if
    // the roster changed between the prompt and the confirmation.
    confirmedCandidateIds: string[] | null
  }): Promise<{
    ok: boolean
    reason?: string
    user_id?: string
    candidates?: Array<{ id: string; phone: string | null; evidence: 'same_name' }>
  }>
  updateMemberIdentity(args: {
    userId: string
    displayName: string
    phone: string
    actingAdminId: string
    actingSessionId: string
    requestId: string
    // The decision timestamp for any binding claims this change invalidates — passed in
    // rather than defaulted in SQL so the rejection time is the app's single clock.
    nowIso: string
  }): Promise<{ ok: boolean; reason?: string; changed?: boolean; bindings_invalidated?: number }>
  addMemberVehicle(args: {
    userId: string
    licensePlate: string
    actingAdminId: string
    actingSessionId: string
    requestId: string
    // vehicle_id accompanies 'inactive_plate_exists': this member already owns the plate in
    // history, so the answer is to reactivate THAT row, not to create a second one.
  }): Promise<{ ok: boolean; reason?: string; vehicle_id?: string }>
  setMemberVehicleActive(args: {
    vehicleId: string
    isActive: boolean
    actingAdminId: string
    actingSessionId: string
    requestId: string
    // `unfinished` accompanies 'unfinished_reservations' — how many live reservations still
    // reference the car. Checked under the vehicle's row lock, not in the UI.
  }): Promise<{ ok: boolean; reason?: string; vehicle_id?: string; is_active?: boolean; unfinished?: number }>
  // The member-facing "this week": smallest sunday_date >= todayTaipei (any status),
  // NOT getActiveEvent's "latest non-finalized" (that is Staff-PIN semantics and
  // points wrong once future weeks are pre-created).
  getMemberEvent(todayTaipei: string): Promise<WeeklyEventRow | null>
  // The member's own reservation for one event; the live row wins over cancelled
  // ones (the one-active-per-member index allows cancelled siblings).
  getMemberWeekReservation(userId: string, eventId: string): Promise<MemberWeekReservationRow | null>
  // Wave 1b (#29) — a waiting member's LIVE 1-based queue position: how many still-waiting
  // rows sit ahead of allocationOrder, +1. Counts ONLY 'waiting' — someone holding an offer
  // (temp_approved) is not queueing right now, but failOffer returns them to waiting with
  // their original allocation_order, so a rank can go UP. The UI says so; it is not a ticket
  // number. Returns a count only — never another member's identity.
  getWaitingRank(eventId: string, allocationOrder: number): Promise<number>
  // Phase 7 Slice 3 — member apply/cancel.
  getMemberVehicles(userId: string): Promise<MemberVehicleRow[]>
  // Sensitive: eligibility stays server-side; only derived bits (priority, companion
  // hint) may reach the client.
  getMemberEligibility(userId: string): Promise<{
    p2_eligible: boolean
    p2_reason: string | null
    p2_valid_from: string | null
    p2_valid_until: string | null
  } | null>
  getUserRole(userId: string): Promise<string | null>
  // Phase 8 Slice 2 — admin member search. The service pre-splits/cleans the raw query
  // into three OPTIONAL cleaned branches (null = skip that branch); this method runs
  // only the non-null ones (each capped), merges distinct users, attaches ACTIVE plates,
  // and returns a stable-sorted list. Masking happens in the service.
  searchMembers(args: {
    nameQuery: string | null
    phoneQuery: string | null
    plateQuery: string | null
    candidateCap: number
  }): Promise<MemberSearchRow[]>
  // Wave 1c (#5A) — one page of the whole roster, for browsing without a query. Ordered IN THE DB
  // by (display_name, id): a total order is what makes offset paging correct — searchMembers sorts
  // in JS after fetching, which cannot page. Masking happens in the service, same as search.
  listMembers(args: { limit: number; offset: number }): Promise<{ rows: MemberSearchRow[]; total: number }>
  // Wave 3 3d (#5B-a) — one keyset page of the roster for the CSV export. Unlike listMembers'
  // offset paging (which can dup/skip a member if the roster mutates mid-export), this pages by
  // the IMMUTABLE (created_at, id) cursor with a created_at < createdBefore cutoff, so a
  // concurrent insert can neither shift the window nor appear in this export. afterCreatedAt/
  // afterId null = first page. Ordered (created_at, id); the service re-sorts for display.
  listMembersForExportPage(args: {
    createdBefore: string
    afterCreatedAt: string | null
    afterId: string | null
    limit: number
  }): Promise<MemberExportRow[]>
  // Wave 3 3d (#5B-a) — DB-authoritative gate + audit for a roster export (0037). Re-reads the
  // acting admin FOR SHARE and appends the audit row only if still an active superadmin; denied
  // paths write nothing (a refused export leaks no PII). ok:false → route maps to 403.
  logMemberRosterExport(args: {
    actingAdminId: string
    actingSessionId: string
    requestId: string
    rowCount: number
  }): Promise<{ ok: boolean; reason?: string }>
  // Wave 3 3d (#5B-a) — the DB clock (0037 db_now), so the export cutoff is on the same clock
  // as users.created_at rather than the app host's. Returns the raw ISO string.
  getDbNow(): Promise<string>
  // Phase 8 Slice 2 — full admin member detail (raw PII). Null if the user doesn't exist.
  getMemberAdminDetail(userId: string): Promise<MemberAdminDetailRow | null>
  // Phase 8 Slice 4 — P2-eligible members due for review at/before cutoffDate. Runs TWO
  // date-ordered branches (by review_date, by valid_until), each capped, and merges them
  // distinct by user_id. A single .or() with an unordered limit could drop the most-urgent
  // rows; two ordered branches keep the earliest of each date. The service computes the
  // effective dueDate = min(valid_until, review_date), does the final global sort, and slices.
  listEligibilityReview(args: { cutoffDate: string; branchCap: number }): Promise<EligibilityReviewRow[]>
  // Wave 3 (#8/#9) — SUPERSET of "due for review today": p2_eligible rows whose
  // valid_until < asOf OR review_date <= asOf. The DB filter only narrows the candidate
  // set; deriveEligibilityStatus in the service is the sole authority for the final
  // expired/review_due count (no second business truth). Paginated to completion, so the
  // count is EXACT — unlike listEligibilityReview, it has no display cap. pageSize is
  // injectable purely so tests can exercise the pagination loop without seeding 1k rows.
  listEligibilityTodoCandidates(asOfDate: string, pageSize?: number): Promise<EligibilityTodoCandidate[]>
  // Apply window: closed once the Friday allocation job has claimed the event
  // ('running' or 'success' — rows inserted mid-run would miss the batch).
  hasFridayAllocationRun(eventId: string): Promise<boolean>
  // Atomic member apply (RPC): typed, never throws for business states.
  applyReservation(args: {
    eventId: string
    userId: string
    vehicleId: string
    requestedP2: boolean
    effectivePriority: 2 | 3
    nowIso: string
  }): Promise<{ applied: number; reason: string }>
  // Claim the event's allocation run UNDER the weekly_events row lock (the allocator's
  // half of the apply-window protocol) — must COMMIT before the pending snapshot is read.
  claimFridayAllocation(eventId: string, jobType: string): Promise<{ claimed: boolean; reason: string }>
}

export function createParkingRepository(
  client: SupabaseClient = getServiceClient(),
): ParkingRepository {
  // Shared weekly_events lookups — single query source for the method pairs below
  // (getWeeklyEventBySunday/ensureWeeklyEvent and getMemberEvent/getUpcomingScheduledEvent)
  // so their semantics can never drift.
  async function weeklyEventBySunday(sunday: string): Promise<WeeklyEventRow | null> {
    const { data, error } = await client
      .from('weekly_events')
      .select('id, sunday_date, status')
      .eq('sunday_date', sunday)
      .maybeSingle()
    if (error) throw new Error(`getWeeklyEventBySunday failed: ${error.message}`)
    return (data as WeeklyEventRow | null) ?? null
  }

  async function upcomingScheduledEvent(todayTaipei: string): Promise<WeeklyEventRow | null> {
    const { data, error } = await client
      .from('weekly_events')
      .select('id, sunday_date, status')
      .gte('sunday_date', todayTaipei)
      .order('sunday_date', { ascending: true })
      .limit(1)
      .maybeSingle()
    if (error) throw new Error(`getUpcomingScheduledEvent failed: ${error.message}`)
    return (data as WeeklyEventRow | null) ?? null
  }

  // Shared active-plate attach for the roster reads (listMembers + the export pager), so the
  // is_active filter and (created_at, id) plate order can't drift between browse and export.
  // Chunked by PLATE_LOOKUP_CHUNK: .in() inlines every UUID into the request line, so a few
  // hundred ids (the export pages up to 200) would risk a 414 — the same reason the constant
  // exists. Each user's vehicles share its user_id, so a user falls entirely in one chunk and
  // its plate order is preserved.
  async function activePlatesByUser(idList: string[]): Promise<Map<string, string[]>> {
    const byUser = new Map<string, string[]>()
    for (let i = 0; i < idList.length; i += PLATE_LOOKUP_CHUNK) {
      const chunk = idList.slice(i, i + PLATE_LOOKUP_CHUNK)
      const { data, error } = await client
        .from('vehicles')
        .select('user_id, license_plate')
        .eq('is_active', true)
        .in('user_id', chunk)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
      if (error) throw new Error(`activePlatesByUser failed: ${error.message}`)
      for (const r of (data ?? []) as Array<{ user_id: string; license_plate: string }>) {
        const arr = byUser.get(r.user_id) ?? []
        arr.push(r.license_plate)
        byUser.set(r.user_id, arr)
      }
    }
    return byUser
  }

  return {
    async getWeeklyEvent(eventId) {
      const { data, error } = await client
        .from('weekly_events')
        .select('id, sunday_date, status')
        .eq('id', eventId)
        .single()
      if (error) throw new Error(`getWeeklyEvent failed: ${error.message}`)
      return data as WeeklyEventRow
    },

    async getActiveEvent() {
      const { data, error } = await client
        .from('weekly_events')
        .select('id, sunday_date, status')
        .neq('status', 'finalized')
        .order('sunday_date', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (error) throw new Error(`getActiveEvent failed: ${error.message}`)
      return (data as WeeklyEventRow | null) ?? null
    },

    async getWeeklyEventBySunday(sunday) {
      return weeklyEventBySunday(sunday)
    },

    async getUpcomingScheduledEvent(todayTaipei) {
      return upcomingScheduledEvent(todayTaipei)
    },

    async ensureWeeklyEvent(sundayDate) {
      const { data, error } = await client
        .from('weekly_events')
        .upsert(
          { sunday_date: sundayDate },
          { onConflict: 'sunday_date', ignoreDuplicates: true },
        )
        .select('id, sunday_date, status')
        .maybeSingle()
      if (error) throw new Error(`ensureWeeklyEvent failed: ${error.message}`)
      if (data) return { created: true, event: data as WeeklyEventRow }
      // Conflict path: the row already existed (do-nothing returns no row) — read it back.
      const existing = await weeklyEventBySunday(sundayDate)
      if (!existing) {
        throw new Error(`ensureWeeklyEvent failed: conflict but no row for ${sundayDate}`)
      }
      return { created: false, event: existing }
    },

    async finalizeWeeklyEvent(eventId) {
      const { error } = await client
        .from('weekly_events')
        .update({ status: 'finalized' })
        .eq('id', eventId)
        .neq('status', 'finalized')
      if (error) throw new Error(`finalizeWeeklyEvent failed: ${error.message}`)
    },

    async getStaleOpenEvents(cutoff) {
      const { data, error } = await client
        .from('weekly_events')
        .select('id, sunday_date, status')
        .eq('status', 'open')
        .lt('sunday_date', cutoff)
        .order('sunday_date', { ascending: true })
      if (error) throw new Error(`getStaleOpenEvents failed: ${error.message}`)
      return (data as WeeklyEventRow[]) ?? []
    },

    async getStaffCheckInList(eventId) {
      // Only statuses that need on-site handling: a held seat (approved), a
      // released seat still open to late back-fill (released_late), or an
      // already-present car (attended / after-release / walk-in). waiting /
      // pending / no_show / cancelled_* are not actionable at the entrance.
      // Stable, Staff-safe order: not-yet-arrived (attended_at null) on top, then
      // checked-in / walk-in newest→oldest. Keeps a freshly added walk-in near the
      // top after reload and partly delivers the "未點到置頂" feedback (full sort = P1.5).
      const { data, error } = await client
        .from('staff_checkin_view')
        .select('*')
        .eq('weekly_event_id', eventId)
        .in('status', STAFF_CHECKIN_STATUSES)
        .order('attended_at', { ascending: false, nullsFirst: true })
        .order('reservation_id', { ascending: true })
      if (error) throw new Error(`getStaffCheckInList failed: ${error.message}`)
      return (data ?? []).map(rowToStaffCheckIn)
    },

    async createWalkInReservation(eventId, plate, name, nowIso) {
      // walk-in semantics: on-site registration of a car that is present now → P3,
      // attended_at set. The walk_in unique index (0009) is the race backstop;
      // cross-list dedupe (incl. member plates) is handled in walkInService.
      const { data, error } = await client
        .from('reservations')
        .insert({
          weekly_event_id: eventId,
          status: 'walk_in',
          walk_in_license_plate: plate,
          walk_in_name: name,
          effective_priority: 3,
          applied_at: nowIso,
          attended_at: nowIso,
        })
        .select('id, weekly_event_id, walk_in_name, walk_in_license_plate, effective_priority, status, attended_at')
        .single()
      if (error) {
        if (error.code === '23505') return { duplicate: true }
        throw new Error(`createWalkInReservation failed: ${error.message}`)
      }
      return { row: rawReservationToStaffCheckIn(data) }
    },

    async getCapacityInputs(eventId) {
      const { data, error } = await client
        .from('v_weekly_capacity_inputs')
        .select('*')
        .eq('weekly_event_id', eventId)
        .single()
      if (error) throw new Error(`getCapacityInputs failed: ${error.message}`)
      return data as CapacityInputs
    },

    async getPendingForAllocation(eventId) {
      const { data, error } = await client
        .from('v_reservations_for_allocation')
        .select('*')
        .eq('weekly_event_id', eventId)
        .eq('status', 'pending')
      if (error) throw new Error(`getPendingForAllocation failed: ${error.message}`)
      return (data ?? []).map(rowToReservationForAllocation)
    },

    async applyFridayAllocation(eventId, jobType, reservations, outbox) {
      const { data, error } = await client.rpc('apply_friday_allocation', {
        p_event_id: eventId,
        p_job_type: jobType,
        p_reservations: reservations,
        p_outbox: outbox,
      })
      if (error) throw new Error(`apply_friday_allocation failed: ${error.message}`)
      return data as ApplyResult
    },

    async markJobFailed(eventId, jobType, message) {
      const { error } = await client.from('job_runs').upsert(
        {
          weekly_event_id: eventId,
          job_type: jobType,
          status: 'failed',
          finished_at: new Date().toISOString(),
          error_message: message,
        },
        { onConflict: 'weekly_event_id,job_type' },
      )
      if (error) throw new Error(`markJobFailed failed: ${error.message}`)
    },

    // ── Slice 2 ────────────────────────────────────────────────────────────────
    async getReservation(id) {
      const { data, error } = await client.from('reservations').select('*').eq('id', id).maybeSingle()
      if (error) throw new Error(`getReservation failed: ${error.message}`)
      return data ? rowToReservation(data) : null
    },

    async getPlatesForReservations(ids) {
      const out = new Map<string, string>()
      if (ids.length === 0) return out
      // Chunked: a Friday allocation can enqueue hundreds of rows, and .in() serializes every
      // uuid into the query string (~37 chars each) — a few hundred would push the URL past
      // the request-line limit and 414. 100 is the batch size listMembers already proves.
      for (let i = 0; i < ids.length; i += PLATE_LOOKUP_CHUNK) {
        const chunk = ids.slice(i, i + PLATE_LOOKUP_CHUNK)
        const { data, error } = await client
          .from('reservations')
          .select('id, vehicles(license_plate)')
          .in('id', chunk)
        if (error) throw new Error(`getPlatesForReservations failed: ${error.message}`)
        for (const row of (data ?? []) as Array<Record<string, unknown>>) {
          // The composite FK (vehicle_id, user_id) → vehicles(id, user_id) can surface the embed
          // as an object or a one-element array; getMoveCarTarget handles both the same way.
          const v = row.vehicles as
            | { license_plate: string | null }
            | Array<{ license_plate: string | null }>
            | null
          const plate = (Array.isArray(v) ? v[0] : v)?.license_plate
          if (plate) out.set(row.id as string, plate)
        }
      }
      return out
    },

    async getWaitingForSubstitution(eventId) {
      const { data, error } = await client
        .from('reservations')
        .select('*')
        .eq('weekly_event_id', eventId)
        .eq('status', 'waiting')
        .order('allocation_order', { ascending: true })
      if (error) throw new Error(`getWaitingForSubstitution failed: ${error.message}`)
      return (data ?? []).map(rowToReservation)
    },

    async getExpiredOffers(eventId, nowIso, sundayMidnightIso) {
      const { data, error } = await client
        .from('reservations')
        .select('*')
        .eq('weekly_event_id', eventId)
        .eq('status', 'temp_approved')
        .lte('offer_expires_at', nowIso)
        .lt('offer_expires_at', sundayMidnightIso)
      if (error) throw new Error(`getExpiredOffers failed: ${error.message}`)
      return (data ?? []).map(rowToReservation)
    },

    async getTempApproved(eventId) {
      const { data, error } = await client
        .from('reservations')
        .select('*')
        .eq('weekly_event_id', eventId)
        .eq('status', 'temp_approved')
      if (error) throw new Error(`getTempApproved failed: ${error.message}`)
      return (data ?? []).map(rowToReservation)
    },

    async applyCancellation(args) {
      const { data, error } = await client.rpc('apply_cancellation', {
        p_event_id: args.eventId,
        p_cancel_id: args.cancelId,
        p_cancel_status: args.cancelStatus,
        p_expect_status: args.expectStatus,
        p_now: args.nowIso,
        p_substitute: args.substitute,
        p_outbox: args.outbox,
        p_cancel_notice: args.cancelNotice,
      })
      if (error) throw new Error(`apply_cancellation failed: ${error.message}`)
      return data as CancellationResult
    },

    async applyOffer(eventId, substitute, outbox) {
      const { data, error } = await client.rpc('apply_offer', {
        p_event_id: eventId,
        p_substitute: substitute,
        p_outbox: outbox,
      })
      if (error) throw new Error(`apply_offer failed: ${error.message}`)
      return data as OfferResult
    },

    async applyOfferResolution(args) {
      const { data, error } = await client.rpc('apply_offer_resolution', {
        p_event_id: args.eventId,
        p_offer_id: args.offerId,
        p_outcome: args.outcome,
        p_now: args.nowIso,
        p_approved: args.approved,
        p_next: args.next,
        p_outbox: args.outbox,
        p_expiry_guard: args.expiryGuard ?? false,
      })
      if (error) throw new Error(`apply_offer_resolution failed: ${error.message}`)
      return data as OfferResolutionResult
    },

    // ── Slice 3 ──────────────────────────────────────────────────────────────────
    async getReservationsForRelease(eventId) {
      const { data, error } = await client
        .from('reservations')
        .select('*')
        .eq('weekly_event_id', eventId)
        .in('status', ['approved', 'waiting'])
      if (error) throw new Error(`getReservationsForRelease failed: ${error.message}`)
      return (data ?? []).map(rowToReservation)
    },

    async getPenaltyCounters(userId) {
      const { data, error } = await client
        .from('user_penalties')
        .select('penalty_score, consecutive_no_show, last_successful_attended_at')
        .eq('user_id', userId)
        .maybeSingle()
      if (error) throw new Error(`getPenaltyCounters failed: ${error.message}`)
      return {
        penalty_score: (data?.penalty_score as number | undefined) ?? 0,
        consecutive_no_show: (data?.consecutive_no_show as number | undefined) ?? 0,
        last_successful_attended_at: parseDate(data?.last_successful_attended_at as string | null),
      }
    },

    async getP2ArrivalReminderTargets(eventId) {
      const { data, error } = await client
        .from('reservations')
        .select('*')
        .eq('weekly_event_id', eventId)
        .eq('status', 'approved')
        .eq('effective_priority', 2)
        .eq('p2_on_the_way', false)
        .is('attended_at', null)
      if (error) throw new Error(`getP2ArrivalReminderTargets failed: ${error.message}`)
      return (data ?? []).map(rowToReservation)
    },

    async applyRelease(eventId, nowIso, broadcast, ownerNotices) {
      const { data, error } = await client.rpc('apply_release', {
        p_event_id: eventId,
        p_now: nowIso,
        p_broadcast: broadcast,
        p_owner_notices: ownerNotices,
      })
      if (error) throw new Error(`apply_release failed: ${error.message}`)
      return data as ReleaseResult
    },

    async applyAttendance(args) {
      const { data, error } = await client.rpc('apply_attendance', {
        p_event_id: args.eventId,
        p_reservation_id: args.reservationId,
        p_target_status: args.targetStatus,
        p_now: args.nowIso,
        p_penalty: args.penalty,
      })
      if (error) throw new Error(`apply_attendance failed: ${error.message}`)
      return data as AttendanceResult
    },

    async setOnTheWay(reservationId, nowIso, releaseDeadlineIso) {
      const { data, error } = await client
        .from('reservations')
        .update({ p2_on_the_way: true, release_deadline_at: releaseDeadlineIso })
        .eq('id', reservationId)
        .eq('status', 'approved')
        .eq('effective_priority', 2)
        .eq('p2_on_the_way', false)
        .is('attended_at', null)
        .gte('release_deadline_at', nowIso)
        .select('id')
      if (error) throw new Error(`setOnTheWay failed: ${error.message}`)
      return (data ?? []).length
    },

    async enqueueOutbox(eventId, rows) {
      if (rows.length === 0) return 0
      const payload = rows.map(r => ({
        dedupe_key: r.dedupe_key,
        template_key: r.template_key,
        user_id: r.user_id,
        reservation_id: r.reservation_id,
        weekly_event_id: eventId,
        payload_json: r.payload,
      }))
      const { data, error } = await client
        .from('notification_outbox')
        .upsert(payload, { onConflict: 'dedupe_key', ignoreDuplicates: true })
        .select('id')
      if (error) throw new Error(`enqueueOutbox failed: ${error.message}`)
      return (data ?? []).length
    },

    // ── Phase 4 Slice A: notification dispatcher ───────────────────────────────
    async claimOutbox(worker, nowIso, limit, leaseSeconds) {
      const { data, error } = await client.rpc('claim_notification_outbox', {
        p_worker: worker,
        p_now: nowIso,
        p_limit: limit,
        p_lease_seconds: leaseSeconds,
      })
      if (error) throw new Error(`claim_notification_outbox failed: ${error.message}`)
      return ((data ?? []) as Record<string, unknown>[]).map(r => ({
        id: r.id as string,
        template_key: r.template_key as string,
        user_id: (r.user_id as string | null) ?? null,
        line_id: (r.line_id as string | null) ?? null,
        payload_json: (r.payload_json as Record<string, unknown> | null) ?? {},
        retry_count: (r.retry_count as number | null) ?? 0,
        dedupe_key: r.dedupe_key as string,
      }))
    },

    async markOutboxSent(id, worker, sentAtIso) {
      const { error } = await client
        .from('notification_outbox')
        .update({ status: 'sent', sent_at: sentAtIso, locked_at: null, locked_by: null, last_error: null })
        .eq('id', id)
        .eq('status', 'processing')
        .eq('locked_by', worker)
      if (error) throw new Error(`markOutboxSent failed: ${error.message}`)
    },

    async markOutboxRetry(id, worker, nextRetryAtIso, retryCount, lastErrorCode) {
      const { error } = await client
        .from('notification_outbox')
        .update({
          status: 'retrying',
          next_retry_at: nextRetryAtIso,
          retry_count: retryCount,
          locked_at: null,
          locked_by: null,
          last_error: lastErrorCode,
        })
        .eq('id', id)
        .eq('status', 'processing')
        .eq('locked_by', worker)
      if (error) throw new Error(`markOutboxRetry failed: ${error.message}`)
    },

    async markOutboxFailed(id, worker, lastErrorCode) {
      const { error } = await client
        .from('notification_outbox')
        .update({ status: 'failed', locked_at: null, locked_by: null, last_error: lastErrorCode })
        .eq('id', id)
        .eq('status', 'processing')
        .eq('locked_by', worker)
      if (error) throw new Error(`markOutboxFailed failed: ${error.message}`)
    },

    async getOutboxHealth(nowIso, leaseSeconds) {
      const { data, error } = await client.rpc('outbox_health', {
        p_now: nowIso,
        p_lease_seconds: leaseSeconds,
      })
      if (error) throw new Error(`outbox_health failed: ${error.message}`)
      return data as OutboxHealth
    },

    async requeueFailedOutbox(nowIso, max, errorCode) {
      const { data, error } = await client.rpc('requeue_failed_outbox', {
        p_now: nowIso,
        p_max: max,
        p_error_code: errorCode,
      })
      if (error) throw new Error(`requeue_failed_outbox failed: ${error.message}`)
      return data as RequeueFailedResult
    },

    async redactDecidedBindingPii(nowIso, retentionDays, max, dryRun) {
      const { data, error } = await client.rpc('redact_decided_binding_pii', {
        p_now: nowIso,
        p_retention_days: retentionDays,
        p_max: max,
        p_dry_run: dryRun,
      })
      if (error) throw new Error(`redact_decided_binding_pii failed: ${error.message}`)
      const row = data as { count: number; has_more: boolean }
      return { count: row.count, hasMore: row.has_more }
    },

    async purgeAuditLogs(retentionMonths, max, dryRun, requestId) {
      const { data, error } = await client.rpc('purge_audit_logs', {
        p_retention_months: retentionMonths,
        p_max: max,
        p_dry_run: dryRun,
        p_request_id: requestId,
      })
      if (error) throw new Error(`purge_audit_logs failed: ${error.message}`)
      // deleted_before is already a text timestamp from SQL — kept as a string, never
      // parsed through Date (node-postgres would shift it; see the retention lessons).
      const row = data as { count: number; has_more: boolean; deleted_before: string; retention_months: number }
      return { count: row.count, hasMore: row.has_more, deletedBefore: row.deleted_before, retentionMonths: row.retention_months }
    },

    async capturePendingBinding({ lineUserId, code, eventType, nowIso }) {
      const { data, error } = await client.rpc('capture_pending_binding', {
        p_line_user_id: lineUserId,
        p_code: code,
        p_event_type: eventType,
        p_now: nowIso,
      })
      if (error) throw new Error(`capture_pending_binding failed: ${error.message}`)
      const row = data as { captured: number; superseded: boolean }
      return { captured: row.captured, superseded: row.superseded }
    },

    async approvePendingBinding({ pendingId, nowIso, dryRun, expectedSupersededCount, adminId }) {
      const { data, error } = await client.rpc('approve_pending_binding', {
        p_pending_id: pendingId,
        p_expected_superseded_count: expectedSupersededCount ?? null,
        p_now: nowIso,
        p_dry_run: dryRun,
        p_admin_id: adminId ?? null,
      })
      if (error) throw new Error(`approve_pending_binding failed: ${error.message}`)
      return data as { approved: number; would_approve: boolean; reason: string }
    },

    async captureLiffBindingClaim({ lineUserId, phone, name, nowIso }) {
      const { data, error } = await client.rpc('capture_liff_binding_claim', {
        p_line_user_id: lineUserId,
        p_phone: phone,
        p_name: name,
        p_now: nowIso,
      })
      // Sanitized: the message never echoes the claim payload (RPC params aren't in it).
      if (error) throw new Error(`capture_liff_binding_claim failed: ${error.message}`)
      const row = data as { captured: number; superseded: boolean }
      return { captured: row.captured, superseded: row.superseded }
    },

    async listPendingBindings(limit) {
      const { data, error } = await client
        .from('pending_binding')
        .select('id, claim_source, submitted_code, claimed_phone, claimed_name, created_at, last_submitted_at, superseded_count')
        .eq('status', 'pending')
        .order('last_submitted_at', { ascending: true })   // FIFO review queue
        .order('id', { ascending: true })
        .limit(limit)
      if (error) throw new Error(`listPendingBindings failed: ${error.message}`)
      return (data ?? []) as PendingBindingListRow[]
    },

    async rejectPendingBinding({ pendingId, reason, nowIso, adminId }) {
      const { data, error } = await client.rpc('reject_pending_binding', {
        p_pending_id: pendingId,
        p_reason: reason,
        p_now: nowIso,
        p_admin_id: adminId ?? null,
      })
      if (error) throw new Error(`reject_pending_binding failed: ${error.message}`)
      return data as { rejected: number; reason: string }
    },

    async insertBindingCode({ code, userId, expiresAtIso, createdBy = null, note = null }) {
      const { error } = await client.from('binding_codes').insert({
        code, user_id: userId, expires_at: expiresAtIso, created_by: createdBy, note,
      })
      if (error) {
        if (error.code === '23505') return { inserted: false } // unique code conflict → caller regenerates
        throw new Error(`insertBindingCode failed: ${error.message}`)
      }
      return { inserted: true }
    },

    async importMember({ name, phone, plates, reason, validUntil, reviewDate, dependents, dryRun }) {
      const { data, error } = await client.rpc('import_member', {
        p_name: name,
        p_phone: phone,
        p_plates: plates,
        p_reason: reason,
        p_valid_until: validUntil,
        p_review_date: reviewDate,
        p_dependents: dependents,
        p_dry_run: dryRun,
      })
      if (error) throw new Error(`import_member failed: ${error.message}`)
      return data as Awaited<ReturnType<ParkingRepository['importMember']>>
    },

    async setP2Eligibility(args) {
      const { data, error } = await client.rpc('set_p2_eligibility', {
        p_user_id: args.userId,
        p_expected_version: args.expectedVersion,
        p_review_status: args.reviewStatus,
        p_reason: args.reason,
        p_valid_from: args.validFrom,
        p_valid_until: args.validUntil,
        p_child_birthdate: args.childBirthdate,
        p_next_review_date: args.nextReviewDate,
        p_note: args.note,
        p_acting_admin_id: args.actingAdminId,
        p_acting_session_id: args.actingSessionId,
        p_request_id: args.requestId,
      })
      if (error) throw new Error(`set_p2_eligibility failed: ${error.message}`)
      return data as { ok: boolean; reason?: string; noop?: boolean; review_version?: number }
    },

    async markP2Reviewed(args) {
      const { data, error } = await client.rpc('mark_p2_reviewed', {
        p_user_id: args.userId,
        p_expected_version: args.expectedVersion,
        p_next_review_date: args.nextReviewDate,
        p_acting_admin_id: args.actingAdminId,
        p_acting_session_id: args.actingSessionId,
        p_request_id: args.requestId,
      })
      if (error) throw new Error(`mark_p2_reviewed failed: ${error.message}`)
      return data as { ok: boolean; reason?: string; review_version?: number }
    },

    async getUserDisplayName(userId) {
      const { data, error } = await client
        .from('users')
        .select('display_name')
        .eq('id', userId)
        .maybeSingle()
      if (error) throw new Error(`getUserDisplayName failed: ${error.message}`)
      return (data as { display_name: string } | null)?.display_name ?? null
    },

    async getBindingApprovalPreview(pendingId) {
      const { data: p, error: pe } = await client
        .from('pending_binding')
        .select('status, claim_source, line_user_id, submitted_code, claimed_phone, claimed_name, superseded_count, last_submitted_at')
        .eq('id', pendingId)
        .maybeSingle()
      if (pe) throw new Error(`getBindingApprovalPreview failed: ${pe.message}`)
      if (!p) return null
      const pending = p as {
        status: string
        claim_source: string
        line_user_id: string
        submitted_code: string | null
        claimed_phone: string | null
        claimed_name: string | null
        superseded_count: number
        last_submitted_at: string
      }

      // Resolve WHO would be bound, for the operator to confirm. keyword: via the issued code
      // (no FK between submitted_code and binding_codes). liff: via the canonical phone
      // (users_phone_key guarantees at most one member).
      let matchedUserId: string | null = null
      if (pending.claim_source === 'liff') {
        const { data: u, error: ue } = await client
          .from('users')
          .select('id')
          .eq('phone_number', pending.claimed_phone)
          .maybeSingle()
        if (ue) throw new Error(`getBindingApprovalPreview phone lookup failed: ${ue.message}`)
        matchedUserId = (u as { id: string } | null)?.id ?? null
      } else {
        const { data: c, error: ce } = await client
          .from('binding_codes')
          .select('user_id')
          .eq('code', pending.submitted_code)
          .maybeSingle()
        if (ce) throw new Error(`getBindingApprovalPreview code lookup failed: ${ce.message}`)
        matchedUserId = (c as { user_id: string } | null)?.user_id ?? null
      }

      let matchedDisplayName: string | null = null
      if (matchedUserId) {
        const { data: u, error: ue } = await client
          .from('users')
          .select('display_name')
          .eq('id', matchedUserId)
          .maybeSingle()
        if (ue) throw new Error(`getBindingApprovalPreview user lookup failed: ${ue.message}`)
        matchedDisplayName = (u as { display_name: string } | null)?.display_name ?? null
      }

      return {
        pending_status: pending.status,
        claim_source: pending.claim_source,
        line_user_id: pending.line_user_id,
        submitted_code: pending.submitted_code,
        claimed_phone: pending.claimed_phone,
        claimed_name: pending.claimed_name,
        superseded_count: pending.superseded_count,
        last_submitted_at: pending.last_submitted_at,
        matched_user_id: matchedUserId,
        matched_display_name: matchedDisplayName,
      }
    },

    async getMoveCarTarget(reservationId) {
      // Embed the owner (users) and vehicle via their FKs. line_id is read only to derive the
      // `notifiable` boolean here and is then discarded — it never leaves this function.
      const { data, error } = await client
        .from('reservations')
        .select('weekly_event_id, user_id, status, walk_in_license_plate, users(line_id), vehicles(license_plate)')
        .eq('id', reservationId)
        .maybeSingle()
      if (error) throw new Error(`getMoveCarTarget failed: ${error.message}`)
      if (!data) return null
      const row = data as Record<string, unknown>
      const u = row.users as { line_id: string | null } | Array<{ line_id: string | null }> | null
      const v = row.vehicles as { license_plate: string | null } | Array<{ license_plate: string | null }> | null
      const owner = Array.isArray(u) ? u[0] : u
      const vehicle = Array.isArray(v) ? v[0] : v
      const userId = (row.user_id as string | null) ?? null
      return {
        weekly_event_id: row.weekly_event_id as string,
        user_id: userId,
        status: row.status as ReservationStatus,
        license_plate: (vehicle?.license_plate ?? (row.walk_in_license_plate as string | null)) ?? null,
        notifiable: !!(userId && owner?.line_id),
      }
    },

    // ── Slice 4 ──────────────────────────────────────────────────────────────────
    async getReleasedLateForSettlement(eventId) {
      const { data, error } = await client
        .from('reservations')
        .select('*')
        .eq('weekly_event_id', eventId)
        .eq('status', 'released_late')
      if (error) throw new Error(`getReleasedLateForSettlement failed: ${error.message}`)
      return (data ?? []).map(rowToReservation)
    },

    async getPenaltyCountersForUsers(userIds) {
      if (userIds.length === 0) return []
      const { data, error } = await client
        .from('user_penalties')
        .select('user_id, penalty_score, consecutive_no_show, last_successful_attended_at')
        .in('user_id', userIds)
      if (error) throw new Error(`getPenaltyCountersForUsers failed: ${error.message}`)
      return (data ?? []).map(row => ({
        user_id: row.user_id as string,
        penalty_score: (row.penalty_score as number | null) ?? 0,
        consecutive_no_show: (row.consecutive_no_show as number | null) ?? 0,
        last_successful_attended_at: parseDate(row.last_successful_attended_at as string | null),
      }))
    },

    async applySettlement(args) {
      const { data, error } = await client.rpc('apply_settlement', {
        p_event_id: args.eventId,
        p_now: args.nowIso,
        p_penalties: args.penalties,
        p_alerts: args.alerts,
      })
      if (error) throw new Error(`apply_settlement failed: ${error.message}`)
      return data as SettlementResult
    },

    async listPastoralAlerts(status, limit) {
      const { data, error } = await client
        .from('pastoral_care_alerts')
        .select(
          'id, user_id, reason, trigger_count, status, created_at, resolved_at, counter_reset, note, ' +
          'users!user_id!inner(display_name), weekly_events!weekly_event_id!inner(sunday_date), ' +
          'admin_accounts(username)',
        )
        .eq('status', status)
        .order(status === 'open' ? 'created_at' : 'resolved_at', { ascending: status === 'open' })
        .limit(limit)
      if (error) throw new Error(`listPastoralAlerts failed: ${error.message}`)
      return (data ?? []).map(row => {
        const r = row as unknown as Record<string, unknown>
        const user = r.users as { display_name: string }
        const event = r.weekly_events as { sunday_date: string }
        const admin = r.admin_accounts as { username: string } | null
        return {
          id: r.id as string,
          user_id: r.user_id as string,
          display_name: user.display_name,
          reason: r.reason as string,
          trigger_count: r.trigger_count as number,
          sunday_date: event.sunday_date,
          status: r.status as 'open' | 'resolved',
          created_at: r.created_at as string,
          resolved_at: (r.resolved_at as string | null) ?? null,
          resolved_by_username: admin?.username ?? null,
          counter_reset: r.counter_reset as boolean,
          note: (r.note as string | null) ?? null,
        }
      })
    },

    async countOpenPastoralAlerts() {
      const { count, error } = await client
        .from('pastoral_care_alerts')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'open')
      if (error) throw new Error(`countOpenPastoralAlerts failed: ${error.message}`)
      if (count === null) throw new Error('countOpenPastoralAlerts failed: count unavailable')
      return count
    },

    async resolvePastoralAlert({ alertId, adminId, note, resetCounter, nowIso }) {
      const { data, error } = await client.rpc('resolve_pastoral_alert', {
        p_alert_id: alertId,
        p_admin_id: adminId,
        p_note: note,
        p_reset_counter: resetCounter,
        p_now: nowIso,
      })
      if (error) throw new Error(`resolve_pastoral_alert failed: ${error.message}`)
      return data as { resolved: number; reason: string }
    },

    async getStaffSessionByEvent(eventId) {
      const { data, error } = await client
        .from('staff_sessions')
        .select('id, weekly_event_id, pin_hash, expires_at, failed_attempts, locked_at')
        .eq('weekly_event_id', eventId)
        .maybeSingle()
      if (error) throw new Error(`getStaffSessionByEvent failed: ${error.message}`)
      return data ? rowToStaffSession(data) : null
    },

    async getStaffSessionById(id) {
      const { data, error } = await client
        .from('staff_sessions')
        .select('id, weekly_event_id, pin_hash, expires_at, failed_attempts, locked_at')
        .eq('id', id)
        .maybeSingle()
      if (error) throw new Error(`getStaffSessionById failed: ${error.message}`)
      return data ? rowToStaffSession(data) : null
    },

    async resetStaffSessionFailures(id) {
      const { error } = await client
        .from('staff_sessions')
        .update({ failed_attempts: 0, locked_at: null })
        .eq('id', id)
      if (error) throw new Error(`resetStaffSessionFailures failed: ${error.message}`)
    },

    async applyStaffPinFailure(id, threshold) {
      const { data, error } = await client.rpc('apply_staff_pin_failure', {
        p_id: id,
        p_threshold: threshold,
      })
      if (error) throw new Error(`apply_staff_pin_failure failed: ${error.message}`)
      const row = data as { failed_attempts: number; locked_at: string | null } | null
      return {
        failed_attempts: row?.failed_attempts ?? 0,
        locked_at: parseDate(row?.locked_at ?? null),
      }
    },

    async upsertStaffSessionPin(args) {
      const { error } = await client.from('staff_sessions').upsert(
        {
          weekly_event_id: args.eventId,
          pin_hash: args.pinHash,
          expires_at: args.expiresAt,
          failed_attempts: 0,
          locked_at: null,
          created_by: args.createdBy ?? null,
          created_by_admin_id: args.createdByAdminId ?? null,
        },
        { onConflict: 'weekly_event_id' },
      )
      if (error) throw new Error(`upsertStaffSessionPin failed: ${error.message}`)
    },

    async getUserByLineId(lineUserId) {
      const { data, error } = await client
        .from('users')
        .select('id, display_name')
        .eq('line_id', lineUserId)
        .maybeSingle()
      if (error) throw new Error(`getUserByLineId failed: ${error.message}`)
      return (data as { id: string; display_name: string } | null) ?? null
    },

    async createMemberSession(args) {
      const { error } = await client.from('member_sessions').insert({
        user_id: args.userId,
        token_hash: args.tokenHash,
        expires_at: args.expiresAt,
      })
      if (error) throw new Error(`createMemberSession failed: ${error.message}`)
    },

    async getMemberSessionByTokenHash(tokenHash) {
      const { data, error } = await client
        .from('member_sessions')
        .select('id, user_id, expires_at')
        .eq('token_hash', tokenHash)
        .maybeSingle()
      if (error) throw new Error(`getMemberSessionByTokenHash failed: ${error.message}`)
      if (!data) return null
      return {
        id: data.id as string,
        user_id: data.user_id as string,
        expires_at: new Date(data.expires_at as string),
      }
    },

    async deleteMemberSessionByTokenHash(tokenHash) {
      const { error } = await client.from('member_sessions').delete().eq('token_hash', tokenHash)
      if (error) throw new Error(`deleteMemberSessionByTokenHash failed: ${error.message}`)
    },

    async deleteExpiredMemberSessions(userId, nowIso) {
      const { error } = await client
        .from('member_sessions')
        .delete()
        .eq('user_id', userId)
        .lt('expires_at', nowIso)
      if (error) throw new Error(`deleteExpiredMemberSessions failed: ${error.message}`)
    },

    async getAdminAccountByUsername(username) {
      const { data, error } = await client
        .from('admin_accounts')
        .select('id, username, password_hash, failed_attempts, locked_at, disabled_at, role')
        .eq('username', username)
        .maybeSingle()
      if (error) throw new Error(`getAdminAccountByUsername failed: ${error.message}`)
      if (!data) return null
      return {
        id: data.id as string,
        username: data.username as string,
        password_hash: data.password_hash as string,
        failed_attempts: data.failed_attempts as number,
        locked_at: parseDate(data.locked_at as string | null),
        disabled_at: parseDate(data.disabled_at as string | null),
        role: data.role as AdminRole,
      }
    },

    async insertAdminAccount({ username, passwordHash, displayName = null, role }) {
      const { error } = await client.from('admin_accounts').insert({
        username,
        password_hash: passwordHash,
        display_name: displayName,
        role,
      })
      if (error) {
        if (error.code === '23505') return { inserted: false } // duplicate username → caller reports
        throw new Error(`insertAdminAccount failed: ${error.message}`)
      }
      return { inserted: true }
    },

    async resetAdminLoginFailures(id) {
      const { error } = await client
        .from('admin_accounts')
        .update({ failed_attempts: 0, locked_at: null })
        .eq('id', id)
      if (error) throw new Error(`resetAdminLoginFailures failed: ${error.message}`)
    },

    async applyAdminLoginFailure({ id, nowIso, threshold, lockMinutes }) {
      const { data, error } = await client.rpc('apply_admin_login_failure', {
        p_id: id,
        p_now: nowIso,
        p_threshold: threshold,
        p_lock_minutes: lockMinutes,
      })
      if (error) throw new Error(`apply_admin_login_failure failed: ${error.message}`)
      const row = data as { failed_attempts: number; locked_at: string | null } | null
      return {
        failed_attempts: row?.failed_attempts ?? 0,
        locked_at: parseDate(row?.locked_at ?? null),
      }
    },

    async createAdminSession(args) {
      const { error } = await client.from('admin_sessions').insert({
        admin_id: args.adminId,
        token_hash: args.tokenHash,
        expires_at: args.expiresAt,
      })
      if (error) throw new Error(`createAdminSession failed: ${error.message}`)
    },

    async getAdminSessionByTokenHash(tokenHash) {
      // Join the account so a disabled admin's live sessions die on their next request.
      // The role rides the same join (2C-1 / #19): per-request, so a demotion bites now.
      const { data, error } = await client
        .from('admin_sessions')
        .select('id, admin_id, expires_at, admin_accounts!inner(username, disabled_at, role)')
        .eq('token_hash', tokenHash)
        .maybeSingle()
      if (error) throw new Error(`getAdminSessionByTokenHash failed: ${error.message}`)
      if (!data) return null
      const account = data.admin_accounts as unknown as {
        username: string
        disabled_at: string | null
        role: AdminRole
      }
      return {
        id: data.id as string,
        admin_id: data.admin_id as string,
        expires_at: new Date(data.expires_at as string),
        username: account.username,
        account_disabled_at: parseDate(account.disabled_at),
        role: account.role,
      }
    },

    async deleteAdminSessionByTokenHash(tokenHash) {
      const { error } = await client.from('admin_sessions').delete().eq('token_hash', tokenHash)
      if (error) throw new Error(`deleteAdminSessionByTokenHash failed: ${error.message}`)
    },

    async deleteExpiredAdminSessions(adminId, nowIso) {
      const { error } = await client
        .from('admin_sessions')
        .delete()
        .eq('admin_id', adminId)
        .lt('expires_at', nowIso)
      if (error) throw new Error(`deleteExpiredAdminSessions failed: ${error.message}`)
    },

    async getAdminAccountById(id) {
      const { data, error } = await client
        .from('admin_accounts')
        .select('id, username, password_hash, failed_attempts, locked_at, disabled_at, role')
        .eq('id', id)
        .maybeSingle()
      if (error) throw new Error(`getAdminAccountById failed: ${error.message}`)
      if (!data) return null
      return {
        id: data.id as string,
        username: data.username as string,
        password_hash: data.password_hash as string,
        failed_attempts: data.failed_attempts as number,
        locked_at: parseDate(data.locked_at as string | null),
        disabled_at: parseDate(data.disabled_at as string | null),
        role: data.role as AdminRole,
      }
    },

    async getWeeklyCapacityAdmin(sunday) {
      const { data, error } = await client
        .from('weekly_events')
        .select('id, sunday_date, status, total_capacity, blocked_spaces, admin_reserved, capacity_version')
        .eq('sunday_date', sunday)
        .maybeSingle()
      if (error) throw new Error(`getWeeklyCapacityAdmin failed: ${error.message}`)
      if (!data) return null

      // reserved_staff is not on weekly_events — it is a count over
      // weekly_staff_allocations, which is exactly why the row-local CHECK in 0031
      // cannot express the full invariant and the RPC has to.
      const { count, error: se } = await client
        .from('weekly_staff_allocations')
        .select('user_id', { count: 'exact', head: true })
        .eq('weekly_event_id', data.id as string)
        .eq('status', 'reserved')
      if (se) throw new Error(`getWeeklyCapacityAdmin staff count failed: ${se.message}`)
      if (count === null) throw new Error('getWeeklyCapacityAdmin failed: staff count unavailable')

      return {
        id: data.id as string,
        sunday_date: data.sunday_date as string,
        status: data.status as string,
        total_capacity: data.total_capacity as number,
        blocked_spaces: data.blocked_spaces as number,
        admin_reserved: data.admin_reserved as number,
        capacity_version: data.capacity_version as number,
        active_full_time_staff_reserved: count,
      }
    },

    async countPromisedReservations(eventId) {
      const { count, error } = await client
        .from('reservations')
        .select('id', { count: 'exact', head: true })
        .eq('weekly_event_id', eventId)
        .in('status', ['approved', 'temp_approved'])
      if (error) throw new Error(`countPromisedReservations failed: ${error.message}`)
      if (count === null) throw new Error('countPromisedReservations failed: count unavailable')
      return count
    },

    async countWeekReservations(eventId) {
      const { data, error } = await client
        .from('reservations')
        .select('status, effective_priority')
        .eq('weekly_event_id', eventId)
        .in('status', WEEK_DEMAND_STATUSES)
      if (error) throw new Error(`countWeekReservations failed: ${error.message}`)
      if (data === null) throw new Error('countWeekReservations failed: rows unavailable')
      return summarizeWeekReservations(data as { status: string; effective_priority: number }[])
    },

    async listWeekApplications(eventId) {
      const { data, error } = await client
        .from('reservations')
        .select('id, status, effective_priority, allocation_order, applied_at, users(display_name), vehicles(license_plate)')
        .eq('weekly_event_id', eventId)
        .in('status', ['pending', 'waiting'])
        .order('allocation_order', { ascending: true, nullsFirst: false })
      if (error) throw new Error(`listWeekApplications failed: ${error.message}`)
      // Fail loud on a missing result set, like countWeekReservations and getWaitingRank
      // above: `?? []` would render 「目前沒有申請中的紀錄」 to an operator who arrived by
      // clicking a NON-ZERO count, which is worse than an error page.
      if (data === null) throw new Error('listWeekApplications failed: rows unavailable')
      return data.map(row => {
        const r = row as Record<string, unknown>
        const u = r.users as { display_name: string } | Array<{ display_name: string }> | null
        const v = r.vehicles as { license_plate: string } | Array<{ license_plate: string }> | null
        const owner = Array.isArray(u) ? u[0] : u
        const vehicle = Array.isArray(v) ? v[0] : v
        return {
          id: r.id as string,
          status: r.status as 'pending' | 'waiting',
          effective_priority: r.effective_priority as EffectivePriority,
          allocation_order: r.allocation_order as number | null,
          applied_at: r.applied_at as string,
          display_name: owner?.display_name ?? '',
          license_plate: vehicle?.license_plate ?? '',
        }
      })
    },

    async setWeeklyCapacity(args) {
      const { data, error } = await client.rpc('set_weekly_capacity', {
        p_event_id: args.eventId,
        p_sunday: args.sunday,
        p_total_capacity: args.totalCapacity,
        p_blocked_spaces: args.blockedSpaces,
        p_expected_version: args.expectedVersion,
        p_acting_admin_id: args.actingAdminId,
        p_acting_session_id: args.actingSessionId,
        p_request_id: args.requestId,
      })
      if (error) throw new Error(`set_weekly_capacity failed: ${error.message}`)
      return data as { ok: boolean; reason?: string; noop?: boolean }
    },

    async listAuditLogs({ limit, before }) {
      let q = client
        .from('audit_logs')
        .select(
          'id, created_at, actor_type, actor_id, actor_session_id, actor_role_snapshot,' +
            ' action, entity_type, entity_id, weekly_event_id, request_id, result, metadata_redacted',
        )

      if (before) {
        // Strictly older than the cursor, in (created_at desc, id desc) order:
        //   created_at < c  OR  (created_at = c AND id < cursorId)
        // The equality arm is what makes the order total — created_at defaults to
        // now(), the TRANSACTION timestamp, so one RPC writing two rows ties.
        //
        // The timestamp is interpolated raw and MUST NOT be reformatted: PostgREST
        // needs the exact microseconds back, and supabase-js url-encodes the `+`
        // for us (raw curl does not — it arrives as a space and errors 22007).
        q = q.or(
          `created_at.lt.${before.createdAt},` +
            `and(created_at.eq.${before.createdAt},id.lt.${before.id})`,
        )
      }

      const { data, error } = await q
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit)
      if (error) throw new Error(`listAuditLogs failed: ${error.message}`)

      // No parseDate on created_at — see the interface comment. Everything else is
      // passed through untouched; metadata_redacted stays opaque to this layer.
      return { rows: (data ?? []) as unknown as AuditLogRow[] }
    },

    async listAdminAccounts() {
      const { data, error } = await client
        .from('admin_accounts')
        .select('id, username, display_name, locked_at, disabled_at, created_at, role')
        .order('username', { ascending: true })
      if (error) throw new Error(`listAdminAccounts failed: ${error.message}`)
      return (data ?? []).map(row => ({
        id: row.id as string,
        username: row.username as string,
        display_name: row.display_name as string | null,
        locked_at: parseDate(row.locked_at as string | null),
        disabled_at: parseDate(row.disabled_at as string | null),
        created_at: new Date(row.created_at as string),
        role: row.role as AdminRole,
      }))
    },

    async setAdminDisabled({ targetId, actingAdminId, actingSessionId, disabled, nowIso, requestId }) {
      const { data, error } = await client.rpc('set_admin_disabled', {
        p_target_id: targetId,
        p_acting_admin_id: actingAdminId,
        p_acting_session_id: actingSessionId,
        p_disabled: disabled,
        p_now: nowIso,
        p_request_id: requestId,
      })
      if (error) throw new Error(`set_admin_disabled failed: ${error.message}`)
      return data as { ok: boolean; reason?: string }
    },

    async resetAdminPassword({ targetId, actingAdminId, actingSessionId, passwordHash, requestId }) {
      const { data, error } = await client.rpc('reset_admin_password', {
        p_target_id: targetId,
        p_acting_admin_id: actingAdminId,
        p_acting_session_id: actingSessionId,
        p_password_hash: passwordHash,
        p_request_id: requestId,
      })
      if (error) throw new Error(`reset_admin_password failed: ${error.message}`)
      return data as { ok: boolean; reason?: string; username?: string; disabled?: boolean }
    },

    async deleteAdminSessionsByAdminId(id) {
      const { error, count } = await client
        .from('admin_sessions')
        .delete({ count: 'exact' })
        .eq('admin_id', id)
      if (error) throw new Error(`deleteAdminSessionsByAdminId failed: ${error.message}`)
      return { deleted: count ?? 0 }
    },

    async createAdminAccount({ username, passwordHash, displayName, role, actingAdminId, actingSessionId, requestId }) {
      const { data, error } = await client.rpc('create_admin_account', {
        p_username: username,
        p_password_hash: passwordHash,
        p_display_name: displayName,
        p_role: role,
        p_acting_admin_id: actingAdminId,
        p_acting_session_id: actingSessionId,
        p_request_id: requestId,
      })
      if (error) throw new Error(`create_admin_account failed: ${error.message}`)
      return data as Awaited<ReturnType<ParkingRepository['createAdminAccount']>>
    },

    async setAdminRole({ targetId, role, actingAdminId, actingSessionId, requestId }) {
      const { data, error } = await client.rpc('set_admin_role', {
        p_target_id: targetId,
        p_role: role,
        p_acting_admin_id: actingAdminId,
        p_acting_session_id: actingSessionId,
        p_request_id: requestId,
      })
      if (error) throw new Error(`set_admin_role failed: ${error.message}`)
      return data as { ok: boolean; reason?: string; changed?: boolean; role?: string }
    },

    async revokeAdminSessions({ targetId, actingAdminId, actingSessionId, requestId }) {
      const { data, error } = await client.rpc('revoke_admin_sessions', {
        p_target_id: targetId,
        p_acting_admin_id: actingAdminId,
        p_acting_session_id: actingSessionId,
        p_request_id: requestId,
      })
      if (error) throw new Error(`revoke_admin_sessions failed: ${error.message}`)
      return data as { ok: boolean; reason?: string; sessions_revoked?: number }
    },

    async createMember({ displayName, phone, actingAdminId, actingSessionId, requestId, confirmedCandidateIds }) {
      const { data, error } = await client.rpc('create_member', {
        p_display_name: displayName,
        p_phone: phone,
        p_acting_admin_id: actingAdminId,
        p_acting_session_id: actingSessionId,
        p_request_id: requestId,
        // null and [] mean DIFFERENT things to the RPC (unconfirmed vs. confirmed-empty),
        // so this is passed through as-is — never coalesced to an empty array.
        p_confirmed_candidate_ids: confirmedCandidateIds,
      })
      if (error) throw new Error(`create_member failed: ${error.message}`)
      return data as Awaited<ReturnType<ParkingRepository['createMember']>>
    },

    async updateMemberIdentity({ userId, displayName, phone, actingAdminId, actingSessionId, requestId, nowIso }) {
      const { data, error } = await client.rpc('update_member_identity', {
        p_user_id: userId,
        p_display_name: displayName,
        p_phone: phone,
        p_acting_admin_id: actingAdminId,
        p_acting_session_id: actingSessionId,
        p_request_id: requestId,
        p_now: nowIso,
      })
      if (error) throw new Error(`update_member_identity failed: ${error.message}`)
      return data as Awaited<ReturnType<ParkingRepository['updateMemberIdentity']>>
    },

    async addMemberVehicle({ userId, licensePlate, actingAdminId, actingSessionId, requestId }) {
      const { data, error } = await client.rpc('add_member_vehicle', {
        p_user_id: userId,
        p_license_plate: licensePlate,
        p_acting_admin_id: actingAdminId,
        p_acting_session_id: actingSessionId,
        p_request_id: requestId,
      })
      if (error) throw new Error(`add_member_vehicle failed: ${error.message}`)
      return data as Awaited<ReturnType<ParkingRepository['addMemberVehicle']>>
    },

    async setMemberVehicleActive({ vehicleId, isActive, actingAdminId, actingSessionId, requestId }) {
      const { data, error } = await client.rpc('set_member_vehicle_active', {
        p_vehicle_id: vehicleId,
        p_is_active: isActive,
        p_acting_admin_id: actingAdminId,
        p_acting_session_id: actingSessionId,
        p_request_id: requestId,
      })
      if (error) throw new Error(`set_member_vehicle_active failed: ${error.message}`)
      return data as Awaited<ReturnType<ParkingRepository['setMemberVehicleActive']>>
    },

    async getMemberEvent(todayTaipei) {
      return upcomingScheduledEvent(todayTaipei)
    },

    async getMemberWeekReservation(userId, eventId) {
      const { data, error } = await client
        .from('reservations')
        .select(
          'id, status, effective_priority, allocation_order, applied_at, attended_at, release_deadline_at, offer_expires_at, p2_on_the_way, vehicles(license_plate)',
        )
        .eq('weekly_event_id', eventId)
        .eq('user_id', userId)
      if (error) throw new Error(`getMemberWeekReservation failed: ${error.message}`)
      const rows = (data ?? []) as Array<Record<string, unknown>>
      if (rows.length === 0) return null

      // The one-active-per-member index allows cancelled siblings next to one live
      // row: show the live row if present, else the most recent cancellation.
      const isCancelled = (r: Record<string, unknown>) =>
        r.status === 'cancelled_by_user' || r.status === 'cancelled_late'
      rows.sort((a, b) => {
        if (isCancelled(a) !== isCancelled(b)) return isCancelled(a) ? 1 : -1
        return String(b.applied_at).localeCompare(String(a.applied_at))
      })
      const row = rows[0]
      const vehicle = row.vehicles as { license_plate?: string } | null
      return {
        id: row.id as string,
        status: row.status as ReservationStatus,
        effective_priority: row.effective_priority as number,
        allocation_order: (row.allocation_order as number | null) ?? null,
        license_plate: vehicle?.license_plate ?? null,
        applied_at: new Date(row.applied_at as string),
        attended_at: parseDate(row.attended_at as string | null),
        release_deadline_at: parseDate(row.release_deadline_at as string | null),
        offer_expires_at: parseDate(row.offer_expires_at as string | null),
        p2_on_the_way: (row.p2_on_the_way as boolean | null) ?? false,
      }
    },

    async getWaitingRank(eventId, allocationOrder) {
      const { error, count } = await client
        .from('reservations')
        .select('id', { count: 'exact', head: true })
        .eq('weekly_event_id', eventId)
        .eq('status', 'waiting')
        .lt('allocation_order', allocationOrder)
      if (error) throw new Error(`getWaitingRank failed: ${error.message}`)
      // A missing count is an anomaly, not "nobody ahead": defaulting to 0 would show a
      // confident "第 1 位" that may be false. Fail loud like every other repo read.
      if (count === null) throw new Error('getWaitingRank failed: count unavailable')
      return count + 1
    },

    async getMemberVehicles(userId) {
      const { data, error } = await client
        .from('vehicles')
        .select('id, license_plate, nickname')
        .eq('user_id', userId)
        .eq('is_active', true)
        .order('created_at', { ascending: true })
      if (error) throw new Error(`getMemberVehicles failed: ${error.message}`)
      return (data ?? []) as MemberVehicleRow[]
    },

    async getMemberEligibility(userId) {
      const { data, error } = await client
        .from('user_eligibility')
        .select('p2_eligible, p2_reason, p2_valid_from, p2_valid_until')
        .eq('user_id', userId)
        .maybeSingle()
      if (error) throw new Error(`getMemberEligibility failed: ${error.message}`)
      return (data as {
        p2_eligible: boolean
        p2_reason: string | null
        p2_valid_from: string | null
        p2_valid_until: string | null
      } | null) ?? null
    },

    async getUserRole(userId) {
      const { data, error } = await client
        .from('users')
        .select('role')
        .eq('id', userId)
        .maybeSingle()
      if (error) throw new Error(`getUserRole failed: ${error.message}`)
      return ((data as { role: string } | null)?.role ?? null)
    },

    async searchMembers({ nameQuery, phoneQuery, plateQuery, candidateCap }) {
      // Collect candidate user ids from each non-null branch (each independently capped
      // so no single branch can pull the whole table). `.ilike()` parameterizes the
      // value against filter-syntax injection; the service already stripped %/_ wildcards.
      const ids = new Set<string>()

      const collectUsers = async (column: 'display_name' | 'phone_number', q: string) => {
        const { data, error } = await client
          .from('users')
          .select('id')
          .ilike(column, `%${q}%`)
          .limit(candidateCap)
        if (error) throw new Error(`searchMembers (${column}) failed: ${error.message}`)
        for (const r of data ?? []) ids.add((r as { id: string }).id)
      }

      if (nameQuery !== null) await collectUsers('display_name', nameQuery)
      if (phoneQuery !== null) await collectUsers('phone_number', phoneQuery)
      if (plateQuery !== null) {
        const { data, error } = await client
          .from('vehicles')
          .select('user_id')
          .eq('is_active', true)
          .ilike('license_plate_normalized', `%${plateQuery}%`)
          .limit(candidateCap)
        if (error) throw new Error(`searchMembers (plate) failed: ${error.message}`)
        for (const r of data ?? []) ids.add((r as { user_id: string }).user_id)
      }

      if (ids.size === 0) return []
      const idList = [...ids]

      const { data: users, error: ue } = await client
        .from('users')
        .select('id, display_name, phone_number, role, line_id')
        .in('id', idList)
      if (ue) throw new Error(`searchMembers users fetch failed: ${ue.message}`)

      const { data: plateRows, error: pe } = await client
        .from('vehicles')
        .select('user_id, license_plate')
        .eq('is_active', true)
        .in('user_id', idList)
        .order('created_at', { ascending: true })
      if (pe) throw new Error(`searchMembers plates fetch failed: ${pe.message}`)

      const platesByUser = new Map<string, string[]>()
      for (const r of (plateRows ?? []) as Array<{ user_id: string; license_plate: string }>) {
        const arr = platesByUser.get(r.user_id) ?? []
        arr.push(r.license_plate)
        platesByUser.set(r.user_id, arr)
      }

      const rows = ((users ?? []) as Array<{
        id: string; display_name: string; phone_number: string | null; role: string; line_id: string | null
      }>).map(u => ({
        id: u.id,
        display_name: u.display_name,
        phone_number: u.phone_number,
        role: u.role,
        line_id: u.line_id,
        plates: platesByUser.get(u.id) ?? [],
      }))

      // Stable order so hasMore (service slices limit+1) and pagination hints are deterministic.
      rows.sort((a, b) => a.display_name.localeCompare(b.display_name, 'zh-Hant') || a.id.localeCompare(b.id))
      return rows
    },

    async listMembers({ limit, offset }) {
      // Order in the DB, not in JS: offset paging is only correct over a total order, and
      // (display_name, id) is total because id is unique. Collation is Postgres's, so this
      // ordering can differ slightly from searchMembers' localeCompare('zh-Hant') — within
      // the roster it is consistent, which is what paging needs.
      const { data, error, count } = await client
        .from('users')
        .select('id, display_name, phone_number, role, line_id', { count: 'exact' })
        .order('display_name', { ascending: true })
        .order('id', { ascending: true })
        .range(offset, offset + limit - 1)
      if (error) {
        // PostgREST answers 416/PGRST103 for an offset past the end — a stale or hand-typed
        // ?page=999. That is an EMPTY PAGE, not a failure: throwing here would 500 the page
        // before it could redirect to the last real one. It returns no count, so fetch that
        // separately (only on this rare path).
        if (error.code !== 'PGRST103') throw new Error(`listMembers failed: ${error.message}`)
        const { count: only, error: ce } = await client
          .from('users')
          .select('id', { count: 'exact', head: true })
        if (ce) throw new Error(`listMembers count failed: ${ce.message}`)
        if (only === null) throw new Error('listMembers failed: count unavailable')
        return { rows: [], total: only }
      }
      if (count === null) throw new Error('listMembers failed: count unavailable')

      const users = (data ?? []) as Array<{
        id: string; display_name: string; phone_number: string | null; role: string; line_id: string | null
      }>
      // Past the last page: nothing to join. Skip the vehicles round trip rather than issue
      // `.in('user_id', [])`, whose behaviour isn't consistent across clients.
      if (users.length === 0) return { rows: [], total: count }

      const platesByUser = await activePlatesByUser(users.map(u => u.id))
      const rows = users.map(u => ({
        id: u.id,
        display_name: u.display_name,
        phone_number: u.phone_number,
        role: u.role,
        line_id: u.line_id,
        plates: platesByUser.get(u.id) ?? [],
      }))
      return { rows, total: count }
    },

    async listMembersForExportPage({ createdBefore, afterCreatedAt, afterId, limit }) {
      // Keyset over the IMMUTABLE (created_at, id): a concurrent insert (created_at >= now)
      // is excluded by the cutoff and cannot shift the window, so no member is duped or
      // skipped across pages (offset paging cannot promise that). The compound cursor is
      // needed because created_at is NOT unique — a bulk import gives every row the same
      // statement now() — so id breaks the tie. The timestamp is double-quoted in the .or()
      // so PostgREST treats the ':'/'+' as data, not filter syntax.
      let query = client
        .from('users')
        .select('id, display_name, phone_number, role, line_id, created_at')
        .lt('created_at', createdBefore)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(limit)
      if (afterCreatedAt !== null && afterId !== null) {
        query = query.or(
          `created_at.gt."${afterCreatedAt}",and(created_at.eq."${afterCreatedAt}",id.gt.${afterId})`,
        )
      }
      const { data, error } = await query
      if (error) throw new Error(`listMembersForExportPage failed: ${error.message}`)

      const users = (data ?? []) as Array<{
        id: string; display_name: string; phone_number: string | null; role: string; line_id: string | null; created_at: string
      }>
      if (users.length === 0) return []
      const platesByUser = await activePlatesByUser(users.map(u => u.id))
      return users.map(u => ({
        id: u.id,
        display_name: u.display_name,
        phone_number: u.phone_number,
        role: u.role,
        line_id: u.line_id,
        created_at: u.created_at,
        plates: platesByUser.get(u.id) ?? [],
      }))
    },

    async logMemberRosterExport({ actingAdminId, actingSessionId, requestId, rowCount }) {
      const { data, error } = await client.rpc('log_member_roster_export', {
        p_acting_admin_id: actingAdminId,
        p_acting_session_id: actingSessionId,
        p_request_id: requestId,
        p_row_count: rowCount,
      })
      if (error) throw new Error(`log_member_roster_export failed: ${error.message}`)
      return data as { ok: boolean; reason?: string }
    },

    async getDbNow() {
      const { data, error } = await client.rpc('db_now')
      if (error) throw new Error(`db_now failed: ${error.message}`)
      return data as string
    },

    async getMemberAdminDetail(userId) {
      const { data: user, error: ue } = await client
        .from('users')
        .select('display_name, phone_number, role, line_id')
        .eq('id', userId)
        .maybeSingle()
      if (ue) throw new Error(`getMemberAdminDetail user failed: ${ue.message}`)
      if (!user) return null
      const u = user as { display_name: string; phone_number: string | null; role: string; line_id: string | null }

      // Active first, then oldest-first within each group: the current cars are what an admin
      // is normally looking for, and the retired ones read as history in the order they were
      // acquired. (Sorting by created_at alone would bury an active car under old ones.)
      const { data: vehicles, error: ve } = await client
        .from('vehicles')
        .select('id, license_plate, nickname, is_active')
        .eq('user_id', userId)
        .order('is_active', { ascending: false })
        .order('created_at', { ascending: true })
      if (ve) throw new Error(`getMemberAdminDetail vehicles failed: ${ve.message}`)

      const { data: elig, error: ee } = await client
        .from('user_eligibility')
        .select('p2_eligible, p2_reason, p2_valid_from, p2_valid_until, p2_review_date, p2_child_birthdate, review_status, review_note, review_version, reviewed_at')
        .eq('user_id', userId)
        .maybeSingle()
      if (ee) throw new Error(`getMemberAdminDetail eligibility failed: ${ee.message}`)

      const { data: deps, error: de } = await client
        .from('eligibility_dependents')
        .select('dependent_kind, dependent_name, dependent_birthdate')
        .eq('user_id', userId)
        .order('dependent_birthdate', { ascending: true, nullsFirst: true })
      if (de) throw new Error(`getMemberAdminDetail dependents failed: ${de.message}`)

      return {
        display_name: u.display_name,
        phone_number: u.phone_number,
        role: u.role,
        line_id: u.line_id,
        vehicles: (
          (vehicles ?? []) as Array<{ id: string; license_plate: string; nickname: string | null; is_active: boolean }>
        ).map(v => ({
          id: v.id,
          license_plate: v.license_plate,
          nickname: v.nickname,
          is_active: v.is_active,
        })),
        eligibility: elig
          ? (elig as {
              p2_eligible: boolean; p2_reason: string | null
              p2_valid_from: string | null; p2_valid_until: string | null
              p2_review_date: string | null; p2_child_birthdate: string | null
              review_status: string; review_note: string | null; review_version: number
              reviewed_at: string | null
            })
          : null,
        dependents: ((deps ?? []) as Array<{ dependent_kind: string; dependent_name: string; dependent_birthdate: string | null }>).map(d => ({
          kind: d.dependent_kind,
          name: d.dependent_name,
          birthdate: d.dependent_birthdate,
        })),
      }
    },

    async listEligibilityReview({ cutoffDate, branchCap }) {
      type Raw = {
        user_id: string
        p2_reason: string | null
        p2_valid_from: string | null
        p2_valid_until: string | null
        p2_review_date: string | null
        reviewed_at: string | null
        users: { display_name: string } | null
      }
      // The !user_id FK hint was originally REQUIRED to disambiguate: user_eligibility had
      // two FKs to users (user_id and reviewed_by). Since 0032 repointed reviewed_by at
      // admin_accounts there is only one, so the hint is no longer load-bearing — it stays
      // because naming the FK explicitly is what keeps this query immune to the next one.
      const SELECT = 'user_id, p2_reason, p2_valid_from, p2_valid_until, p2_review_date, reviewed_at, users!user_id!inner(display_name)'

      // Two date-ordered branches: each returns the EARLIEST rows by its own date, so
      // truncating at branchCap keeps the most-urgent cases (an unordered .or()+limit
      // could drop them). Merge distinct by user_id — a temporary eligibility with both
      // dates set hits both branches.
      const runBranch = async (column: 'p2_review_date' | 'p2_valid_until') => {
        const { data, error } = await client
          .from('user_eligibility')
          .select(SELECT)
          .eq('p2_eligible', true)
          .lte(column, cutoffDate)
          .order(column, { ascending: true })
          .limit(branchCap)
        if (error) throw new Error(`listEligibilityReview (${column}) failed: ${error.message}`)
        return (data ?? []) as unknown as Raw[]
      }

      const byUser = new Map<string, EligibilityReviewRow>()
      for (const branch of [await runBranch('p2_review_date'), await runBranch('p2_valid_until')]) {
        for (const r of branch) {
          if (byUser.has(r.user_id)) continue
          byUser.set(r.user_id, {
            user_id: r.user_id,
            display_name: r.users?.display_name ?? '',
            p2_reason: r.p2_reason,
            p2_valid_from: r.p2_valid_from,
            p2_valid_until: r.p2_valid_until,
            p2_review_date: r.p2_review_date,
            reviewed_at: r.reviewed_at,
          })
        }
      }
      return [...byUser.values()]
    },

    async listEligibilityTodoCandidates(asOfDate, pageSize = 1000) {
      // Superset filter only — the classifier decides the final set. Null date columns
      // never satisfy .lt/.lte, so permanent (both-null) rows are excluded here. Paginate
      // to completion so the count is exact regardless of size (no display cap).
      const out: EligibilityTodoCandidate[] = []
      for (let from = 0; ; from += pageSize) {
        const { data, error } = await client
          .from('user_eligibility')
          .select('user_id, p2_valid_from, p2_valid_until, p2_review_date')
          .eq('p2_eligible', true)
          .or(`p2_valid_until.lt.${asOfDate},p2_review_date.lte.${asOfDate}`)
          .order('user_id', { ascending: true })
          .range(from, from + pageSize - 1)
        if (error) throw new Error(`listEligibilityTodoCandidates failed: ${error.message}`)
        const rows = (data ?? []) as EligibilityTodoCandidate[]
        out.push(...rows)
        if (rows.length < pageSize) break
      }
      return out
    },

    async hasFridayAllocationRun(eventId) {
      const { data, error } = await client
        .from('job_runs')
        .select('status')
        .eq('weekly_event_id', eventId)
        .eq('job_type', 'friday_allocation')
        .in('status', ['running', 'success'])
        .limit(1)
      if (error) throw new Error(`hasFridayAllocationRun failed: ${error.message}`)
      return (data ?? []).length > 0
    },

    async claimFridayAllocation(eventId, jobType) {
      const { data, error } = await client.rpc('claim_friday_allocation', {
        p_event_id: eventId,
        p_job_type: jobType,
      })
      if (error) throw new Error(`claim_friday_allocation failed: ${error.message}`)
      const row = data as { claimed: boolean; reason: string }
      return { claimed: row.claimed, reason: row.reason }
    },

    async applyReservation({ eventId, userId, vehicleId, requestedP2, effectivePriority, nowIso }) {
      const { data, error } = await client.rpc('apply_reservation', {
        p_event_id: eventId,
        p_user_id: userId,
        p_vehicle_id: vehicleId,
        p_requested_p2: requestedP2,
        p_effective_priority: effectivePriority,
        p_now: nowIso,
      })
      if (error) throw new Error(`apply_reservation failed: ${error.message}`)
      const row = data as { applied: number; reason: string }
      return { applied: row.applied, reason: row.reason }
    },
  }
}
