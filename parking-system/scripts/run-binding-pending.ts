// List pending binding claims for admin review (Phase 7 Slice 2). FIFO by last update so the
// oldest claim is reviewed first. Codes and phones are ALWAYS masked; use binding:approve
// --pending-id <id> for the full preview (matched member name etc.).
//   npm run binding:pending                # oldest 20
//   npm run binding:pending -- --limit 50  # 1..100
try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may be provided by the shell instead */
}

import { listPendingBindings } from '../server/services/bindingAdminService'

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const fmt = (iso: string) => iso.replace('T', ' ').slice(5, 16)   // MM-DD HH:mm (UTC)

async function main() {
  const limitRaw = argValue('--limit')
  const limit = limitRaw === undefined ? undefined : Number(limitRaw)
  if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
    throw new Error('usage: binding:pending [--limit 1..100]')
  }

  const items = await listPendingBindings({ limit })
  if (items.length === 0) {
    console.log('目前無待審申請')
    return
  }

  console.log('ID        SOURCE    SUBMITTED     UPDATED       RETRIES  CLAIM')
  for (const it of items) {
    console.log(
      `${it.shortId}  ${it.source.padEnd(8)}  ${fmt(it.submittedAt)}   ${fmt(it.lastUpdatedAt)}   ${String(it.resubmits).padEnd(7)}  ${it.claim}`,
    )
  }
  console.log(`\n${items.length} pending（審核：npm run binding:approve -- --pending-id <完整id>；時間為 UTC）`)
  console.log('完整 id 對照：')
  for (const it of items) console.log(`  ${it.shortId} = ${it.id}`)
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
