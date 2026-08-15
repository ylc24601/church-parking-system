// Reject a captured pending binding (Phase 5B Slice 2). Marks the claim rejected with an
// operator-supplied classification. Addressed by pending id.
//   npm run binding:reject -- --pending-id <uuid> --reason duplicate
//
// ⚠️ Do NOT put a line_user_id or code in --reason (it is stored as-is for audit).
try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may be provided by the shell instead */
}

import { rejectBinding } from '../server/services/bindingAdminService'

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const pendingId = argValue('--pending-id')
  const reason = argValue('--reason')
  if (!pendingId || !reason) {
    throw new Error('usage: binding:reject --pending-id <uuid> --reason <text>')
  }

  const result = await rejectBinding({ pendingId, reason })
  console.log(JSON.stringify(result, null, 2))
  if (result.rejected !== 1) {
    console.error(`not rejected: ${result.reason}`)
    process.exit(1)
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
