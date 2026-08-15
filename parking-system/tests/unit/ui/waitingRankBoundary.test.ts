import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// ── The waiting-rank boundary (#35 / F-001) ──────────────────────────────────
// `allocation_order` is a GLOBAL index the Friday allocator stamps onto approved AND
// waiting rows alike, so the first waiting member carries `capacity + 1`. What that
// member was actually told — in LINE and on /member — is a different number, kept by
// repo.getWaitingRank(). /admin/week exists to settle exactly that conversation, so it
// must render the member's number.
//
// The first cut of this page rendered `allocation_order` raw. It shipped green: every
// test fixture used 1, 2, 3, where the two numbers coincide. The pure tests now use
// capacity + N and cover rank-then-filter — but neither reaches the JSX, and this repo
// has no page-component test harness (same constraint noted in lib/adminNav.ts).
//
// ── What this test does and does not do ──────────────────────────────────────
// It is a static source lock, not a render assertion. It catches the two regressions
// that would have to be written as source changes in this file:
//   - going back to printing `allocation_order` in the page
//   - renumbering rows in the page (which cannot produce `r.waitingRank` as the value)
// It does NOT prove what the browser paints, and it cannot catch a rename that keeps
// the identifier. Treated as a tripwire on a known-expensive mistake, not as coverage.

const PAGE = path.resolve(__dirname, '../../../app/admin/week/page.tsx')

describe('waiting rank boundary — /admin/week', () => {
  const source = readFileSync(PAGE, 'utf8')

  it('reads a non-empty page source', () => {
    // Guards the guard: a moved/renamed page would otherwise make the assertions below
    // pass over an empty string.
    expect(source.length).toBeGreaterThan(0)
  })

  it('renders the waiting position from waitingRank', () => {
    expect(source).toContain('rank={r.waitingRank}')
  })

  it('never surfaces raw allocation_order to the operator', () => {
    // The page has no legitimate use for the column: the service sorts by it and the
    // rank is derived from that order, both upstream of here.
    expect(source).not.toContain('allocation_order')
  })
})
