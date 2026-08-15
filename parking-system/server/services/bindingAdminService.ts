import {
  createParkingRepository,
  type ParkingRepository,
  type PendingBindingListRow,
} from '@/server/repositories/parkingRepository'
import {
  BINDING_CODE_FORMAT,
  generateBindingCode,
  maskCode,
  maskLineUserId,
  maskPhone,
  normalizeBindingCode,
} from '@/lib/binding'

// Phase 5B Slice 2 — service layer behind the binding CLI. All member-facing values are masked
// here (server-side) before they reach any output; raw line_user_id / submitted_code never leave
// this layer except the one deliberate full-code return from issueBindingCode (the operator must
// read it to the member once).

const MAX_CODE_ATTEMPTS = 5

export interface IssuedCode {
  code: string          // FULL code — CLI prints it exactly once
  expiresAt: string
  userId: string
  displayName: string
}

export async function issueBindingCode(
  params: {
    userId: string
    ttlDays: number
    code?: string
    createdBy?: string | null
    note?: string | null
    now?: Date
  },
  repo: ParkingRepository = createParkingRepository(),
): Promise<IssuedCode> {
  const { userId, ttlDays, code, createdBy = null, note = null, now = new Date() } = params

  if (!Number.isInteger(ttlDays) || ttlDays < 1) {
    throw new Error(`--ttl-days must be a positive integer, got "${ttlDays}"`)
  }
  const displayName = await repo.getUserDisplayName(userId)
  if (displayName === null) throw new Error('user_id not found')

  const expiresAt = new Date(now.getTime() + ttlDays * 86_400_000).toISOString()

  // Explicit code: single attempt, format-checked. A collision is a hard error (don't silently
  // reuse someone else's code).
  if (code !== undefined) {
    const normalized = normalizeBindingCode(code)
    if (!BINDING_CODE_FORMAT.test(normalized)) {
      throw new Error(`--code must match ${BINDING_CODE_FORMAT} after trim+uppercase, got "${normalized}"`)
    }
    const { inserted } = await repo.insertBindingCode({ code: normalized, userId, expiresAtIso: expiresAt, createdBy, note })
    if (!inserted) throw new Error('code already exists — choose another or omit --code to auto-generate')
    return { code: normalized, expiresAt, userId, displayName }
  }

  // Generated code: retry on the (rare) unique collision.
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
    const generated = generateBindingCode()
    const { inserted } = await repo.insertBindingCode({ code: generated, userId, expiresAtIso: expiresAt, createdBy, note })
    if (inserted) return { code: generated, expiresAt, userId, displayName }
  }
  throw new Error(`failed to generate a unique code after ${MAX_CODE_ATTEMPTS} attempts`)
}

export interface ApprovePreview {
  found: boolean
  pendingStatus?: string
  claimSource?: string
  // Optimistic-concurrency revision (= superseded_count, bumped on every capture upsert — a
  // caller-supplied timestamp could collide): applyApproveBinding must receive exactly this
  // value; a re-submission between preview and apply then yields 'pending_changed'.
  claimVersion?: number
  lineUserIdMasked?: string
  submittedCodeMasked?: string | null       // keyword claims
  claimedPhoneMasked?: string | null        // liff claims
  claimedName?: string | null               // liff claims — full, the admin compares it to the member record
  matchedUserId?: string | null
  matchedDisplayName?: string | null
  wouldApprove: boolean
  reason: string
}

// Dry-run preview: masked display fields + the predicted typed reason (from the RPC, the single
// source of truth). Writes nothing.
export async function previewApproveBinding(
  params: { pendingId: string; now?: Date },
  repo: ParkingRepository = createParkingRepository(),
): Promise<ApprovePreview> {
  const { pendingId, now = new Date() } = params
  const preview = await repo.getBindingApprovalPreview(pendingId)
  const predicted = await repo.approvePendingBinding({ pendingId, nowIso: now.toISOString(), dryRun: true })

  if (!preview) {
    return { found: false, wouldApprove: predicted.would_approve, reason: predicted.reason }
  }
  return {
    found: true,
    pendingStatus: preview.pending_status,
    claimSource: preview.claim_source,
    claimVersion: preview.superseded_count,
    lineUserIdMasked: maskLineUserId(preview.line_user_id),
    submittedCodeMasked: preview.submitted_code === null ? null : maskCode(preview.submitted_code),
    claimedPhoneMasked: preview.claimed_phone === null ? null : maskPhone(preview.claimed_phone),
    claimedName: preview.claimed_name,
    matchedUserId: preview.matched_user_id,
    matchedDisplayName: preview.matched_display_name,
    wouldApprove: predicted.would_approve,
    reason: predicted.reason,
  }
}

export async function applyApproveBinding(
  params: { pendingId: string; expectedSupersededCount: number; adminId?: string | null; now?: Date },
  repo: ParkingRepository = createParkingRepository(),
): Promise<{ approved: number; reason: string }> {
  const { pendingId, expectedSupersededCount, adminId = null, now = new Date() } = params
  // 0 is a valid revision (a never-superseded claim) — validate shape, not truthiness.
  if (!Number.isInteger(expectedSupersededCount) || expectedSupersededCount < 0) {
    throw new Error('expectedSupersededCount (claimVersion) is required for an apply')
  }
  // adminId is the decider audit (pending_binding.decided_by_admin_id). Admin routes
  // take it from the SESSION — never from a request body; CLI decisions record null.
  const res = await repo.approvePendingBinding({
    pendingId,
    nowIso: now.toISOString(),
    dryRun: false,
    expectedSupersededCount,
    adminId,
  })
  return { approved: res.approved, reason: res.reason }
}

// ── Pending review queue (Phase 7 Slice 2) ───────────────────────────────────
// FIFO by last_submitted_at so the oldest claim gets reviewed first. Raw code/phone
// are masked HERE — the CLI prints this struct as-is.
// The DTO now lives in lib/ so BindingReview (a Client Component) never imports this
// server-only module. Re-exported so server-side callers keep one import site.
export type { PendingClaimListItem } from '@/lib/bindingAdminTypes'
import type { PendingClaimListItem } from '@/lib/bindingAdminTypes'

const PENDING_LIST_DEFAULT = 20
const PENDING_LIST_MAX = 100

function toPendingClaimListItem(r: PendingBindingListRow): PendingClaimListItem {
  return {
    id: r.id,
    shortId: r.id.slice(0, 8),
    source: r.claim_source,
    submittedAt: r.created_at,
    lastUpdatedAt: r.last_submitted_at,
    resubmits: r.superseded_count,
    claim:
      r.claim_source === 'liff'
        ? `${r.claimed_name ?? '?'} / ${r.claimed_phone === null ? '?' : maskPhone(r.claimed_phone)}`
        : r.submitted_code === null ? '?' : maskCode(r.submitted_code),
  }
}

export async function listPendingBindings(
  params: { limit?: number } = {},
  repo: ParkingRepository = createParkingRepository(),
): Promise<PendingClaimListItem[]> {
  const limit = Math.min(Math.max(Math.trunc(params.limit ?? PENDING_LIST_DEFAULT), 1), PENDING_LIST_MAX)
  const rows = await repo.listPendingBindings(limit)
  return rows.map(toPendingClaimListItem)
}

// Admin UI variant (Phase 8 Slice 1): fetches limit+1 so the page can say "more
// remain beyond these N" instead of silently truncating. CLI keeps the plain list.
export async function listPendingBindingsPage(
  params: { limit?: number } = {},
  repo: ParkingRepository = createParkingRepository(),
): Promise<{ items: PendingClaimListItem[]; hasMore: boolean }> {
  const limit = Math.min(Math.max(Math.trunc(params.limit ?? PENDING_LIST_DEFAULT), 1), PENDING_LIST_MAX)
  const rows = await repo.listPendingBindings(limit + 1)
  return {
    items: rows.slice(0, limit).map(toPendingClaimListItem),
    hasMore: rows.length > limit,
  }
}

// Bound because rejected_reason is stored VERBATIM as audit (and 0025 enforces the
// same bound in the DB). char_length counts code points — compare with [...str],
// not .length (UTF-16 units overcount astral chars).
const MAX_REJECT_REASON_CODEPOINTS = 200

export async function rejectBinding(
  params: { pendingId: string; reason: string; adminId?: string | null; now?: Date },
  repo: ParkingRepository = createParkingRepository(),
): Promise<{ rejected: number; reason: string }> {
  const { pendingId, reason, adminId = null, now = new Date() } = params
  const trimmed = reason.trim()
  if (!trimmed) throw new Error('reason must not be empty')
  if ([...trimmed].length > MAX_REJECT_REASON_CODEPOINTS) {
    throw new Error(`reason must be at most ${MAX_REJECT_REASON_CODEPOINTS} characters`)
  }
  return repo.rejectPendingBinding({ pendingId, reason: trimmed, nowIso: now.toISOString(), adminId })
}
