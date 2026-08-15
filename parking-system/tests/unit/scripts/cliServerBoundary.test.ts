import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// ── The CLI half of the server-only boundary ─────────────────────────────────
// `server-only` is a marker package: its default entry THROWS, and only the
// "react-server" export condition resolves to a no-op (empty.js). Every execution
// environment that loads a server module therefore has to satisfy that condition
// in its own way:
//
//   Next.js  — sets react-server itself when building Server Components.
//   Vitest   — vitest.config.ts aliases the ONE package to empty.js.
//   tsx CLI  — passes --conditions=react-server (the npm scripts below).
//
// The third one was missed when #54 (a199580) introduced the boundary, and every
// `npm run job:*` / `binding:*` died on startup for three days. It went unnoticed
// because that PR's verification was tsc + eslint + next build + npm test, and NONE
// of those four executes anything under scripts/.
//
// Why tsx uses the condition while Vitest uses an alias — this is deliberate, not an
// inconsistency. vitest.config.ts argues the condition is global and would also flip
// react/next onto their react-server builds. That blast radius is real for Vitest;
// for these CLI processes it is four packages (server-only, client-only, react,
// react-dom), of which the scripts only ever reach `react` — and only for
// `import { cache } from 'react'` in adminTodoService, which is an RSC API anyway.
//
// The tests below guard the invariant that the OTHER boundary test does not:
// serverOnlyBoundary.test.ts proves the guard still EXISTS on the four secret-bearing
// modules; this file proves the CLI environment can legitimately cross it.

const ROOT = path.resolve(__dirname, '../../..')
const PROBE = path.join(ROOT, 'tests/fixtures/serverOnlyProbe.ts')
const MARKER = 'SERVER_ONLY_PROBE_OK'
const REQUIRED_FLAG = '--conditions=react-server'

// Stable across both error shapes. The plain Node/tsx throw is
//   "This module cannot be imported from a Client Component module."   (server-only/index.js)
// while next build reports
//   "'server-only' cannot be imported from a Client Component module"
// Only the shared fragment is asserted, and only as a secondary signal — the hard
// contract is the exit code and the marker, not a marker package's wording.
const SHARED_ERROR_FRAGMENT = 'cannot be imported from a Client Component module'

interface Script { name: string; command: string }

function tsxScripts(): Script[] {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  return Object.entries(pkg.scripts as Record<string, string>)
    .filter(([, command]) => command.startsWith('tsx '))
    .map(([name, command]) => ({ name, command }))
}

// The flags the real scripts run with, read from package.json rather than hard-coded:
// changing the flag to something that does not work fails the positive test below.
function cliFlags(): string[] {
  const [first] = tsxScripts()
  if (!first) throw new Error('no tsx scripts found in package.json')
  return first.command.split(/\s+/).slice(1).filter(a => a.startsWith('-'))
}

function runProbe(flags: string[]) {
  return spawnSync('npx', ['tsx', ...flags, PROBE], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '' },
  })
}

describe('CLI server-only boundary', () => {
  it('every tsx script in package.json passes the react-server condition', () => {
    const missing = tsxScripts()
      .filter(s => !s.command.includes(REQUIRED_FLAG))
      .map(s => s.name)
    expect(missing).toEqual([])
  })

  it('is asserting against a non-empty set of scripts', () => {
    // Guards the guard: a refactor that renames or relocates the CLI entries would
    // otherwise leave the test above passing vacuously over an empty list.
    expect(tsxScripts().length).toBeGreaterThan(0)
  })

  it('a server module loads under the CLI flags', () => {
    const flags = cliFlags()
    expect(flags).toContain(REQUIRED_FLAG)

    const run = runProbe(flags)
    expect(run.status).toBe(0)
    expect(run.stdout).toContain(MARKER)
  }, 30_000)

  // Negative control. Without it the flags would survive as cargo cult long after
  // they stopped being necessary: if `server-only` is ever dropped or changes
  // behaviour, THIS test fails and tells you the 19 flags can go.
  it('the same module fails WITHOUT them — the flags are load-bearing', () => {
    const run = runProbe([])
    expect(run.status).not.toBe(0)
    expect(run.stdout).not.toContain(MARKER)
    expect(run.stderr).toContain(SHARED_ERROR_FRAGMENT)
  }, 30_000)
})
