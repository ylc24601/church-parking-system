import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// ── The action-colour boundary ───────────────────────────────────────────────
// docs/ui-mockups/design-spec.md §2 (2026-08-04, #39): "info 藍只用於狀態 Badge，
// 不再作為任何端別的動作色" — the same blue used to mean both "this is a status"
// and "press this", which is two meanings for one colour.
//
// The token split is what makes this checkable without parsing JSX:
//
//   bg-info-fg   solid blue fill — only ever appeared on action buttons
//   bg-info-bg   pale blue surface — status Badge, notice panels  (allowed)
//   text-/border-/accent-info-fg   status text, outlines, checkbox accents (allowed)
//
// So the invariant reduces to: `bg-info-fg` must not appear under app/ at all.
//
// #39 shipped without this test and left two buttons behind — StaffCheckIn's
// 「確認登記」 and MemberStatus's 「確認保留車位」 — on a slice whose own spec change
// said there should be none. Nothing was red, because nothing was looking.

const APP = path.resolve(__dirname, '../../../app')
const FORBIDDEN = 'bg-info-fg'

function tsxFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...tsxFiles(full))
    else if (entry.endsWith('.tsx')) out.push(full)
  }
  return out
}

describe('action colour boundary', () => {
  const files = tsxFiles(APP)

  it('scans a non-empty set of app components', () => {
    // Guards the guard: a relocated app/ would otherwise make the assertion below
    // pass over an empty list.
    expect(files.length).toBeGreaterThan(0)
  })

  it(`no component under app/ uses ${FORBIDDEN} (info blue is a status tone, not an action colour)`, () => {
    const offenders = files
      .filter(f => readFileSync(f, 'utf8').includes(FORBIDDEN))
      .map(f => path.relative(APP, f))
    expect(offenders).toEqual([])
  })

  it('the status-tone tokens are still in use — this test is not banning info blue outright', () => {
    // Negative control for the rule itself. If Badge stopped using bg-info-bg the
    // assertion above would keep passing while the design system had actually
    // changed underneath it, and nobody would be told.
    const badge = readFileSync(path.join(APP, 'ui/Badge.tsx'), 'utf8')
    expect(badge).toContain('bg-info-bg')
  })
})
