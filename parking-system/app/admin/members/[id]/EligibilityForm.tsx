'use client'

import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { P2Reason } from '@/lib/memberImportSchema'
import { P2_REASON_LABEL, P2_REASON_OPTIONS, reasonUsesChildBirthdate } from '@/lib/p2Reason'
import { childCompanionValidUntil } from '@/lib/eligibilityStatus'
import { addDaysToIsoDate } from '@/lib/eligibilityStatus'
import { taipeiToday } from '@/lib/taipeiDate'

// P2 eligibility write form (Wave 2B-2b / #10). The audited path that replaces re-importing
// a CSV. Every refusal is a real server decision — the client may warn, only the RPC decides.
//
// TWO DISTINCT ACTIONS, on purpose:
//   儲存資格變更        -> approve/revoke + reason/window/note. Changing nothing does NOTHING.
//   確認資料並標記已覆核 -> records that a human looked, and when to look next.
// Collapsing them would create the trap this form exists to avoid: a 幹事 presses 儲存 on an
// unchanged CSV-created row, believes they reviewed it, and the next import overwrites it —
// because a no-op save deliberately does not set reviewed_at (0033).

export interface EligibilityFormProps {
  userId: string
  reviewStatus: string | null      // null = no eligibility row at all (a general member)
  reason: string | null
  validFrom: string | null
  validUntil: string | null
  reviewDate: string | null
  childBirthdate: string | null
  note: string | null
  reviewedAt: string | null        // null = still CSV-managed; THE governance boundary (0033)
  reviewVersion: number            // 0 when there is no row yet
}

const REASON_COPY: Record<string, string> = {
  conflict: '另一位管理員剛剛也改了這位會友的資格，畫面已過期。請重新整理後再試一次。',
  not_found: '找不到這位會友，請重新整理。',
  nothing_to_revoke: '這位會友目前沒有 P2 資格，無法撤銷。',
  reason_required: '核准時必須選擇事由。',
  review_date_required: '核准時必須設定下次覆核日。',
  review_date_in_past: '下次覆核日不能早於今天。',
  child_birthdate_required: '幼兒同行必須填寫最小孩子的生日，到期日由系統推算。',
  child_birthdate_in_future: '孩子的生日不能是未來的日期。',
  child_birthdate_not_applicable: '只有「幼兒同行」需要填寫孩子生日。',
  expiry_not_settable: '幼兒同行的到期日由系統依學年度推算，不可手動指定。',
  window_inverted: '生效日不能晚於到期日。',
  eligibility_not_approved: '只有已核准的資格才能標記覆核。',
  invalid_request: '輸入的內容不正確，請確認後再送出。',
}

export default function EligibilityForm(props: EligibilityFormProps) {
  const router = useRouter()
  const reasonId = useId()
  const fromId = useId()
  const untilId = useId()
  const bdId = useId()
  const reviewId = useId()
  const noteId = useId()

  const today = taipeiToday(new Date())
  const isApproved = props.reviewStatus === 'approved'
  const governed = props.reviewedAt !== null

  const [reason, setReason] = useState<P2Reason | ''>((props.reason as P2Reason) ?? '')
  const [validFrom, setValidFrom] = useState(props.validFrom ?? '')
  const [validUntil, setValidUntil] = useState(props.validUntil ?? '')
  const [childBd, setChildBd] = useState(props.childBirthdate ?? '')
  const [reviewDate, setReviewDate] = useState(props.reviewDate ?? addDaysToIsoDate(today, 365))
  const [note, setNote] = useState(props.note ?? '')
  const [busy, setBusy] = useState<null | 'save' | 'revoke' | 'review'>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const usesChildBd = reason !== '' && reasonUsesChildBirthdate(reason)
  // Mirrors the DB's child_companion_valid_until exactly. A preview, not a promise — the RPC
  // derives it again server-side and a CHECK constraint enforces the pair (0033).
  const derivedUntil = usesChildBd && /^\d{4}-\d{2}-\d{2}$/.test(childBd)
    ? childCompanionValidUntil(childBd)
    : null

  const post = async (kind: 'save' | 'revoke' | 'review', body: Record<string, unknown>) => {
    setBusy(kind); setError(null); setDone(null)
    try {
      const res = await fetch('/api/admin/eligibility', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: props.userId, expectedVersion: props.reviewVersion, ...body }),
      })
      const data = await res.json()
      if (!data.ok) {
        setError(REASON_COPY[data.reason] ?? '無法儲存，請稍後再試。')
        return false
      }
      return data
    } catch {
      setError('無法儲存，請稍後再試。')
      return false
    } finally {
      setBusy(null)
    }
  }

  const save = async () => {
    const data = await post('save', {
      action: 'save',
      reviewStatus: 'approved',
      reason: reason === '' ? null : reason,
      validFrom: validFrom || null,
      // Never send an expiry for child_companion: the RPC refuses it outright rather than
      // ignoring it, because a caller who sends one believes they set it.
      validUntil: usesChildBd ? null : (validUntil || null),
      childBirthdate: usesChildBd ? (childBd || null) : null,
      nextReviewDate: reviewDate || null,
      note: note.trim() === '' ? null : note,
    })
    if (!data) return
    setDone(data.noop ? '沒有變更，因此沒有記錄覆核。若要記錄，請按「確認資料並標記已覆核」。' : '已儲存。')
    router.refresh()
  }

  const revoke = async () => {
    const data = await post('revoke', { action: 'save', reviewStatus: 'revoked' })
    if (!data) return
    setDone('已撤銷 P2 資格。')
    router.refresh()
  }

  const review = async () => {
    const data = await post('review', { action: 'review', nextReviewDate: reviewDate })
    if (!data) return
    setDone('已記錄覆核。')
    router.refresh()
  }

  const field = 'min-h-11 rounded-lg border border-border bg-page px-3 text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-primary'

  return (
    <div className="mt-6 flex flex-col gap-4 border-t border-border pt-6">
      {/* Says out loud what reviewed_at means, because a 幹事 cannot infer from a badge that
          this row is still open to being overwritten by the next roster upload. */}
      {!governed && (
        <p className="rounded-lg border border-warning-fg/30 bg-warning-bg px-3 py-2 text-sm text-warning-fg">
          此資格目前由名單匯入管理，尚未經人工覆核。下次匯入名單時仍可能被覆蓋。
        </p>
      )}

      <div className="flex flex-wrap gap-4">
        <label className="flex flex-col gap-1 text-sm" htmlFor={reasonId}>
          <span className="text-muted">事由</span>
          <select
            id={reasonId} value={reason} className={`${field} w-44`}
            onChange={e => setReason(e.target.value as P2Reason | '')}
          >
            <option value="">請選擇…</option>
            {P2_REASON_OPTIONS.map(r => (
              <option key={r} value={r}>{P2_REASON_LABEL[r]}</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm" htmlFor={fromId}>
          <span className="text-muted">生效日（可留空）</span>
          <input id={fromId} type="date" value={validFrom} className={`${field} w-44`}
                 onChange={e => setValidFrom(e.target.value)} />
        </label>

        {usesChildBd ? (
          <label className="flex flex-col gap-1 text-sm" htmlFor={bdId}>
            <span className="text-muted">最小孩子生日</span>
            <input id={bdId} type="date" max={today} value={childBd} className={`${field} w-44`}
                   onChange={e => setChildBd(e.target.value)} />
          </label>
        ) : (
          <label className="flex flex-col gap-1 text-sm" htmlFor={untilId}>
            <span className="text-muted">到期日（可留空＝永久）</span>
            <input id={untilId} type="date" value={validUntil} className={`${field} w-44`}
                   onChange={e => setValidUntil(e.target.value)} />
          </label>
        )}

        <label className="flex flex-col gap-1 text-sm" htmlFor={reviewId}>
          <span className="text-muted">下次覆核日</span>
          <input id={reviewId} type="date" min={today} value={reviewDate} className={`${field} w-44`}
                 onChange={e => setReviewDate(e.target.value)} />
        </label>
      </div>

      {/* The expiry is never an input for 幼兒同行 — it is derived, and 0033's CHECK means even
          direct SQL cannot set it to something else. Showing the derived value keeps the rule
          visible instead of mysterious. */}
      {usesChildBd && (
        <p className="text-sm text-muted">
          到期日由系統推算至孩子入學前的 8/31：
          <span className="ml-1 font-mono tabular-nums text-ink">{derivedUntil ?? '—'}</span>
        </p>
      )}

      <label className="flex flex-col gap-1 text-sm" htmlFor={noteId}>
        <span className="text-muted">覆核備註（不會出現在稽核記錄）</span>
        <textarea
          id={noteId} value={note} rows={2} maxLength={500}
          onChange={e => setNote(e.target.value)}
          className="rounded-lg border border-border bg-page px-3 py-2 text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        />
      </label>

      {error && (
        <p className="rounded-lg border border-danger-fg/30 bg-danger-bg px-3 py-2 text-sm text-danger-fg">{error}</p>
      )}
      {done && <p className="text-sm text-success-fg">{done}</p>}

      <div className="flex flex-wrap gap-3">
        <button
          type="button" onClick={save} disabled={busy !== null}
          className="inline-flex min-h-11 items-center rounded-lg bg-primary px-4 text-sm font-medium text-white transition-colors hover:bg-primary-strong disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
        >
          {busy === 'save' ? '儲存中…' : props.reviewStatus === 'approved' ? '儲存資格變更' : '核准 P2 資格'}
        </button>

        {/* Only for an approved row — mirrors the RPC's eligibility_not_approved guard, so we
            never show a button whose only possible outcome is a 422. */}
        {isApproved && (
          <button
            type="button" onClick={review} disabled={busy !== null}
            className="inline-flex min-h-11 items-center rounded-lg border border-border px-4 text-sm font-medium text-ink transition-colors hover:bg-page disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
          >
            {busy === 'review' ? '記錄中…' : '確認資料並標記已覆核'}
          </button>
        )}

        {isApproved && (
          <button
            type="button" onClick={revoke} disabled={busy !== null}
            className="inline-flex min-h-11 items-center rounded-lg border border-danger-fg/40 px-4 text-sm font-medium text-danger-fg transition-colors hover:bg-danger-bg disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
          >
            {busy === 'revoke' ? '撤銷中…' : '撤銷資格'}
          </button>
        )}
      </div>
    </div>
  )
}
