import type { P2Reason } from '@/lib/memberImportSchema'

// ── P2 reason display labels (Wave 2B-2b / #10) ──────────────────────────────
// Client-safe: no I/O, no server imports — the eligibility form's <select> imports this
// from a client component, and the two admin pages render it server-side.
//
// This map was copy-pasted verbatim in app/admin/members/[id]/page.tsx and
// app/admin/eligibility/page.tsx; the form's dropdown would have been a third copy, and a
// dropdown that disagrees with the page above it is the kind of thing nobody notices.
//
// ⚠️ NOT the same vocabulary as REASON_ALIASES in lib/memberImportSchema.ts. That maps the
// CSV's INPUT aliases (行動不便 / 短期不便) onto the enum; this is the UI's DISPLAY label
// (行動不便（長期）/（短期）). They share the five enum values and nothing else — merging
// them would put CSV shorthand on the admin pages, or page labels into the import parser.
export const P2_REASON_LABEL: Record<P2Reason, string> = {
  mobility_long: '行動不便（長期）',
  mobility_short: '行動不便（短期）',
  pregnancy: '孕婦',
  elderly_companion: '長者同行',
  child_companion: '幼兒同行',
}

// The order the form offers them in: the two permanent reasons first, then the windowed
// ones. Derived from the label map so a new enum value cannot be silently missing here.
export const P2_REASON_OPTIONS: P2Reason[] = [
  'mobility_long',
  'elderly_companion',
  'mobility_short',
  'pregnancy',
  'child_companion',
]

// Only child_companion derives its expiry from a birthdate (0033's
// eligibility_child_expiry_derived_ck enforces it), so only it may carry one.
export function reasonUsesChildBirthdate(reason: P2Reason): boolean {
  return reason === 'child_companion'
}

export function p2ReasonLabel(reason: string | null): string {
  if (reason === null) return '—'
  return P2_REASON_LABEL[reason as P2Reason] ?? reason
}
