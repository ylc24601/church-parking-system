// Single source of truth for the system's business-rule constants.
//
// Core pure functions (release, computeCapacity, ...) stay dependency-injected:
// they receive deadlines / capacity as arguments rather than reading these
// directly, so they remain week-agnostic and testable. These constants are the
// canonical *defaults* and are what tests/fixtures and callers should reference
// instead of hardcoding literals.

// ── Substitution offer ───────────────────────────────────────────────────────
// Saturday substitution: candidate has this long to confirm a temp_approved offer.
export const OFFER_CONFIRM_WINDOW_HOURS = 2
export const OFFER_CONFIRM_WINDOW_MS = OFFER_CONFIRM_WINDOW_HOURS * 60 * 60 * 1000

// ── No-show penalties ────────────────────────────────────────────────────────
// P3 penalty_score is capped here; P1/P2 never accrue penalty.
export const MAX_PENALTY = 3
// P1/P2 consecutive no-shows that trigger a pastoral-care flag (care, not punishment).
export const PASTORAL_CARE_THRESHOLD = 4

// ── Capacity ─────────────────────────────────────────────────────────────────
// Default total physical spaces in the basement.
export const DEFAULT_TOTAL_CAPACITY = 23

// ── Sunday release times (Asia/Taipei, UTC+8 year-round, no DST) ───────────────
// Source of truth for the three release deadlines. Functions receive concrete
// Date instances (see ReleaseDeadlines); these {hour, minute} values are what
// callers/tests build those Dates from.
export const TAIPEI_UTC_OFFSET_HOURS = 8

export const RELEASE_TIMES = {
  p3: { hour: 10, minute: 30 },       // P3 一般會友
  p2: { hour: 10, minute: 30 },       // P2 關懷會友（#42：對齊 P3，未回報者一併於 10:30 釋出）
  p2Grace: { hour: 10, minute: 50 },  // P2 who replied 「正在路上」（#42：10:55→10:50）
} as const

// ── Notification dispatcher (Phase 4 Slice A) ─────────────────────────────────
// The dispatcher claims a batch of due notification_outbox rows (lease), sends via a
// transport, then transitions each row sent / retrying (backoff) / failed.
// A retryable send is retried up to NOTIFICATION_MAX_RETRIES times; the Nth retry
// waits NOTIFICATION_RETRY_BACKOFF_MINUTES[min(N, len-1)] minutes.
export const NOTIFICATION_MAX_RETRIES = 5
export const NOTIFICATION_RETRY_BACKOFF_MINUTES = [1, 5, 15, 60, 240] as const
export const NOTIFICATION_DISPATCH_BATCH = 100
// Lease held on a claimed row. Kept well above any single push timeout so a healthy
// worker always finalizes its own rows before another worker can reclaim them.
export const NOTIFICATION_LEASE_SECONDS = 120

// ── Staff on-site PIN session (Phase 3 v2) ────────────────────────────────────
// One shared PIN per weekly_event (staff_sessions). Consecutive wrong PINs lock
// the event's PIN for a cooldown; a logged-in cookie session lives for one shift.
export const STAFF_PIN_MAX_ATTEMPTS = 5
export const STAFF_PIN_LOCK_MINUTES = 15
export const STAFF_SESSION_TTL_HOURS = 12

// ── Member LIFF session (Phase 7 Slice 1) ─────────────────────────────────────
// Long-lived: members visit weekly and LIFF re-login is cheap. One member_sessions
// row per login (multi-device allowed); expired rows are lazily deleted at the
// owner's next login.
export const MEMBER_SESSION_TTL_DAYS = 30

// ── Admin UI session (Phase 8 Slice 1) ────────────────────────────────────────
// Per-admin username+password (admin_accounts). Short TTL — admin holds write power
// over PII, and a password-manager re-login is cheap on a desktop. Lockout follows
// staff semantics, but an EXPIRED lock starts a new counting round (see
// apply_admin_login_failure, 0025).
export const ADMIN_LOGIN_MAX_ATTEMPTS = 5
export const ADMIN_LOGIN_LOCK_MINUTES = 15
export const ADMIN_SESSION_TTL_HOURS = 12
