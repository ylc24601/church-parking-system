// Client-safe member-maintenance DTOs and operator copy (Tier 0-2 / 0038). No I/O, no
// imports — the shapes the server has already made safe to show, plus the one place the
// Chinese wording for each refusal lives.
//
// It lives in lib/ for the reason lib/memberAdminTypes.ts does: the forms that render this
// are Client Components, and server/services/memberMaintenanceService reaches
// lib/supabase/server (a SERVICE-ROLE client, now guarded by `import 'server-only'`). A
// value import from a client component would fail the build — correctly — so the types the
// UI needs must not live behind that boundary at all.

// Every typed refusal the four maintenance RPCs can return. Kept as one union rather than
// four because the reasons overlap heavily (the actor guards, the identity-uniqueness
// refusal) and the HTTP mapping is shared.
export type MemberMaintenanceReason =
  // The ACTOR. Both are race guards — adminAuth deletes a disabled account's session on
  // every request — so an operator should never see either.
  | 'acting_admin_not_found'
  | 'acting_admin_disabled'
  // The TARGET is gone.
  | 'not_found'
  | 'member_not_found'
  | 'vehicle_not_found'
  // The INPUT. Judged by the RPC, never by the form: one authority, so every entry point
  // (this UI, the CSV import, a future script) agrees on what a name or a plate is.
  | 'invalid_name'
  | 'invalid_phone'
  | 'invalid_plate'
  // The identity gate. Not an error — the first half of a two-step decision.
  | 'homonym_requires_confirmation'
  // The roster moved between the prompt and the confirmation. Fails closed: the operator
  // confirmed a set that no longer describes reality.
  | 'homonym_confirmation_stale'
  | 'phone_in_use'
  // Plate lifecycle.
  | 'active_plate_owned_by_self'
  | 'active_plate_owned_by_other'
  | 'inactive_plate_exists'
  | 'already_active'
  | 'already_inactive'
  | 'unfinished_reservations'

// A member who might be the same person as the one being created/imported. NOT an
// assertion that they are — the name key is a fail-closed candidate detector, biased
// toward asking, because over-asking costs one confirmation while under-asking costs a
// duplicate identity this system has no tool to repair.
export interface IdentityCandidate {
  id: string
  // Masked before it reaches the client. The operator needs enough to recognise a person
  // they know, not the full number of somebody they are about to decide is unrelated.
  phoneMasked: string
  // 'same_name_and_plate' can only come from the CSV import, which has plates to compare;
  // the single-member form has no vehicle input, so it always reports 'same_name'.
  evidence: 'same_name' | 'same_name_and_plate'
}

// ONE copy of the operator-facing wording, so the four forms cannot drift apart.
//
// Each string says what happened AND what to do next — a refusal an operator cannot act on
// is just a wall. The two that are genuinely unreachable in normal operation
// (acting_admin_*) still get real copy rather than a shrug: if they ever appear, the person
// reading them needs to know it is about their own account, not the member's.
export const MEMBER_MAINTENANCE_MESSAGE: Record<MemberMaintenanceReason, string> = {
  acting_admin_not_found: '找不到你的管理員帳號，請重新登入。',
  acting_admin_disabled: '你的管理員帳號已停用，請聯絡系統管理員。',
  not_found: '找不到這位會友，可能已被其他人變更，請重新整理。',
  member_not_found: '找不到這位會友，可能已被其他人變更，請重新整理。',
  vehicle_not_found: '找不到這輛車，可能已被其他人變更，請重新整理。',
  invalid_name: '姓名不可空白。',
  invalid_phone: '手機號碼格式需為 09 開頭的 10 碼數字。',
  invalid_plate: '車牌需至少包含一個英文字母或數字。',
  homonym_requires_confirmation: '名冊中已有同名會友，請確認是否為不同人。',
  homonym_confirmation_stale: '同名會友清單在你確認期間有變動，請重新確認下方最新名單。',
  phone_in_use: '這個手機號碼已登記給另一位會友。',
  active_plate_owned_by_self: '這輛車已經登記在這位會友名下。',
  active_plate_owned_by_other: '這個車牌目前登記在另一位會友名下，需請對方先停用該車。',
  inactive_plate_exists: '這位會友先前登記過這個車牌，請直接「恢復使用」該筆紀錄，不要重複新增。',
  already_active: '這輛車已經是使用中。',
  already_inactive: '這輛車已經停用。',
  unfinished_reservations: '這輛車還有尚未結束的預約，請先處理該筆預約再停用。',
}

// A reason this build does not know (new DB + old app). Never silently swallowed: the
// operator is told plainly that nothing was changed, because that is the one fact they
// need — the DB's audit row holds the detail.
export const MEMBER_MAINTENANCE_FALLBACK_MESSAGE = '這項操作被拒絕，未做任何變更。請重新整理後再試，或聯絡系統管理員。'

export function memberMaintenanceMessage(reason: string): string {
  return Object.prototype.hasOwnProperty.call(MEMBER_MAINTENANCE_MESSAGE, reason)
    ? MEMBER_MAINTENANCE_MESSAGE[reason as MemberMaintenanceReason]
    : MEMBER_MAINTENANCE_FALLBACK_MESSAGE
}
