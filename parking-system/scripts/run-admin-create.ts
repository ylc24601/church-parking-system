// Provision an Admin UI operator account (Phase 8 Slice 1).
//   CONFIRM_CREATE_SUPERADMIN=1 npm run admin:create -- --username alice [--display-name 王姐妹]
//   echo 'S3cret-Pass-Word!' | CONFIRM_CREATE_SUPERADMIN=1 npm run admin:create -- --username alice --stdin
//
// There is deliberately NO --password flag: a password on the command line may be
// retained in shell history / the process list (the caveat documented on
// staff:set-pin). The plaintext password is never stored or logged — only its
// scrypt hash lands in admin_accounts.password_hash.
//
// ── Wave 2C-1 (#19): this ALWAYS creates a 系統管理員 (superadmin) ────────────────
// admin_accounts.role defaults to the least-privileged value precisely so a forgotten
// role lands on 幹事 — but this script is the recovery path (the way back in when every
// UI account is locked out), so it must grant full power, which quietly inverts that
// default in the one place a human is most likely to run by hand.
//
// Hence the env gate: no --role flag to get wrong, no interactive prompt to break
// automation, just a fail-closed acknowledgement that a superadmin is what you get. It
// also writes NO audit row — running this needs the service-role key, and that key can
// bypass the audit substrate anyway (see createAdminAccount's comment).
// Read from the SHELL, before .env.local can supply it: the acknowledgement has to be
// something you type for this invocation, not a line someone left switched on in a file.
const CONFIRM_ENV = 'CONFIRM_CREATE_SUPERADMIN'
const confirmed = process.env[CONFIRM_ENV] === '1'

try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may be provided by the shell instead */
}

import { randomBytes } from 'node:crypto'
import { createAdminAccount } from '../server/services/adminAuthService'

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag)
}
function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function main() {
  const username = argValue('--username')
  if (!username) {
    throw new Error('usage: admin:create --username <name> [--display-name <text>] [--stdin]')
  }

  if (!confirmed) {
    throw new Error(
      `這個指令只會建立「系統管理員」（superadmin）帳號——擁有帳號管理、通知系統狀態與稽核記錄的完整權限。\n` +
        `本指令無法建立幹事帳號；請由既有系統管理員至後台「帳號管理」（/admin/accounts）新增。\n` +
        `確認要建立系統管理員，請重跑並加上：${CONFIRM_ENV}=1`,
    )
  }
  console.log('⚠️  即將建立「系統管理員」帳號（完整權限，含帳號管理／通知系統狀態／稽核記錄）')

  let password: string
  let generated = false
  if (hasFlag('--stdin')) {
    password = (await readStdin()).trim()
    if (!password) throw new Error('--stdin given but no password arrived on stdin')
  } else {
    password = randomBytes(18).toString('base64url') // 24 chars, ~144 bits
    generated = true
  }

  const account = await createAdminAccount({
    username,
    password,
    displayName: argValue('--display-name') ?? null,
  })

  console.log(`Admin account created: ${account.username}（系統管理員 / superadmin）`)
  if (generated) {
    // The one deliberate print — it cannot be recovered afterwards.
    console.log('')
    console.log('  一次性密碼（僅顯示這一次，請立即存入教會密碼管理器）:')
    console.log(`  ${password}`)
    console.log('')
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
