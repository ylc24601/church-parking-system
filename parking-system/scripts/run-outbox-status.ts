// Local dev / ops visibility into notification_outbox health (Phase 4 Slice C).
// Operation-safe aggregate — counts / notification-type names / sanitized error codes /
// timestamps only. No mutation.
//   npm run job:outbox-status
//   npm run job:outbox-status -- --now 2099-06-01T03:00:00Z   (testing: override "now")
try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may be provided by the shell instead */
}

import { getOutboxHealth } from '../server/services/outboxHealthService'

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function resolveNowArg(): Date | undefined {
  const raw = argValue('--now')
  if (raw === undefined) return undefined
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) {
    console.error(`invalid --now: ${raw} (must be an ISO date-time)`)
    process.exit(1)
  }
  return d
}

async function main() {
  const now = resolveNowArg()
  const health = await getOutboxHealth({ now })
  console.log(JSON.stringify(health, null, 2))
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
