'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { memberMaintenanceMessage } from '@/lib/memberMaintenanceTypes'

// Edit a member's name and phone (Tier 0-2 / 0038).
//
// This form is the reason the rest of the slice exists. Before it, a member whose phone
// changed could only be "updated" by re-importing them — and the import keys on PHONE, so
// that created a SECOND member holding none of their LINE binding, reservations, penalties
// or eligibility. The member is addressed by id here; the old phone is never a lookup key.
//
// A phone change is confirmed explicitly because it has a consequence the operator cannot
// see from this screen: it rejects that member's outstanding LINE binding claims. Not
// because the claim would otherwise bind to the wrong person — 0038's capture-time snapshot
// closed that off, and approval no longer looks anyone up by phone. It is that the claim's
// identity evidence was "whoever holds this number", and this member no longer does. The
// member re-submits, and the new claim carries a snapshot that is true. That is a real cost
// to a real person, which is why it gets a confirmation step rather than a silent side effect.
export default function MemberIdentityForm({
  userId,
  displayName,
  phone,
}: {
  userId: string
  displayName: string
  phone: string | null
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(displayName)
  const [newPhone, setNewPhone] = useState(phone ?? '')
  const [confirming, setConfirming] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const trimmedName = name.trim()
  const trimmedPhone = newPhone.trim()
  const phoneChanged = trimmedPhone !== (phone ?? '')
  const nameChanged = trimmedName !== displayName
  const anythingChanged = phoneChanged || nameChanged

  function close() {
    setOpen(false)
    setConfirming(false)
    setError(null)
    setName(displayName)
    setNewPhone(phone ?? '')
  }

  async function save() {
    if (submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/members/identity', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId, displayName: trimmedName, phone: trimmedPhone }),
      })
      const data = await res.json().catch(() => null)

      if (res.ok && data?.ok) {
        const invalidated = typeof data.bindingsInvalidated === 'number' ? data.bindingsInvalidated : 0
        setNotice(
          data.changed === false
            ? '資料沒有變更。'
            : invalidated > 0
              // Said as an instruction, not a statistic: somebody has to tell the member.
              ? `已更新。這位會友原本送出的 ${invalidated} 筆 LINE 綁定申請已作廢，請告知他重新在 LINE 送出綁定。`
              : '已更新。',
        )
        setOpen(false)
        setConfirming(false)
        // The page is server-rendered; pull the new values rather than trusting local state.
        router.refresh()
        return
      }

      const reason = typeof data?.reason === 'string' ? data.reason : ''
      setError(reason === 'invalid_request' ? '請確認姓名與手機號碼格式。' : memberMaintenanceMessage(reason))
      setConfirming(false)
    } catch {
      setError('連線失敗，請再試一次。')
      setConfirming(false)
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) {
    return (
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => { setNotice(null); setOpen(true) }}
          className="inline-flex min-h-11 items-center rounded-xl border border-border px-4 text-sm text-ink transition-colors hover:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
        >
          修改姓名／手機
        </button>
        {notice && <p className="text-sm text-primary-deep">{notice}</p>}
      </div>
    )
  }

  return (
    <div className="mt-4 flex flex-col gap-3 rounded-xl border border-border bg-page p-4">
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">姓名</span>
          <input
            type="text"
            value={name}
            maxLength={50}
            onChange={e => { setName(e.target.value); setConfirming(false) }}
            className="w-48 rounded-lg border border-border bg-surface px-3 py-2 text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/30"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">手機號碼</span>
          <input
            type="tel"
            inputMode="numeric"
            value={newPhone}
            maxLength={10}
            placeholder="09xxxxxxxx"
            onChange={e => { setNewPhone(e.target.value); setConfirming(false) }}
            className="w-40 rounded-lg border border-border bg-surface px-3 py-2 font-mono text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/30"
          />
        </label>
      </div>

      {confirming && phoneChanged && (
        <div className="rounded-xl border border-warning-fg/30 bg-warning-bg px-4 py-3 text-sm text-warning-fg">
          <p className="font-semibold">更換手機號碼會作廢這位會友尚未審核的 LINE 綁定申請</p>
          <p className="mt-1">
            綁定申請是以送出當下的手機號碼認人的，號碼換了之後那份身分依據就過期了，所以系統會把它作廢。請在存檔後告知他用新號碼重新於 LINE 送出綁定。
          </p>
          <p className="mt-1">
            舊申請不會被重新對到日後拿到舊號碼的人——審核時認的是送出當下對到的會友，不會重新用號碼去找人。
          </p>
        </div>
      )}

      {error && (
        <p className="rounded-lg border border-danger-fg/30 bg-danger-bg px-4 py-2 text-sm text-danger-fg">{error}</p>
      )}

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          // A phone change gets one confirmation step; a rename saves directly.
          onClick={() => (phoneChanged && !confirming ? setConfirming(true) : void save())}
          disabled={submitting || !anythingChanged || trimmedName === '' || trimmedPhone === ''}
          className="inline-flex min-h-11 items-center rounded-xl bg-primary px-5 text-sm font-semibold text-white transition-colors hover:bg-primary-strong disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
        >
          {submitting ? '儲存中…' : confirming && phoneChanged ? '確認更換並儲存' : '儲存'}
        </button>
        <button
          type="button"
          onClick={close}
          disabled={submitting}
          className="inline-flex min-h-11 items-center rounded-xl border border-border px-4 text-sm text-ink transition-colors hover:border-primary disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
        >
          取消
        </button>
      </div>
    </div>
  )
}
