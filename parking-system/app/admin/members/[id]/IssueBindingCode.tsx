'use client'

import { useState } from 'react'

// Issue a one-time binding code for an UNBOUND member. The full code is shown ONCE
// here; it is never written to localStorage/sessionStorage/URL/log, and a page
// refresh does NOT re-fetch it (the state is component-local). The DB still stores
// the plaintext code, so the copy says the Admin UI won't show it again — not that
// it is technically unrecoverable.

interface Issued {
  code: string
  expiresAt: string
  displayName: string
}

export default function IssueBindingCode({ userId, bound }: { userId: string; bound: boolean }) {
  const [ttlDays, setTtlDays] = useState(14)
  const [note, setNote] = useState('')
  const [issued, setIssued] = useState<Issued | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  if (bound) {
    return <p className="mt-2 text-sm text-muted">此會友已綁定 LINE，無需發碼。</p>
  }

  if (issued) {
    return (
      <div className="mt-3 flex flex-col gap-3">
        <p className="rounded-xl border border-warning-fg/30 bg-warning-bg px-4 py-3 text-sm text-warning-fg">
          請立即複製並轉交；離開此畫面後，Admin UI 不會再次顯示完整綁定碼。
        </p>
        <div className="flex items-center gap-3">
          <code className="rounded-xl border border-primary/40 bg-success-bg px-5 py-3 text-2xl font-semibold tracking-widest text-primary-deep">
            {issued.code}
          </code>
          <button
            type="button"
            onClick={async () => { await navigator.clipboard?.writeText(issued.code); setCopied(true) }}
            className="inline-flex min-h-11 items-center rounded-xl border border-border px-4 text-sm text-ink transition-colors hover:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
          >
            {copied ? '已複製' : '複製'}
          </button>
        </div>
        <p className="text-sm text-muted">
          有效至 {issued.expiresAt.slice(0, 10)}。請轉交 {issued.displayName}，讓他在教會 OA 傳「綁定 {'<碼>'}」，之後到「綁定審核」核准。
        </p>
      </div>
    )
  }

  async function issue() {
    if (submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const trimmedNote = note.trim()
      const res = await fetch('/api/admin/members/binding-code', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId, ttlDays, ...(trimmedNote ? { note: trimmedNote } : {}) }),
      })
      const data = await res.json().catch(() => null)
      if (res.ok && data?.ok) {
        setIssued({ code: data.code, expiresAt: data.expiresAt, displayName: data.displayName })
        return
      }
      const reason = data?.reason
      setError(
        reason === 'already_bound' ? '此會友已綁定，無需發碼'
        : reason === 'member_not_found' ? '查無此會友'
        : reason === 'invalid_request' ? '天數（1–90）或備註（200 字內）不合法'
        : '發碼失敗，請再試一次',
      )
    } catch {
      setError('連線失敗，請再試一次')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mt-3 flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">有效天數</span>
          <input
            type="number"
            min={1}
            max={90}
            value={ttlDays}
            onChange={e => setTtlDays(Number(e.target.value))}
            className="w-24 rounded-lg border border-border bg-surface px-3 py-2 text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/30"
          />
        </label>
        <label className="flex flex-1 flex-col gap-1 text-sm">
          <span className="text-muted">備註（可選）</span>
          <input
            type="text"
            value={note}
            maxLength={200}
            onChange={e => setNote(e.target.value)}
            placeholder="例：小組長轉交"
            className="rounded-lg border border-border bg-surface px-3 py-2 text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/30"
          />
        </label>
      </div>
      <p className="text-xs text-muted">請勿在備註填寫身分證字號、病史等敏感個資。</p>
      {error && <p className="rounded-lg border border-danger-fg/30 bg-danger-bg px-4 py-2 text-sm text-danger-fg">{error}</p>}
      <div>
        <button
          type="button"
          onClick={issue}
          disabled={submitting || ttlDays < 1 || ttlDays > 90}
          className="inline-flex min-h-11 items-center rounded-xl bg-primary px-5 text-sm font-semibold text-white transition-colors hover:bg-primary-strong disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
        >
          {submitting ? '發碼中…' : '產生綁定碼'}
        </button>
      </div>
    </div>
  )
}
