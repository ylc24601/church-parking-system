'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { StaffPinCardStatus } from '@/lib/staffPinAdminTypes'

// On-site PIN management: one shared 6-digit PIN per Sunday's weekly_event. The PIN is
// server-generated and shown EXACTLY ONCE — any other action (another issue, an unlock,
// a refresh) clears it from the screen. "解鎖" and "產生新 PIN" are deliberately separate:
// unlock keeps the existing PIN (which cannot be re-displayed); issue replaces it and
// immediately invalidates the old one.

// expires_at rendered in Taipei local time (UTC+8, no DST) — the audience hands the PIN
// to on-site volunteers, so a UTC timestamp would just invite mistakes.
function taipeiTime(iso: string): string {
  const t = new Date(new Date(iso).getTime() + 8 * 3600_000)
  return `${t.toISOString().slice(0, 16).replace('T', ' ')}（台北）`
}

export default function StaffPinManager({
  current,
  next,
}: {
  current: StaffPinCardStatus
  next: StaffPinCardStatus
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The one-time PIN display: kept for exactly one card at a time.
  const [issued, setIssued] = useState<{ sunday: string; pin: string; expiresAt: string } | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null) // sunday awaiting replace-confirm
  const [unlocked, setUnlocked] = useState<string | null>(null)

  function clearTransient() {
    setIssued(null); setConfirming(null); setError(null); setUnlocked(null)
  }

  async function doIssue(card: StaffPinCardStatus) {
    if (busy || !card.eventId) return
    setBusy(true)
    clearTransient()
    try {
      const res = await fetch('/api/admin/staff-pin/issue', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: card.eventId, sunday: card.sunday }),
      })
      const data = await res.json().catch(() => null)
      if (res.ok && data?.ok) {
        setIssued({ sunday: data.sunday, pin: data.pin, expiresAt: data.expiresAt })
        router.refresh()
      } else {
        setError('產生 PIN 失敗，請重新整理後再試。')
        router.refresh()
      }
    } catch {
      setError('連線失敗，請再試一次。')
    } finally {
      setBusy(false)
    }
  }

  async function doUnlock(card: StaffPinCardStatus) {
    if (busy || !card.eventId) return
    setBusy(true)
    clearTransient()
    try {
      const res = await fetch('/api/admin/staff-pin/unlock', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: card.eventId, sunday: card.sunday }),
      })
      const data = await res.json().catch(() => null)
      if (res.ok && data?.ok) {
        setUnlocked(card.sunday)
        router.refresh()
      } else {
        setError('解鎖失敗，請重新整理後再試。')
        router.refresh()
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
        <h1 className="text-2xl font-bold tracking-tight">現場 PIN 管理</h1>
        <p className="mt-1 text-sm text-muted">
          主日現場頁的共用 6 位數 PIN（每主日一組）。PIN 由系統隨機產生、只顯示一次；有效至該主日結束。
        </p>
        <p className="mt-2 text-sm text-muted">
          換人值班？重發即可，舊 PIN 立即失效。請將新 PIN 手動傳給本週值班同工。
        </p>
      </header>

      {error && <p className="rounded-xl border border-danger-fg/30 bg-danger-bg px-5 py-3 text-sm text-danger-fg">{error}</p>}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {([{ card: current, label: '當週' }, { card: next, label: '下週' }] as const).map(({ card, label }) => (
          <PinCard
            key={card.sunday}
            card={card}
            label={label}
            busy={busy}
            issued={issued}
            unlocked={unlocked}
            confirming={confirming}
            onIssue={() => doIssue(card)}
            onUnlock={() => doUnlock(card)}
            onConfirmStart={() => setConfirming(card.sunday)}
            onConfirmCancel={() => setConfirming(null)}
          />
        ))}
      </div>
    </main>
  )
}

function PinCard({
  card,
  label,
  busy,
  issued,
  unlocked,
  confirming,
  onIssue,
  onUnlock,
  onConfirmStart,
  onConfirmCancel,
}: {
  card: StaffPinCardStatus
  label: string
  busy: boolean
  issued: { sunday: string; pin: string; expiresAt: string } | null
  unlocked: string | null
  confirming: string | null
  onIssue: () => void
  onUnlock: () => void
  onConfirmStart: () => void
  onConfirmCancel: () => void
}) {
  return (
      <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-6">
        <header className="flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">{label}</h2>
          <span className="text-sm text-muted">{card.sunday}（週日）</span>
        </header>

        {card.eventId === null ? (
          <p className="text-sm text-muted">本週 event 尚未建立（週五分配後產生），暫無法設定 PIN。</p>
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
              <dt className="text-muted">PIN 狀態</dt>
              <dd className={card.hasPin ? 'font-medium text-success-fg' : 'text-ink'}>
                {card.hasPin ? '已設定' : '未設定'}
              </dd>
              {card.hasPin && card.expiresAt && (
                <>
                  <dt className="text-muted">有效至</dt>
                  <dd className="text-ink">{taipeiTime(card.expiresAt)}</dd>
                </>
              )}
              {card.hasPin && (
                <>
                  <dt className="text-muted">登入失敗次數</dt>
                  <dd className={card.locked ? 'font-medium text-danger-fg' : 'text-ink'}>
                    {card.failedAttempts}{card.locked ? '（已鎖定）' : ''}
                  </dd>
                </>
              )}
            </dl>

            {issued && issued.sunday === card.sunday && (
              <div className="rounded-xl border border-success-fg/30 bg-success-bg p-4">
                <p className="text-sm text-success-fg">新 PIN（只顯示這一次，請以安全管道轉交當週同工）：</p>
                <p className="mt-1 font-mono text-3xl font-bold tracking-[0.3em] text-primary-deep">{issued.pin}</p>
                <p className="mt-1 text-xs text-success-fg">有效至 {taipeiTime(issued.expiresAt)}</p>
              </div>
            )}

            {unlocked === card.sunday && (
              <p className="rounded-xl border border-success-fg/30 bg-success-bg px-4 py-2 text-sm text-success-fg">
                已解鎖。原 PIN 維持不變（系統無法再次顯示）。
              </p>
            )}

            {confirming === card.sunday ? (
              <div className="flex flex-col gap-3 rounded-xl border border-warning-fg/30 bg-warning-bg p-4">
                <p className="text-sm text-warning-fg">
                  將替換 {card.sunday} 的現場 PIN——<strong>舊 PIN 立即失效</strong>。
                  若已把舊 PIN 交給同工，請先確認再繼續。
                  {card.expiresAt && <span className="block text-xs">現有 PIN 有效至 {taipeiTime(card.expiresAt)}</span>}
                </p>
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={onConfirmCancel}
                    disabled={busy}
                    className="inline-flex min-h-11 items-center rounded-xl border border-border bg-surface px-4 text-sm text-ink transition-colors hover:border-primary disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={onIssue}
                    disabled={busy}
                    className="inline-flex min-h-11 items-center rounded-xl bg-warning-fg px-5 text-sm font-semibold text-white transition-colors active:bg-warning-fg/90 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                  >
                    {busy ? '產生中…' : '確認替換'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={card.hasPin ? onConfirmStart : onIssue}
                  disabled={busy}
                  className="inline-flex min-h-11 items-center rounded-xl bg-primary px-5 text-sm font-semibold text-white transition-colors hover:bg-primary-strong disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                >
                  {card.hasPin ? '產生並替換 PIN' : '產生 PIN'}
                </button>
                {card.locked && (
                  <button
                    type="button"
                    onClick={onUnlock}
                    disabled={busy}
                    className="inline-flex min-h-11 items-center rounded-xl border border-warning-fg/40 px-5 text-sm text-warning-fg transition-colors hover:border-warning-fg disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                  >
                    解鎖現有 PIN（不變更 PIN）
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </section>
  )
}
