// ── Enums ──────────────────────────────────────────────────────────────────

export type ReservationStatus =
  | 'pending'
  | 'approved'
  | 'temp_approved'        // live offer + seat lock (no separate offer_* main states)
  | 'waiting'
  | 'attended'
  | 'released_late'
  | 'attended_after_release'
  | 'no_show'
  | 'cancelled_by_user'
  | 'cancelled_late'
  | 'walk_in'

// Outcome of a substitution offer. Lives as a sub-field on the reservation; the
// in-flight offer itself is represented by the main status `temp_approved`.
// null = no offer history yet.
export type OfferStatus = 'expired' | 'declined' | null

export type EffectivePriority = 1 | 2 | 3  // P1 | P2 | P3

export type UserRole = 'user' | 'staff' | 'admin'

export type WeeklyEventStatus = 'open' | 'closed' | 'finalized'

export type WeeklyStaffAllocationStatus = 'reserved' | 'skipped' | 'attended' | 'no_show'

// ── Domain Models ──────────────────────────────────────────────────────────

export interface AllocationUser {
  id: string
  p1_eligible: boolean
  p2_eligible: boolean
  penalty_score: number               // 0–3, P3 only
  consecutive_no_show: number         // P1/P2 pastoral care counter
  last_successful_attended_at: Date | null
}

export interface WeeklyEvent {
  id: string
  sunday_date: Date
  total_capacity: number
  blocked_spaces: number
  admin_reserved: number   // == guest_reserved (外賓保留位); P1 staff are counted separately
  status: WeeklyEventStatus
}

// P1 full-time staff weekly record (replaces the old users.p1_skip_this_week).
//
// The question this row answers is "does this staff member need one of the SYSTEM-managed
// 23 spaces this week?" — NOT "are they at church this week?".
//   'reserved' = yes: hold one of the 23 for them (e.g. they have to leave early, so the
//                church-managed area does not work for them this week)
//   'skipped'  = no: they use the church-managed staff parking area, or they are away
// The church-managed area is outside this system entirely — it is never counted, and how
// many cars sit in it has no effect on capacity. Someone who attends but parks there is
// 'skipped'.
export interface WeeklyStaffAllocation {
  id: string
  weekly_event_id: string
  user_id: string
  status: WeeklyStaffAllocationStatus
  skip_reason: string | null
  updated_at: Date
}

export interface Reservation {
  id: string
  weekly_event_id: string
  user_id: string | null             // null for walk_in
  vehicle_id: string | null          // null for walk_in
  requested_p2_this_week: boolean
  effective_priority: EffectivePriority
  status: ReservationStatus
  // Offer (substitution) sub-state
  offer_status: OfferStatus          // outcome of last offer; null = none
  last_offer_at: Date | null         // when the most recent offer was sent
  offer_expires_at: Date | null      // 2-hour confirm deadline while temp_approved
  // P2 release timing
  p2_on_the_way: boolean             // candidate replied "正在路上"
  release_deadline_at: Date | null   // P3=10:30, P2=10:30, P2 on-the-way=10:50; null until approved
  // Frozen waiting order snapshot (set at Friday 18:00 allocation), null until then
  allocation_order: number | null
  // Lifecycle timestamps
  applied_at: Date
  approved_at: Date | null
  attended_at: Date | null
  released_at: Date | null
  cancelled_at: Date | null
  finalized_at: Date | null
  // Walk-in
  walk_in_name: string | null
  walk_in_license_plate: string | null
  staff_note: string | null
  admin_note: string | null
}

// Reservation enriched with user data needed for sorting/allocation
export interface ReservationForAllocation extends Reservation {
  penalty_score: number
  last_successful_attended_at: Date | null
}

// ── Staff check-in (Phase 3) ─────────────────────────────────────────────────
// The privacy-projected shape returned by staff_checkin_view (development_plan §9).
// Staff see ONLY name / plate / is_priority boolean / status / attended_at — never
// p2_reason, penalty, phone, or the raw effective_priority value.
export interface StaffCheckInRow {
  reservation_id: string
  weekly_event_id: string
  display_name: string | null          // member; null for walk-in
  license_plate: string | null         // member; null for walk-in
  walk_in_name: string | null
  walk_in_license_plate: string | null
  is_priority: boolean                 // effective_priority <= 2, reason hidden
  status: ReservationStatus
  attended_at: Date | null
  owner_notifiable: boolean            // LINE-reachable owner? (member with a line_id); no line_id leaked
}

// ── Output Types ───────────────────────────────────────────────────────────

export interface NotificationOutboxEntry {
  user_id: string | null
  reservation_id: string | null
  template_key: NotificationTemplate
  payload: Record<string, unknown>
}

export type NotificationTemplate =
  | 'reservation_approved'
  | 'reservation_waiting'
  | 'offer_2hr_confirm'
  | 'offer_auto_approved'
  | 'broadcast_release'
  | 'reservation_released'
  | 'reservation_cancelled'
  | 'p2_arrival_reminder'
  | 'staff_reminder'
  | 'admin_finalize_reminder'
  | 'move_car_request'

export interface PenaltyUpdate {
  user_id: string
  penalty_score: number
  consecutive_no_show: number
  pastoral_care_flag: boolean        // true if P1/P2 consecutive_no_show >= 4
  last_successful_attended_at: Date | null
}

export interface AllocateResult {
  reservations: ReservationForAllocation[]
  outbox: NotificationOutboxEntry[]
}

export interface SubstituteResult {
  reservation: Reservation
  outbox: NotificationOutboxEntry[]
}

export interface AutoApproveResult {
  reservations: Reservation[]
  outbox: NotificationOutboxEntry[]
}

export interface ReleaseResult {
  reservations: Reservation[]
  outbox: NotificationOutboxEntry[]
  releasedCount: number
}

export interface SettleResult {
  reservations: Reservation[]
  penaltyUpdates: PenaltyUpdate[]
}

export interface AttendResult {
  reservation: Reservation
  penaltyUpdate: PenaltyUpdate
}
