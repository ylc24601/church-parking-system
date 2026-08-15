// #35 — `?status=` / `?priority=` are public input, so they get their own tested parser
// rather than inline comparisons in the page (a page file also can't export arbitrary
// helpers for tests to import — same reasoning as members/parsePage.ts).
//
// ── Unrecognised means "no filter", never "no rows" ──────────────────────────
// Both params fall back to showing everything. A stale bookmark, a typo, or a hand-typed
// ?status=foo must not render a page with no sections and no explanation — that reads as
// broken, on the one page an operator opens when they already suspect something is wrong.
// The two params deliberately share this direction; an earlier revision had `status`
// filtering to nothing while `priority` fell back, which is the same input class treated
// two opposite ways.

export type WeekBand = 'priority' | 'general'

export interface WeekFilters {
  showPending: boolean
  showWaiting: boolean
  band: WeekBand | null   // null = both bands
}

// searchParams values can be string[] (?status=a&status=b). That is not a single filter,
// so it falls back with everything else.
function one(raw: string | string[] | undefined): string | undefined {
  return typeof raw === 'string' ? raw : undefined
}

export function parseWeekFilters(params: {
  status?: string | string[] | undefined
  priority?: string | string[] | undefined
}): WeekFilters {
  const status = one(params.status)
  const priority = one(params.priority)

  // Only the two known values narrow; anything else (including undefined) shows both.
  const narrowsPending = status === 'pending'
  const narrowsWaiting = status === 'waiting'
  const bothStatuses = !narrowsPending && !narrowsWaiting

  // effective_priority 1 and 2 are both 「優先」 (lib/weekDemand.ts owns that definition:
  // the band the Friday sort ranks first, which includes P1). 3 is 「一般」. The page shows
  // exactly these two bands, so ?priority=1 and ?priority=2 are the same filter.
  const band: WeekBand | null =
    priority === '1' || priority === '2' ? 'priority' : priority === '3' ? 'general' : null

  return {
    showPending: bothStatuses || narrowsPending,
    showWaiting: bothStatuses || narrowsWaiting,
    band,
  }
}

// Keep the band predicate next to the definition above, so a caller cannot drift into its
// own `<= 2` check.
export function isPriorityBand(effectivePriority: number): boolean {
  return effectivePriority <= 2
}

export function matchesBand(effectivePriority: number, band: WeekBand | null): boolean {
  if (band === null) return true
  return band === 'priority' ? isPriorityBand(effectivePriority) : !isPriorityBand(effectivePriority)
}
