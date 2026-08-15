'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { OpenAlertItem, ResolvedAlertItem } from '@/lib/pastoralAdminTypes'

// Pastoral-care alert handling (sensitive: names + absence counts + notes). All content
// renders as PLAIN TEXT ONLY (no dangerouslySetInnerHTML), never enters a URL, and the
// resolved section is a fixed recent-20 window — no unbounded loading, no export.

const REASON_LABEL: Record<string, string> = {
  consecutive_no_show: '連續未到（P1/P2）',
}

export default function PastoralAlerts({
  open,
  openHasMore,
  recentResolved,
  resolvedHasMore,
}: {
  open: OpenAlertItem[]
  openHasMore: boolean
  recentResolved: ResolvedAlertItem[]
  resolvedHasMore: boolean
}) {
  const router = useRouter()
  const [target, setTarget] = useState<OpenAlertItem | null>(null)
  const [note, setNote] = useState('')
  const [resetCounter, setResetCounter] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  function openDialog(item: OpenAlertItem) {
    setTarget(item); setNote(''); setResetCounter(false); setError(null); setDone(null)
  }
  function closeDialog() {
    setTarget(null); setNote(''); setResetCounter(false); setError(null)
  }

  async function doResolve() {
    if (busy || !target) return
    if ([...note.trim()].length > 200) { setError('備註最多 200 字'); return }
    setBusy(true); setError(null)
    try {
      const res = await fetch('/api/admin/pastoral/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          alertId: target.id,
          ...(note.trim() ? { note: note.trim() } : {}),
          resetCounter,
        }),
      })
      const data = await res.json().catch(() => null)
      if (res.ok && data?.ok) {
        setDone(`已結案：${target.displayName}${data.counterReset ? '（計數已歸零）' : ''}`)
        closeDialog()
        router.refresh()
      } else if (res.status === 409) {
        setError('這筆提醒已由其他人處理，畫面將更新。')
        router.refresh()
      } else if (res.status === 404) {
        setError('找不到這筆提醒，畫面將更新。')
        router.refresh()
      } else {
        setError('結案失敗，請再試一次。')
      }
    } catch {
      setError('連線失敗，請再試一次。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col gap-6 bg-page px-6 py-10 text-ink">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">牧養關懷</h1>
        <p className="mt-1 text-sm text-muted">
          連續未到提醒。性質為關心而非懲罰——建議先由牧長／幹事聯繫了解狀況，再回來結案。
        </p>
      </header>

      {done && (
        <p className="rounded-xl border border-success-fg/30 bg-success-bg px-5 py-3 text-sm text-success-fg">{done}</p>
      )}

      {/* Open alerts */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">待處理{openHasMore ? '（僅顯示前 100 筆）' : ''}</h2>
        {open.length === 0 ? (
          <p className="rounded-xl border border-success-fg/30 bg-success-bg px-5 py-3 text-sm text-success-fg">
            目前沒有待處理的關懷提醒
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {open.map(item => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border border-l-4 border-l-warning-fg bg-surface p-5">
                <div>
                  <p className="text-base font-semibold text-ink">{item.displayName}</p>
                  <p className="mt-1 text-sm text-muted">
                    {REASON_LABEL[item.reason] ?? item.reason}・開立時連續 {item.triggerCount} 次・目前連續{' '}
                    {item.currentConsecutiveNoShow === null ? '（無計數資料）' : `${item.currentConsecutiveNoShow} 次`}
                  </p>
                  <p className="mt-0.5 text-xs text-muted">
                    觸發週次：{item.sunday}・開立於 {item.createdAt.slice(0, 10)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => openDialog(item)}
                  className="inline-flex min-h-11 items-center rounded-xl bg-primary px-5 text-sm font-semibold text-white transition-colors hover:bg-primary-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                >
                  處理
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Resolve dialog */}
      {target && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
          <div role="dialog" aria-modal="true" aria-labelledby="pastoral-resolve-title" className="flex max-h-[calc(100dvh-3rem)] w-full max-w-lg flex-col gap-4 overflow-y-auto rounded-2xl border border-border bg-surface p-6">
            <h3 id="pastoral-resolve-title" className="text-lg font-semibold">結案：{target.displayName}</h3>
            <p className="text-sm text-muted">
              {REASON_LABEL[target.reason] ?? target.reason}・開立時連續 {target.triggerCount} 次・目前連續{' '}
              {target.currentConsecutiveNoShow === null ? '（無計數資料）' : `${target.currentConsecutiveNoShow} 次`}
            </p>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted">備註（選填，最多 200 字；請勿填入電話等個資）</span>
              <textarea
                value={note}
                onChange={e => setNote(e.target.value)}
                rows={3}
                className="rounded-lg border border-border bg-surface px-3 py-2 text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/30"
              />
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={resetCounter}
                onChange={e => setResetCounter(e.target.checked)}
                className="mt-1 accent-primary"
              />
              <span>
                同時歸零連續未到計數
                <span className="block text-xs text-muted">
                  歸零後需再連續未到 4 次才會再次提醒；不歸零則下次未到會立即再開提醒。不影響違規分數。
                </span>
              </span>
            </label>
            {error && <p className="rounded-lg border border-danger-fg/30 bg-danger-bg px-4 py-2 text-sm text-danger-fg">{error}</p>}
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={closeDialog}
                disabled={busy}
                className="inline-flex min-h-11 items-center rounded-xl border border-border px-4 text-sm text-ink transition-colors hover:border-primary disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
              >
                取消
              </button>
              <button
                type="button"
                onClick={doResolve}
                disabled={busy}
                className="inline-flex min-h-11 items-center rounded-xl bg-primary px-5 text-sm font-semibold text-white transition-colors hover:bg-primary-strong disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
              >
                {busy ? '處理中…' : '確認結案'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Recently resolved (fixed window) */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">近期已處理{resolvedHasMore ? '（僅顯示最近 20 筆）' : ''}</h2>
        {recentResolved.length === 0 ? (
          <p className="text-sm text-muted">尚無已處理紀錄</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {recentResolved.map(item => (
              <li key={item.id} className="rounded-xl border border-border bg-surface p-4 text-sm">
                <p className="text-ink">
                  {item.displayName}
                  <span className="text-muted">
                    ・{REASON_LABEL[item.reason] ?? item.reason}・週次 {item.sunday}
                  </span>
                </p>
                <p className="mt-1 text-xs text-muted">
                  {item.resolvedAt ? `結案於 ${item.resolvedAt.slice(0, 10)}` : '—'}
                  ・處理者：{item.resolvedByUsername ?? '—'}
                  {item.counterReset ? '・已歸零計數' : ''}
                </p>
                {item.note && <p className="mt-1 text-xs text-muted">備註：{item.note}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
