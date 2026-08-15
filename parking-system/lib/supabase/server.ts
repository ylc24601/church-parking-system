// MACHINE-ENFORCED server boundary. Importing this module (directly or transitively)
// from a Client Component is a BUILD-TIME error — not a comment asking nicely.
//
// What this prevents: privileged server-only code being pulled into a Client Component's
// dependency graph. An `import type` that someone later turns into a value import now
// fails the build instead of quietly becoming part of the client graph.
//
// What it is NOT: a bundling fix for the key itself. Next.js only inlines env vars
// prefixed with NEXT_PUBLIC_ and replaces the rest with an empty string, so the
// service-role key was never going to be emitted into browser JavaScript. The boundary
// is about which code is allowed to run where, not about that substitution.
//
// Every service/repository path reaches this file, so this one line guards the whole graph.
//
// COST OF THAT REACH: every environment that loads a server module has to satisfy the
// package's "react-server" export condition, or it throws on import. There are three,
// and each needs its own arrangement:
//
//   Next.js   sets the condition itself when building Server Components — nothing to do.
//   Vitest    vitest.config.ts aliases this ONE package to its empty.js no-op.
//   tsx CLI   the 19 `tsx` scripts in package.json pass --conditions=react-server.
//
// The third was missed when this guard landed (#54) and broke every `npm run job:*` /
// `binding:*` until it was fixed. tests/unit/scripts/cliServerBoundary.test.ts now fails
// if a tsx script is added without the flag, and tests/unit/server/serverOnlyBoundary.test.ts
// fails if this import is removed. Before touching this line, read both.
import 'server-only'

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Server-only Supabase client using the SERVICE ROLE key. It bypasses RLS, so it
// MUST never be imported from client components or shipped to the browser.
// All member/Staff/Admin authorization is enforced in the app layer.

let cached: SupabaseClient | null = null

export function getServiceClient(): SupabaseClient {
  if (cached) return cached

  const url = process.env.SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    throw new Error(
      'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables (server-only).',
    )
  }

  cached = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return cached
}
