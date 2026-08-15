'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { fmtTaipeiDateTime } from '@/lib/taipeiDate'
import type { OutboxAlert, OutboxHealth } from '@/lib/opsAdminTypes'

// Notification-system status (通知系統狀態, #17 B). A plain-language health verdict leads;
// the technical detail (queue numbers, timestamps) and the dead-letter requeue tool fold
// into <details> so a superadmin sees the conclusion first. All values are operation-safe
// (counts / template names / sanitized error codes / timestamps) — no PII. Health + alert
// come from ONE server snapshot (props); router.refresh() re-fetches it. Times display in
// Taipei (fmtTaipeiDateTime), not UTC.

const BREACH_LABEL: Record<string, string> = {
  failed_over_max: '有失敗通知（failed 超過門檻）',
  stale_processing_over_max: '有卡住的處理中通知（stale 超過門檻）',
  due_backlog_stale: '待送通知積壓過久未清（dispatcher 可能未執行）',
}

export default function OpsDashboard({
  health,
  alert,
  snapshotAt,
}: {
  health: OutboxHealth
  alert: OutboxAlert
  snapshotAt: string
}) {
  const router = useRouter()
  const errorCodes = Object.keys(health.failed_by_error)

  const [max, setMax] = useState(50)
  const [errorCode, setErrorCode] = useState('') // '' = all failed
  const [preview, setPreview] = useState<{ max: number; errorCode: string; wouldRequeue: number } | null>(null)
  const [result, setResult] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Any change to the requeue conditions invalidates a prior preview — apply must never
  // run under different conditions than what was previewed.
  function changeMax(v: number) { setMax(v); setPreview(null); setResult(null); setError(null) }
  function changeErrorCode(v: string) { setErrorCode(v); setPreview(null); setResult(null); setError(null) }

  async function doPreview() {
    if (busy) return
    if (!Number.isInteger(max) || max < 1 || max > 500) { setError('筆數需為 1–500 的整數'); return }
    setBusy(true); setError(null); setResult(null)
    try {
      const res = await fetch('/api/admin/ops/requeue', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dryRun: true, max, ...(errorCode ? { errorCode } : {}) }),
      })
      const data = await res.json().catch(() => null)
      if (res.ok && data?.ok) {
        setPreview({ max, errorCode, wouldRequeue: data.wouldRequeue })
      } else {
        setError(res.status === 400 ? '條件不合法（筆數 1–500、錯誤代碼格式）' : '預覽失敗，請再試一次')
      }
    } catch {
      setError('連線失敗，請再試一次')
    } finally {
      setBusy(false)
    }
  }

  async function doApply() {
    if (busy || !preview) return
    setBusy(true); setError(null)
    try {
      // Apply strictly uses the PREVIEWED conditions, not the current form state.
      const res = await fetch('/api/admin/ops/requeue', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dryRun: false, max: preview.max, ...(preview.errorCode ? { errorCode: preview.errorCode } : {}) }),
      })
      const data = await res.json().catch(() => null)
      if (res.ok && data?.ok) {
        setResult(data.requeued)
        setPreview(null)
        router.refresh() // pull a fresh health snapshot
      } else {
        setError('重送失敗，請再試一次')
      }
    } catch {
      setError('連線失敗，請再試一次')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col gap-6 bg-page px-6 py-10 text-ink">
      <header className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">通知系統狀態</h1>
          <p className="mt-1 text-xs text-muted">快照時間（台北）：{fmtTaipeiDateTime(snapshotAt)}</p>
        </div>
        <button
          type="button"
          onClick={() => router.refresh()}
          className="inline-flex min-h-11 items-center rounded-xl border border-border px-4 text-sm text-ink transition-colors hover:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
        >
          重新整理
        </button>
      </header>

      {/* Plain-language health verdict — the star of the page. */}
      {alert.healthy ? (
        <p className="rounded-xl border border-success-fg/30 bg-success-bg px-5 py-3 text-sm font-medium text-success-fg">
          通知系統正常
        </p>
      ) : (
        <div className="rounded-xl border border-danger-fg/30 bg-danger-bg px-5 py-3 text-sm text-danger-fg">
          <p className="font-semibold">通知系統異常</p>
          <ul className="mt-1 list-disc pl-5">
            {alert.breaches.map(b => <li key={b}>{BREACH_LABEL[b] ?? b}</li>)}
          </ul>
        </div>
      )}

      {/* Technical detail — folded away, opened by default only when something is wrong. */}
      <details open={!alert.healthy} className="group rounded-xl border border-border bg-surface">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 [&::-webkit-details-marker]:hidden">
          <span aria-hidden className="text-muted transition-transform group-open:rotate-90">▶</span>
          <span>佇列數字與時間</span>
          {!alert.healthy && <span className="text-danger-fg">（需要查看）</span>}
        </summary>
        <div className="flex flex-col gap-5 border-t border-border px-5 py-5">
          {/* Counts */}
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="待送（due）" value={health.due} />
            <Stat label="pending" value={health.pending} />
            <Stat label="retrying" value={health.retrying} />
            <Stat label="processing" value={health.processing} />
            <Stat label="卡住（stale）" value={health.stale_processing} tone={health.stale_processing > 0 ? 'warn' : undefined} />
            <Stat label="失敗（failed）" value={health.failed} tone={health.failed > 0 ? 'bad' : undefined} />
            <Stat label="近 24h 已送" value={health.sent_last_24h} />
          </section>

          <Breakdown title="待送分類（by template）" entries={health.due_by_template} />
          <Breakdown title="失敗分類（by error）" entries={health.failed_by_error} />

          {/* Timestamps */}
          <section className="rounded-xl border border-border bg-page p-5 text-sm">
            <h3 className="text-sm font-semibold text-ink">時間點</h3>
            <dl className="mt-2 grid grid-cols-1 gap-x-8 gap-y-1 sm:grid-cols-2">
              <TimeRow label="最舊待送（due）" iso={health.oldest_due_at} snapshotAt={snapshotAt} />
              <TimeRow label="最舊 pending" iso={health.oldest_pending_at} snapshotAt={snapshotAt} />
              <TimeRow label="最舊 failed" iso={health.oldest_failed_at} snapshotAt={snapshotAt} />
              <TimeRow label="下次重試" iso={health.next_retry_at} snapshotAt={snapshotAt} />
            </dl>
          </section>
        </div>
      </details>

      {/* Requeue — a destructive action, folded closed so it is opened deliberately. */}
      <details className="group rounded-xl border border-border bg-surface">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 [&::-webkit-details-marker]:hidden">
          <span aria-hidden className="text-muted transition-transform group-open:rotate-90">▶</span>
          <span>失敗通知重送</span>
        </summary>
        <div className="flex flex-col gap-3 border-t border-border px-6 py-5">
          <p className="text-xs text-muted">
            把終態 <code>failed</code> 通知移回 <code>pending</code> 等下次派送。
            <span className="text-warning-fg">請先修好根因（token/config/provider）再重送。</span>
          </p>
          <div className="flex flex-wrap items-end gap-4">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted">筆數上限</span>
              <input
                type="number" min={1} max={500} step={1} value={max}
                onChange={e => changeMax(Number(e.target.value))}
                className="w-28 rounded-lg border border-border bg-surface px-3 py-2 text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/30"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted">錯誤類型</span>
              <select
                value={errorCode}
                onChange={e => changeErrorCode(e.target.value)}
                className="rounded-lg border border-border bg-surface px-3 py-2 text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/30"
              >
                <option value="">全部失敗</option>
                {errorCodes.map(c => <option key={c} value={c}>{c}（{health.failed_by_error[c]}）</option>)}
              </select>
            </label>
            <button
              type="button"
              onClick={doPreview}
              disabled={busy}
              className="inline-flex min-h-11 items-center rounded-xl bg-primary px-5 text-sm font-semibold text-white transition-colors hover:bg-primary-strong disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            >
              {busy && !preview ? '預覽中…' : '預覽'}
            </button>
          </div>

          {error && <p className="rounded-lg border border-danger-fg/30 bg-danger-bg px-4 py-2 text-sm text-danger-fg">{error}</p>}

          {preview && (
            <div className="flex flex-col gap-3 rounded-lg border border-warning-fg/30 bg-warning-bg p-4">
              <p className="text-sm text-warning-fg">
                將重送最多 {preview.max} 筆・錯誤類型：{preview.errorCode || '全部失敗'}・預計符合：{preview.wouldRequeue} 筆。
                <br />
                <span className="text-xs">預覽為當下估算；實際重送數量可能因其他操作而較少。</span>
              </p>
              <div>
                <button
                  type="button"
                  onClick={doApply}
                  disabled={busy}
                  className="inline-flex min-h-11 items-center rounded-xl bg-primary px-5 text-sm font-semibold text-white transition-colors hover:bg-primary-strong disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                >
                  {busy ? '重送中…' : '確認重送'}
                </button>
              </div>
            </div>
          )}

          {result !== null && (
            <p className="rounded-lg border border-success-fg/30 bg-success-bg px-4 py-2 text-sm text-success-fg">
              已將 {result} 筆失敗通知移回待送佇列，將由下一次 dispatcher 送出。
            </p>
          )}
        </div>
      </details>
    </main>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'warn' | 'bad' }) {
  const color = tone === 'bad' ? 'text-danger-fg' : tone === 'warn' ? 'text-warning-fg' : 'text-ink'
  return (
    <div className="rounded-xl border border-border bg-page px-4 py-3">
      <div className="text-xs text-muted">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${color}`}>{value}</div>
    </div>
  )
}

function Breakdown({ title, entries }: { title: string; entries: Record<string, number> }) {
  const keys = Object.keys(entries)
  if (keys.length === 0) return null
  return (
    <section className="rounded-xl border border-border bg-page p-5">
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      <ul className="mt-2 space-y-1 text-sm text-muted">
        {keys.map(k => (
          <li key={k} className="flex justify-between gap-4">
            <span className="font-mono">{k}</span>
            <span className="tabular-nums text-ink">{entries[k]}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function TimeRow({ label, iso, snapshotAt }: { label: string; iso: string | null; snapshotAt: string }) {
  return (
    <div className="flex gap-3">
      <dt className="w-32 shrink-0 text-muted">{label}</dt>
      <dd className="text-ink">
        {iso === null ? '—' : <>{relTime(snapshotAt, iso)} <span className="text-muted">（{fmtTaipeiDateTime(iso)}）</span></>}
      </dd>
    </div>
  )
}

// Relative time computed against the SERVER snapshot (not Date.now()) so the whole page
// stays internally consistent and doesn't drift after hydration.
function relTime(fromIso: string, targetIso: string): string {
  const deltaMs = new Date(targetIso).getTime() - new Date(fromIso).getTime()
  const past = deltaMs < 0
  const mins = Math.round(Math.abs(deltaMs) / 60_000)
  const text = mins < 1 ? '不到 1 分鐘' : mins < 60 ? `${mins} 分鐘` : mins < 1440 ? `${Math.round(mins / 60)} 小時` : `${Math.round(mins / 1440)} 天`
  return past ? `${text}前` : `${text}後`
}
