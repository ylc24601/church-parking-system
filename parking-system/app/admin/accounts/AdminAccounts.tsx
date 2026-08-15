'use client'

import { useState } from 'react'
import { ADMIN_ROLE_LABEL, type AdminRole } from '@/lib/adminRoles'
import Badge, { type BadgeTone } from '../../ui/Badge'

// Admin account management (Wave 2C-2 / #19 adds create + role change). Every row except
// the operator's own is actionable; the operator's own row shows no buttons (self-target
// is refused AND audited by the API, but hiding the buttons avoids a confusing 403).
// Destructive actions require an inline confirmation naming the TARGET USERNAME so a
// stale render or misclick can't silently hit the wrong account. A one-time password
// (from a reset OR a fresh create) is shown ONCE — it lives only in this component's
// local state, is cleared the moment the operator closes it or starts any other action,
// and is never written to storage/URL/log.
//
// Local state is authoritative-DTO-driven, not router.refresh(): the parent copies props
// into useState once, so a refresh would not reset it. Each success response carries the
// canonical row (create) or the new value (role), which we merge into local state.

interface AccountItem {
  id: string
  username: string
  displayName: string | null
  status: 'active' | 'disabled' | 'locked'
  createdAt: string
  role: AdminRole
}

const STATUS_LABEL: Record<AccountItem['status'], string> = {
  active: '啟用中',
  disabled: '已停用',
  locked: '鎖定中',
}
const STATUS_TONE: Record<AccountItem['status'], BadgeTone> = {
  active: 'success',
  disabled: 'danger',
  locked: 'warning',
}
const ROLE_TONE: Record<AdminRole, BadgeTone> = {
  superadmin: 'priority',
  clerk: 'neutral',
}

type PendingConfirm =
  | { action: 'disable' | 'enable' | 'revoke' | 'reset'; id: string; username: string }
  | { action: 'role'; id: string; username: string; newRole: AdminRole }
  | { action: 'create'; username: string; displayName: string | null; role: AdminRole }

interface CredentialResult {
  kind: 'reset' | 'created'
  username: string
  password: string
  disabled: boolean
}

// The full reason set (2C-2). username_taken must point at the next step, not just
// "already exists": a create can commit and its response be lost before the operator sees
// the one-time password, and a retry then reads as this.
const REASON_MESSAGE: Record<string, string> = {
  cannot_target_self: '無法對自己的帳號執行此操作',
  last_active_superadmin: '至少要保留一位啟用中的系統管理員，無法停用或降級最後一位',
  forbidden_role: '權限不足：只有系統管理員可以執行帳號管理',
  acting_admin_disabled: '你的帳號已被停用，請重新登入',
  acting_admin_not_found: '找不到你的帳號，請重新登入',
  username_taken:
    '此帳號名稱已存在。若剛才建立時連線中斷，請重新載入帳號清單確認；若帳號已建立但未取得密碼，請用「重設密碼」重新產生。',
  not_found: '查無此帳號',
  invalid_request: '請求格式不正確',
}

const CREATE_BUSY = '__create__'

export default function AdminAccounts({
  items,
  currentAdminId,
}: {
  items: AccountItem[]
  currentAdminId: string
}) {
  const [accounts, setAccounts] = useState(items)
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null)
  const [credential, setCredential] = useState<CredentialResult | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  // Set when the error is recoverable by reloading the roster (username_taken): the list
  // is local state seeded from props, so an account created by a request whose response
  // was lost is NOT in it — a full reload is the only way to reveal it.
  const [showReload, setShowReload] = useState(false)

  // Create form inputs.
  const [newUsername, setNewUsername] = useState('')
  const [newDisplayName, setNewDisplayName] = useState('')
  const [newRole, setNewRole] = useState<AdminRole>('clerk')

  function resetTransient() {
    // Any new action clears a shown one-time password — it must not linger while the
    // operator's attention moves elsewhere.
    setCredential(null)
    setCopied(false)
    setError(null)
    setShowReload(false)
  }

  function startRowAction(action: 'disable' | 'enable' | 'revoke' | 'reset', id: string, username: string) {
    resetTransient()
    setPendingConfirm({ action, id, username })
  }
  function startRoleChange(id: string, username: string, newRole: AdminRole) {
    resetTransient()
    setPendingConfirm({ action: 'role', id, username, newRole })
  }
  function startCreate() {
    resetTransient()
    setPendingConfirm({
      action: 'create',
      username: newUsername.trim(),
      displayName: newDisplayName.trim() === '' ? null : newDisplayName.trim(),
      role: newRole,
    })
  }

  function cancelConfirm() {
    setPendingConfirm(null)
  }

  function fail(data: { reason?: string } | null) {
    setError(REASON_MESSAGE[data?.reason ?? ''] ?? '操作失敗，請再試一次')
    setShowReload(data?.reason === 'username_taken')
  }

  async function confirmAction() {
    if (!pendingConfirm || busyId) return
    const pc = pendingConfirm
    const busyKey = pc.action === 'create' ? CREATE_BUSY : pc.id
    setBusyId(busyKey)
    setError(null)
    try {
      if (pc.action === 'disable' || pc.action === 'enable') {
        const res = await post('/api/admin/accounts/disable', { targetId: pc.id, disabled: pc.action === 'disable' })
        if (res.ok && res.data?.ok) {
          setAccounts(prev => prev.map(a => (a.id === pc.id ? { ...a, status: pc.action === 'disable' ? 'disabled' : 'active' } : a)))
          setPendingConfirm(null)
        } else fail(res.data)
      } else if (pc.action === 'revoke') {
        const res = await post('/api/admin/accounts/revoke-sessions', { targetId: pc.id })
        if (res.ok && res.data?.ok) setPendingConfirm(null)
        else fail(res.data)
      } else if (pc.action === 'reset') {
        const res = await post('/api/admin/accounts/reset-password', { targetId: pc.id })
        if (res.ok && res.data?.ok) {
          const d = res.data as { username: string; password: string; disabled: boolean }
          setCredential({ kind: 'reset', username: d.username, password: d.password, disabled: d.disabled })
          setPendingConfirm(null)
        } else fail(res.data)
      } else if (pc.action === 'role') {
        const res = await post('/api/admin/accounts/role', { targetId: pc.id, role: pc.newRole })
        if (res.ok && res.data?.ok) {
          const nextRole = (res.data as { role: AdminRole }).role
          setAccounts(prev => prev.map(a => (a.id === pc.id ? { ...a, role: nextRole } : a)))
          setPendingConfirm(null)
        } else fail(res.data)
      } else if (pc.action === 'create') {
        const res = await post('/api/admin/accounts/create', {
          username: pc.username, displayName: pc.displayName, role: pc.role,
        })
        if (res.ok && res.data?.ok) {
          const d = res.data as { account: AccountItem; password: string }
          setAccounts(prev => [...prev, d.account].sort((x, y) => x.username.localeCompare(y.username)))
          setCredential({ kind: 'created', username: d.account.username, password: d.password, disabled: false })
          setNewUsername('')
          setNewDisplayName('')
          setNewRole('clerk')
          setPendingConfirm(null)
        } else fail(res.data)
      }
    } catch {
      setError('連線失敗，請再試一次')
    } finally {
      setBusyId(null)
    }
  }

  const createDisabled = newUsername.trim().length < 3

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col gap-6 bg-page px-6 py-10 text-ink">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">帳號管理</h1>
      </header>

      {error && (
        <div className="flex flex-col gap-2 rounded-xl border border-danger-fg/30 bg-danger-bg px-4 py-3 text-sm text-danger-fg">
          <p>{error}</p>
          {showReload && (
            <div>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="inline-flex min-h-11 items-center rounded-lg border border-danger-fg/40 px-4 text-sm font-semibold text-danger-fg transition-colors hover:bg-danger-bg focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
              >
                重新載入帳號清單
              </button>
            </div>
          )}
        </div>
      )}

      {credential && (
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-5">
          <p className="rounded-lg border border-warning-fg/30 bg-warning-bg px-4 py-3 text-sm text-warning-fg">
            請立即複製並安全轉交；關閉此視窗後，Admin UI 不會再次顯示這組密碼。
          </p>
          <p className="text-sm text-muted">帳號：{credential.username}</p>
          <div className="flex items-center gap-3">
            <code className="rounded-xl border border-primary/40 bg-success-bg px-5 py-3 text-xl font-semibold tracking-wide text-primary-deep">
              {credential.password}
            </code>
            <button
              type="button"
              onClick={async () => { await navigator.clipboard?.writeText(credential.password); setCopied(true) }}
              className="inline-flex min-h-11 items-center rounded-xl border border-border px-4 text-sm text-ink transition-colors hover:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            >
              {copied ? '已複製' : '複製'}
            </button>
          </div>
          <p className="text-sm text-muted">
            {credential.kind === 'created'
              ? '帳號已建立；請安全轉交這組登入密碼並由本人妥善保存。若密碼遺失，需請系統管理員重設。'
              : credential.disabled
                ? '密碼已重設；此帳號目前為停用狀態，需先重啟才能登入。'
                : '密碼已重設；該帳號所有裝置已登出，需以新密碼重新登入。'}
          </p>
          <div>
            <button
              type="button"
              onClick={() => { setCredential(null); setCopied(false) }}
              className="inline-flex min-h-11 items-center rounded-xl border border-border px-4 text-sm text-ink transition-colors hover:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            >
              關閉
            </button>
          </div>
        </div>
      )}

      {pendingConfirm && (
        <div className={`flex flex-col gap-3 rounded-xl border p-5 ${isHighPrivilege(pendingConfirm)
          ? 'border-danger-fg/40 bg-danger-bg'
          : 'border-warning-fg/30 bg-warning-bg'}`}>
          <p className={`text-sm ${isHighPrivilege(pendingConfirm) ? 'text-danger-fg' : 'text-warning-fg'}`}>
            {confirmMessage(pendingConfirm)}
          </p>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={confirmAction}
              disabled={busyId !== null}
              className={`inline-flex min-h-11 items-center rounded-lg px-4 text-sm font-semibold text-white transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ${
                isHighPrivilege(pendingConfirm) ? 'bg-danger-fg active:bg-danger-fg/90' : 'bg-warning-fg active:bg-warning-fg/90'
              }`}
            >
              {busyId !== null ? '處理中…' : '確認'}
            </button>
            <button
              type="button"
              onClick={cancelConfirm}
              disabled={busyId !== null}
              className="inline-flex min-h-11 items-center rounded-lg border border-border px-4 text-sm text-ink transition-colors hover:border-primary disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* 新增管理者 */}
      <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-5">
        <h2 className="text-base font-semibold">新增管理者</h2>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">帳號（3–32 字，小寫英數 . _ -）</span>
            <input
              value={newUsername}
              onChange={e => setNewUsername(e.target.value)}
              autoComplete="off"
              className="min-h-11 rounded-lg border border-border bg-page px-3 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">顯示名稱（可留空）</span>
            <input
              value={newDisplayName}
              onChange={e => setNewDisplayName(e.target.value)}
              autoComplete="off"
              className="min-h-11 rounded-lg border border-border bg-page px-3 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">角色</span>
            <select
              value={newRole}
              onChange={e => setNewRole(e.target.value as AdminRole)}
              className="min-h-11 rounded-lg border border-border bg-page px-3 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <option value="clerk">{ADMIN_ROLE_LABEL.clerk}</option>
              <option value="superadmin">{ADMIN_ROLE_LABEL.superadmin}</option>
            </select>
          </label>
          <button
            type="button"
            onClick={startCreate}
            disabled={createDisabled || busyId !== null}
            className="inline-flex min-h-11 items-center rounded-lg bg-primary px-4 text-sm font-semibold text-white transition-colors active:bg-primary-deep disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
          >
            新增管理者
          </button>
        </div>
        <p className="text-xs text-muted">建立後會產生一次性密碼，僅顯示這一次。</p>
      </section>

      <div className="w-full overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[820px] text-left text-sm">
          <thead className="bg-surface text-muted">
            <tr>
              <th className="px-4 py-3 font-normal">帳號</th>
              <th className="px-4 py-3 font-normal">顯示名稱</th>
              <th className="whitespace-nowrap px-4 py-3 font-normal">角色</th>
              <th className="whitespace-nowrap px-4 py-3 font-normal">狀態</th>
              <th className="whitespace-nowrap px-4 py-3 font-normal">建立時間</th>
              <th className="px-4 py-3 font-normal"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {accounts.map(a => {
              const isSelf = a.id === currentAdminId
              const otherRole: AdminRole = a.role === 'superadmin' ? 'clerk' : 'superadmin'
              return (
                <tr key={a.id} className="bg-surface">
                  <td className="px-4 py-3 text-ink">{a.username}</td>
                  <td className="px-4 py-3 text-muted">{a.displayName ?? '—'}</td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <Badge variant="outline" tone={ROLE_TONE[a.role]}>{ADMIN_ROLE_LABEL[a.role]}</Badge>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <Badge variant="outline" tone={STATUS_TONE[a.status]}>{STATUS_LABEL[a.status]}</Badge>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-muted">{a.createdAt.slice(0, 10)}</td>
                  <td className="px-4 py-3">
                    {isSelf ? (
                      <div className="text-xs text-muted">
                        <Badge variant="outline" tone="neutral">目前登入</Badge>
                        <p className="mt-1">結束自己的 session 請用登出</p>
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => startRowAction(a.status === 'disabled' ? 'enable' : 'disable', a.id, a.username)}
                          className="inline-flex items-center whitespace-nowrap rounded-lg border border-border px-3 py-2 text-xs text-ink transition-colors hover:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                        >
                          {a.status === 'disabled' ? '啟用' : '停用'}
                        </button>
                        <button
                          type="button"
                          onClick={() => startRoleChange(a.id, a.username, otherRole)}
                          className="inline-flex items-center whitespace-nowrap rounded-lg border border-border px-3 py-2 text-xs text-ink transition-colors hover:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                        >
                          改為{ADMIN_ROLE_LABEL[otherRole]}
                        </button>
                        <button
                          type="button"
                          onClick={() => startRowAction('reset', a.id, a.username)}
                          className="inline-flex items-center whitespace-nowrap rounded-lg border border-border px-3 py-2 text-xs text-ink transition-colors hover:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                        >
                          重設密碼
                        </button>
                        <button
                          type="button"
                          onClick={() => startRowAction('revoke', a.id, a.username)}
                          className="inline-flex items-center whitespace-nowrap rounded-lg border border-border px-3 py-2 text-xs text-ink transition-colors hover:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                        >
                          撤銷所有 session
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </main>
  )
}

async function post(url: string, body: unknown): Promise<{ ok: boolean; data: { ok?: boolean; reason?: string; [k: string]: unknown } | null }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => null)
  return { ok: res.ok, data }
}

// A superadmin grant is the one action worth a stronger warning than a role name — it
// hands over account management, ops and the audit log.
function isHighPrivilege(pc: PendingConfirm): boolean {
  return (pc.action === 'create' && pc.role === 'superadmin') || (pc.action === 'role' && pc.newRole === 'superadmin')
}

function confirmMessage(pending: PendingConfirm): string {
  switch (pending.action) {
    case 'disable':
      return `確定停用 admin「${pending.username}」？此操作會立即使其所有裝置登出。`
    case 'enable':
      return `確定重啟 admin「${pending.username}」？重啟後該帳號需重新登入。`
    case 'revoke':
      return `確定撤銷 admin「${pending.username}」的所有登入 session？`
    case 'reset':
      return `確定重設 admin「${pending.username}」的密碼？系統將產生新密碼並使其所有裝置登出。`
    case 'role':
      return pending.newRole === 'superadmin'
        ? `確定將「${pending.username}」升為系統管理員？此帳號將可管理其他管理者帳號、查看稽核記錄及操作營運維護功能。`
        : `確定將「${pending.username}」改為幹事？此帳號將無法再管理其他管理者帳號、查看稽核記錄與營運維護。變更後其所有裝置會登出。`
    case 'create':
      return pending.role === 'superadmin'
        ? `確定建立系統管理員「${pending.username}」？此帳號可管理其他管理者帳號、查看稽核記錄及操作營運維護功能。`
        : `確定建立幹事「${pending.username}」？`
  }
}
