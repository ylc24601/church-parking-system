'use client'

import { useCallback, useEffect, useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { fmtTaipeiDateTime } from '@/lib/taipeiDate'
import type { PendingClaimListItem } from '@/lib/bindingAdminTypes'
import Badge from '../../ui/Badge'

// Binding review queue (Phase 8 Slice 1). Everything sensitive arrived masked from
// the service; the ONLY deliberate full values on screen are claimedName +
// matchedDisplayName (the human comparison an approval is about). React keys and
// every API call use the FULL uuid — the 8-char shortId is display-only.

interface Preview {
  found: boolean
  pendingStatus?: string
  claimSource?: string
  claimVersion?: number
  lineUserIdMasked?: string
  submittedCodeMasked?: string | null
  claimedPhoneMasked?: string | null
  claimedName?: string | null
  matchedDisplayName?: string | null
  wouldApprove: boolean
  reason: string
}

// zh-TW operator guidance per typed reason (docs/binding-ops.md).
const REASON_COPY: Record<string, string> = {
  approved: '可核准',
  pending_not_found: '申請不存在（可能已被撤回），請重新整理清單',
  pending_not_pending: '此申請已被審核過，無需重做',
  pending_changed: '申請內容已在預覽後更新，請重新預覽',
  code_not_found: '綁定碼查無發碼紀錄：會友可能打錯，或尚未發碼',
  code_expired: '綁定碼已過期，請重新發碼',
  code_consumed: '綁定碼已被使用過，請重新發碼',
  // Two names for one outcome (0038 renamed it). The pre-0038 wording asked "does this
  // phone match a member NOW?"; the new one is truer and has a different remedy — the
  // claim matched nobody WHEN IT WAS SUBMITTED, and re-resolving it today is exactly what
  // must not happen (the number may since have been re-issued to someone else). Both are
  // kept so the copy is right whichever side of the migration the DB is on.
  phone_not_found: '申請手機對不到任何會友：請確認會友資料已匯入、手機正確；必要時退回並聯繫本人',
  unmatched_at_capture:
    '送出當下這支手機對不到任何會友（可能尚未匯入，或會友之後換了號碼）。請確認名冊後，' +
    '請會友重新在 LINE 送出一次綁定——系統不會拿現在的名冊重新比對這筆舊申請。',
  member_already_bound: '對到的會友已綁定其他 LINE 帳號（不支援換綁）',
  line_id_taken: '此 LINE 帳號已綁定到別的會友，請查是否重複或錯綁',
}

function reasonCopy(reason: string): string {
  return REASON_COPY[reason] ?? reason
}

function sourceLabel(source: string): string {
  return source === 'liff' ? 'LIFF 自助申請' : '綁定碼'
}

export default function BindingReview({
  items,
  hasMore,
}: {
  items: PendingClaimListItem[]
  hasMore: boolean
}) {
  const router = useRouter()
  const [reviewItem, setReviewItem] = useState<PendingClaimListItem | null>(null)
  const [rejectItem, setRejectItem] = useState<PendingClaimListItem | null>(null)

  const closeAndRefresh = useCallback(() => {
    setReviewItem(null)
    setRejectItem(null)
    router.refresh()
  }, [router])

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col gap-6 bg-page px-6 py-10 text-ink">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">綁定審核</h1>
        </div>
        <button
          type="button"
          onClick={() => router.refresh()}
          className="inline-flex min-h-11 items-center rounded-xl border border-border px-4 text-sm text-ink transition-colors hover:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
        >
          重新整理
        </button>
      </header>

      {hasMore && (
        <p className="rounded-xl border border-warning-fg/30 bg-warning-bg px-4 py-3 text-sm text-warning-fg">
          目前僅顯示最早送出的 {items.length} 筆，之後還有更多待審申請——請先完成部分審核後重新整理。
        </p>
      )}

      {items.length === 0 ? (
        <p className="rounded-xl border border-border bg-surface px-6 py-12 text-center text-muted">
          目前沒有待審核的綁定申請
        </p>
      ) : (
        <div className="w-full overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="bg-surface text-muted">
              <tr>
                <th className="px-4 py-3 font-normal">ID</th>
                <th className="whitespace-nowrap px-4 py-3 font-normal">來源</th>
                <th className="px-4 py-3 font-normal">申請內容</th>
                <th className="whitespace-nowrap px-4 py-3 font-normal">首次送出</th>
                <th className="whitespace-nowrap px-4 py-3 font-normal">最後更新</th>
                <th className="whitespace-nowrap px-4 py-3 font-normal">重送</th>
                <th className="whitespace-nowrap px-4 py-3 font-normal">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {items.map(item => (
                <tr key={item.id} className="bg-surface">
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      title={`點擊複製完整 ID\n${item.id}`}
                      onClick={() => void navigator.clipboard?.writeText(item.id)}
                      className="font-mono text-muted hover:text-ink"
                    >
                      {item.shortId}
                    </button>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <Badge variant="outline" tone={item.source === 'liff' ? 'info' : 'neutral'}>{sourceLabel(item.source)}</Badge>
                  </td>
                  <td className="px-4 py-3 font-mono text-ink">{item.claim}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-muted">{fmtTaipeiDateTime(item.submittedAt)}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-muted">{fmtTaipeiDateTime(item.lastUpdatedAt)}</td>
                  <td className="whitespace-nowrap px-4 py-3 tabular-nums text-muted">{item.resubmits}</td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setReviewItem(item)}
                        className="inline-flex items-center rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                      >
                        審核
                      </button>
                      <button
                        type="button"
                        onClick={() => setRejectItem(item)}
                        className="inline-flex items-center rounded-lg border border-border px-3 py-2 text-sm text-ink transition-colors hover:border-danger-fg hover:text-danger-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                      >
                        退回
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {reviewItem && (
        <ReviewModal item={reviewItem} onClose={() => setReviewItem(null)} onDone={closeAndRefresh} />
      )}
      {rejectItem && (
        <RejectModal item={rejectItem} onClose={() => setRejectItem(null)} onDone={closeAndRefresh} />
      )}
    </main>
  )
}

function ModalShell({ title, children, onClose }: {
  title: string
  children: React.ReactNode
  onClose: () => void
}) {
  const titleId = useId()
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-2xl border border-border bg-surface p-6">
        <div className="flex items-center justify-between">
          <h2 id={titleId} className="text-lg font-semibold">{title}</h2>
          <button type="button" onClick={onClose} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-muted transition-colors hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2" aria-label="關閉">
            ✕
          </button>
        </div>
        <div className="mt-4">{children}</div>
      </div>
    </div>
  )
}

function PreviewField({ label, value }: { label: string; value: string | null | undefined }) {
  if (value === null || value === undefined || value === '') return null
  return (
    <div className="flex justify-between gap-4 py-1.5">
      <span className="shrink-0 text-muted">{label}</span>
      <span className="break-all text-right text-ink">{value}</span>
    </div>
  )
}

// Preview → confirm. The confirm carries the previewed claimVersion; a claim
// re-submitted in between comes back 409 pending_changed → re-preview, never a
// sight-unseen approval.
function ReviewModal({ item, onClose, onDone }: {
  item: PendingClaimListItem
  onClose: () => void
  onDone: () => void
}) {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [loading, setLoading] = useState(true)
  const [applying, setApplying] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'error' | 'changed' | 'outcome'; text: string } | null>(null)
  // Bumped by 重新預覽 (after pending_changed); state resets happen in that handler,
  // the effect itself only applies async results.
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      let next: { preview?: Preview; error?: string }
      try {
        const res = await fetch('/api/admin/bindings/preview', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pendingId: item.id }),
        })
        const data = await res.json().catch(() => null)
        next = res.ok && data?.ok
          ? { preview: data.preview as Preview }
          : { error: '預覽載入失敗，請關閉後重試' }
      } catch {
        next = { error: '連線失敗，請關閉後重試' }
      }
      if (cancelled) return
      if (next.preview) setPreview(next.preview)
      else setNotice({ kind: 'error', text: next.error ?? '預覽載入失敗' })
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [item.id, reloadKey])

  function repreview() {
    setLoading(true)
    setPreview(null)
    setNotice(null)
    setReloadKey(k => k + 1)
  }

  async function approve() {
    if (!preview || preview.claimVersion === undefined || applying) return
    setApplying(true)
    setNotice(null)
    try {
      const res = await fetch('/api/admin/bindings/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pendingId: item.id, claimVersion: preview.claimVersion }),
      })
      const data = await res.json().catch(() => null)
      if (res.ok && data?.ok) {
        onDone()
        return
      }
      const reason: string = data?.reason ?? 'unknown'
      if (reason === 'pending_changed') {
        setNotice({ kind: 'changed', text: reasonCopy(reason) })
      } else {
        setNotice({ kind: 'outcome', text: reasonCopy(reason) })
      }
    } catch {
      setNotice({ kind: 'error', text: '連線失敗，請再試一次' })
    } finally {
      setApplying(false)
    }
  }

  const canApprove =
    !!preview && preview.found && preview.wouldApprove && preview.claimVersion !== undefined && !applying

  return (
    <ModalShell title="審核綁定申請" onClose={onClose}>
      {loading ? (
        <p className="py-8 text-center text-muted">載入預覽中…</p>
      ) : preview ? (
        <div className="flex flex-col gap-4">
          <div className="divide-y divide-border rounded-xl border border-border bg-page px-4 py-2 text-sm">
            <PreviewField label="來源" value={preview.claimSource ? sourceLabel(preview.claimSource) : null} />
            <PreviewField label="LINE 帳號（遮罩）" value={preview.lineUserIdMasked} />
            <PreviewField label="綁定碼（遮罩）" value={preview.submittedCodeMasked} />
            <PreviewField label="申請姓名" value={preview.claimedName} />
            <PreviewField label="申請手機（遮罩）" value={preview.claimedPhoneMasked} />
            <PreviewField label="比對到的會友" value={preview.matchedDisplayName ?? (preview.found ? '（無）' : null)} />
          </div>

          <p
            className={`rounded-xl px-4 py-3 text-sm ${
              preview.wouldApprove
                ? 'border border-success-fg/30 bg-success-bg text-success-fg'
                : 'border border-warning-fg/30 bg-warning-bg text-warning-fg'
            }`}
          >
            {preview.wouldApprove ? '✓ 預檢通過：' : '✗ 無法核准：'}
            {reasonCopy(preview.reason)}
          </p>

          {notice && (
            <p
              className={`rounded-xl px-4 py-3 text-sm ${
                notice.kind === 'changed'
                  ? 'border border-warning-fg/30 bg-warning-bg text-warning-fg'
                  : 'border border-danger-fg/30 bg-danger-bg text-danger-fg'
              }`}
            >
              {notice.text}
            </p>
          )}

          <div className="flex justify-end gap-3">
            {notice?.kind === 'changed' ? (
              <button
                type="button"
                onClick={repreview}
                className="inline-flex min-h-11 items-center rounded-xl bg-warning-fg px-4 text-sm font-semibold text-white transition-colors hover:bg-warning-fg/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
              >
                重新預覽
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void approve()}
                disabled={!canApprove}
                className="inline-flex min-h-11 items-center rounded-xl bg-primary px-4 text-sm font-semibold text-white transition-colors hover:bg-primary-strong disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
              >
                {applying ? '核准中…' : '確認核准'}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="inline-flex min-h-11 items-center rounded-xl border border-border px-4 text-sm text-ink transition-colors hover:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            >
              關閉
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="rounded-xl border border-danger-fg/30 bg-danger-bg px-4 py-3 text-sm text-danger-fg">
            {notice?.text ?? '預覽載入失敗'}
          </p>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex min-h-11 items-center rounded-xl border border-border px-4 text-sm text-ink transition-colors hover:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            >
              關閉
            </button>
          </div>
        </div>
      )}
    </ModalShell>
  )
}

const REJECT_PRESETS = ['重複申請', '無法辨識申請人']

function RejectModal({ item, onClose, onDone }: {
  item: PendingClaimListItem
  onClose: () => void
  onDone: () => void
}) {
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const trimmed = reason.trim()
  const tooLong = [...trimmed].length > 200

  async function submit() {
    if (!trimmed || tooLong || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/bindings/reject', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pendingId: item.id, reason: trimmed }),
      })
      const data = await res.json().catch(() => null)
      if (res.ok && data?.ok) {
        onDone()
        return
      }
      setError(reasonCopy(data?.reason ?? 'unknown'))
    } catch {
      setError('連線失敗，請再試一次')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <ModalShell title="退回綁定申請" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="rounded-xl border border-warning-fg/30 bg-warning-bg px-4 py-3 text-sm text-warning-fg">
          ⚠️ 退回原因會原樣存檔供稽核：請勿填入姓名、電話、綁定碼或 LINE ID。
        </p>

        <div className="flex flex-wrap gap-2">
          {REJECT_PRESETS.map(preset => (
            <button
              key={preset}
              type="button"
              onClick={() => { setReason(preset); setError(null) }}
              className="inline-flex min-h-11 items-center rounded-full border border-border px-3 text-sm text-ink transition-colors hover:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            >
              {preset}
            </button>
          ))}
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm text-muted">退回原因（必填，200 字內）</span>
          <textarea
            value={reason}
            onChange={e => { setReason(e.target.value); setError(null) }}
            rows={3}
            className="rounded-xl border border-border bg-surface px-4 py-3 text-sm text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/30"
          />
          {tooLong && <span className="text-sm text-danger-fg">已超過 200 字上限</span>}
        </label>

        {error && (
          <p className="rounded-xl border border-danger-fg/30 bg-danger-bg px-4 py-3 text-sm text-danger-fg">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!trimmed || tooLong || submitting}
            className="inline-flex min-h-11 items-center rounded-xl bg-danger-fg px-4 text-sm font-semibold text-white transition-colors hover:bg-danger-fg/90 disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
          >
            {submitting ? '退回中…' : '確認退回'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex min-h-11 items-center rounded-xl border border-border px-4 text-sm text-ink transition-colors hover:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
          >
            取消
          </button>
        </div>
      </div>
    </ModalShell>
  )
}
