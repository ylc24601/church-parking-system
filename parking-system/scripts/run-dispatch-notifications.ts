// Local dev / ops entry point for the notification dispatcher (mirrors run-auto-finalize.ts).
// Claims due notification_outbox rows and sends each via the configured transport.
//   NOTIFICATION_TRANSPORT=mock npm run job:dispatch
//   npm run job:dispatch -- --limit 50
//   npm run job:dispatch -- --now 2099-06-01T03:00:00Z   (testing: override "now")
// NOTIFICATION_TRANSPORT must be 'mock' or 'line'; 'line' also requires LINE_CHANNEL_ACCESS_TOKEN
// or the run fails fast (no silent no-op).
try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may be provided by the shell instead */
}

import { dispatchNotifications, previewDispatch } from '../server/services/notificationDispatchService'

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag)
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function resolveLimitArg(): number | undefined {
  const raw = argValue('--limit')
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) fail(`invalid --limit: ${raw} (must be an integer >= 1)`)
  return n
}

function resolveNowArg(): Date | undefined {
  const raw = argValue('--now')
  if (raw === undefined) return undefined
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) fail(`invalid --now: ${raw} (must be an ISO date-time)`)
  return d
}

async function main() {
  const limit = resolveLimitArg()
  const now = resolveNowArg()
  // --dry-run: no-mutation preview (never resolves transport, never claims).
  const result = hasFlag('--dry-run')
    ? await previewDispatch({ limit, now })
    : await dispatchNotifications({ limit, now })
  console.log(JSON.stringify(result, null, 2))
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
