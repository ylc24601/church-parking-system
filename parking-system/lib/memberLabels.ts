// Member-voice display labels, shared by the member page and the member-facing LINE
// notifications (the staff/print equivalents live in lib/staffRow.ts and deliberately use a
// denser format — 'M/D 主日' — for table cells). Both surfaces name the same Sunday, so one
// copy of the wording; two would drift.
//
// No imports: this is reachable from a client component.

// 'YYYY-MM-DD' → 'M月D日 主日'. Anything else → null, and the caller picks its own fallback.
//
// Callers include the notification renderer, whose payload is JSON read back out of
// notification_outbox — persisted, and therefore not to be trusted. A shape check alone is not
// enough: /^\d{4}-\d{2}-\d{2}$/ happily admits '2026-02-31' or '2026-13-40', which would print a
// date that does not exist. Round-tripping through Date and comparing the parts back catches
// those, because JS rolls 2/31 over to 3/3 instead of rejecting it.
//
// Not checked: whether the date really is a Sunday. That is weekly_events.sunday_date's business
// constraint; this function's job is only to refuse a date that isn't real.
export function memberSundayLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return null

  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const d = new Date(Date.UTC(year, month - 1, day))
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null
  }
  return `${month}月${day}日 主日`
}

// { hour, minute } → 'HH:MM'. RELEASE_TIMES (lib/allocation/rules) stores the release deadlines
// as parts, not strings, so every surface that shows one would otherwise redo the zero-padding.
export function releaseTimeLabel(t: { hour: number; minute: number }): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(t.hour)}:${pad(t.minute)}`
}
