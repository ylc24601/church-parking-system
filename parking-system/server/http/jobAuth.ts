// Reads JOB_TRIGGER_SECRET / CRON_SECRET — machine-enforced server boundary (build-time
// error if a Client Component ever pulls this in). See lib/supabase/server.ts.
import 'server-only'

import { timingSafeEqual } from 'node:crypto'

// Constant-time compare of `provided` against `expected`. Fails closed: an unset/empty
// expected secret (misconfigured deploy) or a missing provided value is never a match.
function secretMatches(provided: string | null | undefined, expected: string | undefined): boolean {
  if (!expected || !provided) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

// Constant-time check of the x-job-secret header against JOB_TRIGGER_SECRET.
export function jobSecretValid(provided: string | null): boolean {
  return secretMatches(provided, process.env.JOB_TRIGGER_SECRET)
}

// Phase 4 Slice C — accept EITHER the manual/external-scheduler `x-job-secret`
// (JOB_TRIGGER_SECRET) OR the Vercel-Cron `Authorization: Bearer <CRON_SECRET>` header.
// Fails closed when the relevant secret is unset/empty; the Authorization branch only
// matches a well-formed `Bearer <token>` scheme. Used by the dispatch + outbox-status routes.
export function cronOrJobSecretValid(request: Request): boolean {
  if (secretMatches(request.headers.get('x-job-secret'), process.env.JOB_TRIGGER_SECRET)) return true
  const auth = request.headers.get('authorization')
  if (!auth) return false
  const m = /^Bearer (.+)$/.exec(auth)
  if (!m) return false
  return secretMatches(m[1], process.env.CRON_SECRET)
}

export function unauthorized(): Response {
  return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
}
