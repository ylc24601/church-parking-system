'use client'

import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { CapacityCard } from '@/lib/capacityAdminTypes'
import Badge from '../../ui/Badge'

// One week's capacity card (Wave 2B-1 / #14A). The preview mirrors computeCapacity
// exactly — the same subtraction the allocator performs — so what the 幹事 sees before
// submitting is what the DB will compute. admin_reserved is absent on purpose: 0031
// folded it into blocked_spaces and pins it to 0, so this single 「保留·停用」number is
// provably the whole story.
//
// Every refusal below is a real server decision, not a UI guess: the client can warn,
// but only the RPC can guarantee, so we always submit and render what it says.

const REASON_COPY: Record<string, string> = {
  capacity_below_promised: '無法調整：可分配車位會少於本週已核准的數量。請先確認是否有人取消。',
  event_not_editable: '這一週已鎖定，無法修改車位設定。',
  allocation_in_progress: '本週的車位分配正在執行中，請稍候幾分鐘再試。',
  negative_capacity: '保留·停用的數量超過總車位，請重新確認。',
  conflict: '另一位管理員剛剛也改了這一週，畫面已過期。請重新整理後再試一次。',
  sunday_mismatch: '畫面已過期，請重新整理後再試一次。',
  not_found: '找不到這一週的資料，請重新整理。',
  invalid_request: '輸入的數字不正確，請確認後再送出。',
}

export default function CapacityForm({ card, heading }: { card: CapacityCard | null; heading: string }) {
  const router = useRouter()
  const totalId = useId()
  const blockedId = useId()
  const [total, setTotal] = useState(card?.totalCapacity ?? 0)
  const [blocked, setBlocked] = useState(card?.blockedSpaces ?? 0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  if (!card) {
    return (
      <section className="rounded-xl border border-border bg-surface px-6 py-6">
        <h2 className="text-lg font-semibold">{heading}</h2>
        <p className="mt-2 text-sm text-muted">這一週的場次尚未建立，暫時無法設定車位。</p>
      </section>
    )
  }

  const preview = total - blocked - card.reservedStaff
  const belowPromised = preview < card.promisedCount
  const unchanged = total === card.totalCapacity && blocked === card.blockedSpaces

  const submit = async () => {
    setBusy(true); setError(null); setDone(null)
    try {
      const res = await fetch('/api/admin/capacity', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          eventId: card.eventId, sunday: card.sunday,
          totalCapacity: total, blockedSpaces: blocked,
          expectedVersion: card.capacityVersion,
        }),
      })
      const body = await res.json()
      if (!body.ok) {
        setError(REASON_COPY[body.reason] ?? '無法儲存，請稍後再試。')
        return
      }
      setDone(body.noop ? '沒有變更。' : `已儲存：本週可分配 ${body.effectiveCapacity} 位。`)
      router.refresh()
    } catch {
      setError('無法儲存，請稍後再試。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-border bg-surface px-6 py-6">
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold">
          {heading}
          <span className="ml-2 font-mono text-sm font-normal text-muted">{card.sunday}</span>
        </h2>
        {card.editable
          ? <Badge tone="success">可修改</Badge>
          : <Badge tone="neutral">已鎖定</Badge>}
      </header>

      {!card.editable ? (
        <p className="text-sm text-muted">{card.notEditableReason}</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-4">
            <label className="flex flex-col gap-1 text-sm" htmlFor={totalId}>
              <span className="text-muted">總車位</span>
              <input
                id={totalId} type="number" min={0} inputMode="numeric" value={total}
                onChange={e => setTotal(Number(e.target.value))}
                className="min-h-11 w-28 rounded-lg border border-border bg-page px-3 text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm" htmlFor={blockedId}>
              <span className="text-muted">保留·停用</span>
              <input
                id={blockedId} type="number" min={0} inputMode="numeric" value={blocked}
                onChange={e => setBlocked(Number(e.target.value))}
                className="min-h-11 w-28 rounded-lg border border-border bg-page px-3 text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              />
            </label>
            <div className="flex flex-col gap-1 text-sm">
              <span className="text-muted">同工保留（不可改）</span>
              <span className="min-h-11 py-2 font-mono tabular-nums text-ink">{card.reservedStaff}</span>
            </div>
          </div>

          <p className="text-sm">
            可分配車位：<span className="font-mono tabular-nums text-ink">{preview}</span>
            <span className="text-muted">（本週已核准 {card.promisedCount} 位）</span>
          </p>

          {/* A warning, not a gate — the RPC is the only thing that can actually
              guarantee this, since seats can be promised between render and submit. */}
          {belowPromised && (
            <p className="rounded-lg border border-warning-fg/30 bg-warning-bg px-3 py-2 text-sm text-warning-fg">
              可分配車位會少於已核准的 {card.promisedCount} 位，系統將不會接受這項調整。
            </p>
          )}
          {error && (
            <p className="rounded-lg border border-danger-fg/30 bg-danger-bg px-3 py-2 text-sm text-danger-fg">{error}</p>
          )}
          {done && <p className="text-sm text-success-fg">{done}</p>}

          <div>
            <button
              type="button" onClick={submit} disabled={busy || unchanged}
              className="inline-flex min-h-11 items-center rounded-lg bg-primary px-4 text-sm font-medium text-white transition-colors hover:bg-primary-strong disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            >
              {busy ? '儲存中…' : '儲存'}
            </button>
          </div>
        </>
      )}
    </section>
  )
}
