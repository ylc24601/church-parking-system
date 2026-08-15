import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// ── The server/client boundary, pinned ───────────────────────────────────────
// The real enforcement is `import 'server-only'`: pulling one of these modules into a
// Client Component fails `next build` (verified by hand on this branch — the build
// errors with "'server-only' cannot be imported from a Client Component module" and
// traces back to lib/supabase/server.ts).
//
// What that enforcement is for: keeping privileged server-only code out of a Client
// Component's dependency graph, so a wrong value import is caught at build time rather
// than becoming part of the client graph.
//
// These tests exist because the enforcement is INVISIBLE in a diff. Deleting one
// `import 'server-only'` line looks like removing a stray import, and the build goes
// on passing until someone actually writes the bad import. A build-time guard that can
// be silently deleted is a guard with a hole in it, so the guard itself is pinned here.

const ROOT = path.resolve(__dirname, '../../..')

// Every module that reads one of the CURRENTLY KNOWN server secrets from the environment
// AND is importable from other modules. Route handlers are deliberately absent: they are
// server entry points by construction, not something a component can import.
//
// This list is maintained by hand. Adding a new secret env var means adding it to
// KNOWN_SECRET_ENV below and adding its reader here — see the second test.
const SECRET_BEARING_MODULES = [
  'lib/supabase/server.ts', // SUPABASE_SERVICE_ROLE_KEY — the whole service/repo graph reaches this
  'server/http/jobAuth.ts', // JOB_TRIGGER_SECRET / CRON_SECRET
  'server/http/importConfirmToken.ts', // signs with the service-role key
  'server/services/notification/lineTransport.ts', // LINE_CHANNEL_ACCESS_TOKEN
]

describe('server-only boundary', () => {
  it.each(SECRET_BEARING_MODULES)('%s declares `import \'server-only\'`', (rel) => {
    const src = readFileSync(path.join(ROOT, rel), 'utf8')
    expect(src).toMatch(/^import 'server-only'$/m)
  })

  // SCOPE, stated honestly: this checks the KNOWN secret names below, nothing more. It is
  // not a secret classifier and cannot detect a brand-new env var nobody listed here — a
  // generic one would be guesswork, and a test that overstates its reach is worse than one
  // with a documented edge.
  //
  // What it does buy: a reader of a known secret that appears in a NEW module fails this
  // test, so the guard cannot quietly stop covering the set it claims to cover. Adding a
  // new secret env var is a two-line manual step: add it to KNOWN_SECRET_ENV and add its
  // reader to SECRET_BEARING_MODULES. If either list shrinks, say why in the commit.
  const KNOWN_SECRET_ENV = [
    'SUPABASE_SERVICE_ROLE_KEY',
    'LINE_CHANNEL_ACCESS_TOKEN',
    'LINE_CHANNEL_SECRET',
    'JOB_TRIGGER_SECRET',
    'CRON_SECRET',
  ]

  it('every reader of a KNOWN secret env var (outside route handlers) is in the pinned list', () => {
    const SECRET_NAMES = new RegExp(KNOWN_SECRET_ENV.join('|'))
    const found: string[] = []
    for (const dir of ['lib', 'server']) {
      for (const file of walk(path.join(ROOT, dir))) {
        if (!file.endsWith('.ts') && !file.endsWith('.tsx')) continue
        if (SECRET_NAMES.test(readFileSync(file, 'utf8'))) {
          found.push(path.relative(ROOT, file))
        }
      }
    }
    expect(found.sort()).toEqual([...SECRET_BEARING_MODULES].sort())
  })

  // The second half of the boundary: even a type-only import from a server module is a
  // latent hazard, because turning `import type` into a value import is a one-word edit
  // that a reviewer can miss. Client-safe DTOs live in lib/ instead (lib/memberAdminTypes,
  // lib/opsAdminTypes, …), so a Client Component has no reason to reach into server/ at all.
  it('no Client Component imports from @/server/, not even a type', () => {
    const offenders: string[] = []
    for (const file of walk(path.join(ROOT, 'app'))) {
      if (!file.endsWith('.tsx') && !file.endsWith('.ts')) continue
      const src = readFileSync(file, 'utf8')
      if (!/^\s*['"]use client['"]/m.test(src)) continue
      if (/from\s+['"]@\/server\//.test(src)) offenders.push(path.relative(ROOT, file))
    }
    expect(offenders).toEqual([])
  })
})

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) yield* walk(full)
    else yield full
  }
}
