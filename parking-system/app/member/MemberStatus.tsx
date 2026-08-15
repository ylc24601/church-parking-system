'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Badge, { type BadgeTone } from '../ui/Badge'
import { memberSundayLabel } from '@/lib/memberLabels'

// Member-safe week status DTO, built by the server page from repo rows. Own data
// only — no penalty, no other members, no ids. Dates are ISO strings (client
// formats them in Asia/Taipei). `apply` is present only when the member can see the
// apply block (open week, no live reservation); eligibility itself never ships —
// just the derived companion hint.
export interface MemberWeekStatus {
  displayName: string
  sundayDate: string | null       // 'YYYY-MM-DD'; null = no upcoming week open yet
  reservation: {
    status: string
    plate: string | null
    releaseDeadlineAt: string | null
    offerExpiresAt: string | null
    p2OnTheWay: boolean
    // Live queue position while waiting (#29); null when not waiting or unknown. A moving
    // number, not a ticket — see the note rendered beside it.
    waitingRank: number | null
  } | null
  apply: {
    closed: boolean               // Friday allocation ran — this week is closed
    staffP1: boolean              // full-time staff: spots managed via weekly reserve
    vehicles: Array<{ id: string; plate: string; nickname: string | null }>
    companionKind: 'elderly' | 'child' | null
  } | null
  canCancel: boolean
  canRespondOffer: boolean        // live temp_approved offer, not yet expired
  canReportOnTheWay: boolean      // approved P2, unattended, before the 10:45 deadline
}

const TAIPEI_TIME = new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

// Shared with the LINE notifications (lib/memberLabels): the page and the message must name
// the same Sunday the same way. Falls back to the raw date rather than blanking the heading.
function sundayLabel(sundayDate: string): string {
  return memberSundayLabel(sundayDate) ?? sundayDate
}

function timeLabel(iso: string | null): string | null {
  return iso ? TAIPEI_TIME.format(new Date(iso)) : null
}

// 狀態 → 會友文案 + badge tone. temp_approved 用 info（藍）與 waiting/pending（warning 琥珀）
// 區隔；已核准/到場為 success，已釋出/未到/取消為 neutral。
function statusView(r: NonNullable<MemberWeekStatus['reservation']>): {
  label: string
  tone: BadgeTone
  detail: string | null
  note?: string // secondary line, rendered smaller than detail
} {
  const deadline = timeLabel(r.releaseDeadlineAt)
  switch (r.status) {
    case 'pending':
      return { label: '已登記，等待分配', tone: 'warning', detail: '週五 18:00 分配後於此頁查看結果' }
    case 'approved':
      return {
        label: '已核准車位',
        tone: 'success',
        detail: deadline
          ? `請於主日 ${deadline} 前抵達${r.p2OnTheWay ? '（已回報正在路上）' : ''}`
          : null,
      }
    case 'temp_approved':
      return {
        label: '候補遞補中',
        tone: 'info',
        detail: timeLabel(r.offerExpiresAt)
          ? `已為您保留車位，請於 ${timeLabel(r.offerExpiresAt)} 前確認`
          : '已為您保留車位，請儘速確認',
      }
    case 'waiting':
      // Explicit null check, not truthiness: a real rank starts at 1, but `0` would be an
      // anomaly worth showing as unknown rather than silently hiding.
      return r.waitingRank !== null
        ? {
            label: '候補中',
            tone: 'warning',
            detail: `目前候補第 ${r.waitingRank} 位`,
            note: '順序可能因取消、資格與分配狀態而變動',
          }
        : { label: '候補中', tone: 'warning', detail: '若有車位釋出將依序遞補並通知您' }
    case 'attended':
      return { label: '已到場', tone: 'success', detail: null }
    case 'attended_after_release':
      return { label: '已到場（逾時補點名）', tone: 'success', detail: null }
    case 'released_late':
      return { label: '逾時未到，車位已釋出', tone: 'neutral', detail: '如已在現場請洽停車同工' }
    case 'no_show':
      return { label: '本週未到場', tone: 'neutral', detail: null }
    case 'cancelled_by_user':
    case 'cancelled_late':
      return { label: '已取消', tone: 'neutral', detail: null }
    default:
      return { label: '狀態確認中', tone: 'warning', detail: '請洽停車同工' }
  }
}

const APPLY_ERROR_COPY: Record<string, string> = {
  applications_closed: '本週登記已截止',
  already_applied: '本週已有登記，請重新整理頁面',
  vehicle_not_owned: '車輛資料有誤，請聯繫同工',
  event_not_open: '本週登記已關閉',
  no_open_week: '目前沒有開放中的登記週',
  staff_use_p1: '全職同工車位由每週保留名額管理，無需登記',
  invalid_request: '資料有誤，請重新選擇車輛',
}

// Shared button base: large touch target, rounded, visible keyboard focus.
const BTN =
  'inline-flex h-12 w-full items-center justify-center rounded-2xl text-base font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:opacity-50'
const CARD = 'rounded-2xl border border-border bg-surface p-5 shadow-sm'

export default function MemberStatus({ status }: { status: MemberWeekStatus }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function logout() {
    setBusy(true)
    try {
      await fetch('/api/member/logout', { method: 'POST' })
    } finally {
      router.refresh()
    }
  }

  const r = status.reservation
  const view = r ? statusView(r) : null

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col bg-page text-ink">
      {/* LINE-green brand strip. Dark ink text (not white) keeps AA on #06C755. */}
      <header className="flex items-center justify-between gap-3 bg-brand px-5 pb-3 pt-[calc(env(safe-area-inset-top)+0.85rem)]">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white text-lg" aria-hidden>
            ⛪
          </span>
          <p className="text-sm font-bold text-primary-deep">教會停車 · 會友專區</p>
        </div>
        <button
          type="button"
          onClick={logout}
          disabled={busy}
          className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg px-3 text-sm font-medium text-primary-deep/80 transition-colors active:bg-black/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-deep focus-visible:ring-offset-2 disabled:opacity-50"
        >
          登出
        </button>
      </header>

      <section className="flex-1 space-y-4 px-5 pb-[calc(env(safe-area-inset-bottom)+2rem)] pt-5">
        <p className="text-sm text-muted">{status.displayName}，平安</p>

        {status.sundayDate === null ? (
          <div className={`${CARD} text-center`}>
            <p className="text-lg font-medium">本週登記尚未開放</p>
            <p className="mt-2 text-sm text-muted">開放後可在此登記並查看您的停車預約</p>
          </div>
        ) : (
          <>
            {/* 本週主日 hero — deep→mid green gradient, white text passes AA. */}
            <div className="rounded-2xl bg-gradient-to-br from-primary to-primary-deep p-4 text-white shadow-[0_8px_20px_rgba(21,128,61,0.22)]">
              <p className="text-xs font-medium tracking-wide text-white/80">本週主日</p>
              <p className="mt-0.5 text-2xl font-extrabold tracking-tight text-balance">
                {sundayLabel(status.sundayDate)}
              </p>
            </div>

            {r && view && (
              <div className={CARD}>
                <p className="text-[11px] font-bold uppercase tracking-wider text-muted">本週停車狀態</p>
                <div className="mt-2.5">
                  <Badge tone={view.tone} className="text-sm">
                    {view.label}
                  </Badge>
                </div>
                {r.plate && (
                  <p className="mt-4 font-mono text-2xl font-bold tracking-wide">{r.plate}</p>
                )}
                {view.detail && <p className="mt-3 text-sm leading-relaxed text-muted">{view.detail}</p>}
                {view.note && <p className="mt-1 text-xs leading-relaxed text-muted">{view.note}</p>}
                {status.canRespondOffer && <OfferActions disabled={busy} />}
                {status.canReportOnTheWay && <OnTheWayButton disabled={busy} />}
                {status.canCancel && (
                  <CancelButton approved={r.status === 'approved'} disabled={busy} />
                )}
              </div>
            )}

            {status.apply && (
              <ApplyBlock apply={status.apply} hasCancelledCard={r !== null} />
            )}
          </>
        )}

        <p className="pt-8 text-center text-xs text-muted/80">
          如有停車需求或異動，請聯繫教會停車同工
        </p>
      </section>
    </main>
  )
}

// Substitution-offer response (Slice 4): confirm is one tap (it secures the spot);
// decline arms first (it gives the spot to the next candidate — irreversible).
function OfferActions({ disabled }: { disabled: boolean }) {
  const router = useRouter()
  const [arming, setArming] = useState(false)
  const [submitting, setSubmitting] = useState<'confirm' | 'decline' | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function respond(action: 'confirm' | 'decline') {
    setSubmitting(action)
    setError(null)
    try {
      const res = await fetch('/api/member/reservation/offer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      const body = (await res.json()) as { ok: boolean; reason?: string }
      if (res.ok && body.ok) {
        router.refresh()
        return
      }
      setError(
        body.reason === 'offer_expired'
          ? '確認期限已過，車位已釋出給下一位候補'
          : '目前沒有待確認的遞補，請重新整理',
      )
      setArming(false)
    } catch {
      setError('連線失敗，請再試一次')
    } finally {
      setSubmitting(null)
    }
  }

  return (
    <div className="mt-5 space-y-2">
      {arming ? (
        <>
          <p className="text-sm text-warning-fg">確定放棄？車位將轉給下一位候補</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => respond('decline')}
              disabled={submitting !== null || disabled}
              className={`${BTN} flex-1 bg-danger-fg text-white active:bg-danger-fg/90`}
            >
              {submitting === 'decline' ? '送出中…' : '確定放棄'}
            </button>
            <button
              type="button"
              onClick={() => setArming(false)}
              disabled={submitting !== null}
              className={`${BTN} flex-1 border border-border bg-surface text-ink active:bg-border-subtle`}
            >
              返回
            </button>
          </div>
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={() => respond('confirm')}
            disabled={submitting !== null || disabled}
            className={`${BTN} bg-primary text-white active:bg-primary/90`}
          >
            {submitting === 'confirm' ? '確認中…' : '確認保留車位'}
          </button>
          <button
            type="button"
            onClick={() => setArming(true)}
            disabled={submitting !== null || disabled}
            className={`${BTN} border border-border bg-surface text-muted active:bg-border-subtle`}
          >
            放棄這個車位
          </button>
        </>
      )}
      {error && <p className="text-sm text-danger-fg" role="alert">{error}</p>}
    </div>
  )
}

// P2 「正在路上」(Slice 4): one tap extends the 10:45 deadline to the 10:55 grace.
function OnTheWayButton({ disabled }: { disabled: boolean }) {
  const router = useRouter()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function report() {
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/member/reservation/on-the-way', { method: 'POST' })
      const body = (await res.json()) as { ok: boolean }
      if (res.ok && body.ok) {
        router.refresh()
        return
      }
      setError('目前無法回報（可能已過期限），請重新整理')
    } catch {
      setError('連線失敗，請再試一次')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mt-5">
      <button
        type="button"
        onClick={report}
        disabled={submitting || disabled}
        className={`${BTN} bg-warning-fg text-white active:bg-warning-fg/90`}
      >
        {submitting ? '回報中…' : '我正在路上（保留至 10:55）'}
      </button>
      {error && <p className="mt-2 text-sm text-danger-fg" role="alert">{error}</p>}
    </div>
  )
}

// Two-step cancel: first tap arms, second tap fires (same posture as the staff
// page's undo-window — no accidental releases from a pocket tap).
function CancelButton({ approved, disabled }: { approved: boolean; disabled: boolean }) {
  const router = useRouter()
  const [arming, setArming] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function doCancel() {
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/member/reservation/cancel', { method: 'POST' })
      const body = (await res.json()) as { ok: boolean; reason?: string }
      if (res.ok && body.ok) {
        router.refresh()
        return
      }
      setError(
        body.reason === 'offer_in_progress'
          ? '目前為遞補確認中，暫無法取消'
          : body.reason === 'nothing_to_cancel'
            ? '本週沒有可取消的登記，請重新整理'
            : '目前無法取消，請聯繫同工',
      )
      setArming(false)
    } catch {
      setError('連線失敗，請再試一次')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mt-5">
      {arming ? (
        <div className="space-y-2">
          <p className="text-sm text-warning-fg">
            {approved ? '確定取消？車位將釋出給候補會友' : '確定取消本週登記？'}
          </p>
          {/* The fear that stops members cancelling is "will this count against me?" — it does
              not: only a released_late row becomes no_show (settleNoShow). Deliberately states
              no time: cancelling is never recorded, and each member's release deadline differs
              (10:30 / 10:45 / 10:55), so naming one hour would be wrong for P2. */}
          <p className="text-xs leading-relaxed text-muted">
            主動取消不會被記為未到場；已核准但未取消且未到場，才會列入未到場紀錄。
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={doCancel}
              disabled={submitting || disabled}
              className={`${BTN} flex-1 bg-danger-fg text-white active:bg-danger-fg/90`}
            >
              {submitting ? '取消中…' : '確定取消'}
            </button>
            <button
              type="button"
              onClick={() => setArming(false)}
              disabled={submitting}
              className={`${BTN} flex-1 border border-border bg-surface text-ink active:bg-border-subtle`}
            >
              返回
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setArming(true)}
          disabled={disabled}
          className={`${BTN} border border-danger-fg/30 bg-surface text-danger-fg active:bg-danger-bg`}
        >
          取消本週登記
        </button>
      )}
      {error && <p className="mt-2 text-sm text-danger-fg" role="alert">{error}</p>}
    </div>
  )
}

function ApplyBlock({
  apply,
  hasCancelledCard,
}: {
  apply: NonNullable<MemberWeekStatus['apply']>
  hasCancelledCard: boolean
}) {
  const router = useRouter()
  const [vehicleId, setVehicleId] = useState(apply.vehicles[0]?.id ?? '')
  const [companion, setCompanion] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (apply.staffP1) {
    return (
      <div className={`${CARD} text-center`}>
        <p className="text-base text-muted">全職同工車位由每週保留名額管理，無需登記</p>
      </div>
    )
  }
  if (apply.closed) {
    return (
      <div className={`${CARD} text-center`}>
        <p className="text-lg font-medium">本週登記已截止</p>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          週五分配已完成；主日若臨時需要車位，請至現場洽停車同工
        </p>
      </div>
    )
  }
  if (apply.vehicles.length === 0) {
    return (
      <div className={`${CARD} text-center`}>
        <p className="text-base font-medium">尚未登記車輛資料</p>
        <p className="mt-2 text-sm text-muted">請聯繫停車同工登記您的車牌後再使用線上登記</p>
      </div>
    )
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (submitting || vehicleId === '') return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/member/reservation/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ vehicleId, requestedP2: companion }),
      })
      const body = (await res.json()) as { ok: boolean; reason?: string }
      if (res.ok && body.ok) {
        router.refresh()
        return
      }
      setError(APPLY_ERROR_COPY[body.reason ?? ''] ?? '登記失敗，請稍後再試')
    } catch {
      setError('連線失敗，請再試一次')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={submit} className={CARD}>
      <p className="text-[11px] font-bold uppercase tracking-wider text-muted">
        {hasCancelledCard ? '重新登記本週停車' : '登記本週停車'}
      </p>
      {/* States the SCHEDULE, never a cutoff: this block is gated by hasFridayAllocationRun,
          not by a clock, so if the friday-allocation cron is late the page is still open —
          promising "18:00 截止" here would contradict the form right below it. 18:00 is that
          cron's scheduled time (runbook §6); if ops reschedules it, this copy moves too. */}
      <p className="mt-1 text-xs text-muted">車位預計於週五 18:00 分配</p>

      <label className="mt-4 block text-sm text-muted" htmlFor="apply-vehicle">車輛</label>
      <select
        id="apply-vehicle"
        value={vehicleId}
        onChange={e => setVehicleId(e.target.value)}
        className="mt-1 h-12 w-full rounded-xl border border-border bg-surface px-4 text-base text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/30"
      >
        {apply.vehicles.map(v => (
          <option key={v.id} value={v.id}>
            {v.plate}
            {v.nickname ? `（${v.nickname}）` : ''}
          </option>
        ))}
      </select>

      {apply.companionKind && (
        <label className="mt-4 flex min-h-12 items-start gap-3 rounded-xl bg-info-bg/50 p-3 text-base">
          <input
            type="checkbox"
            checked={companion}
            onChange={e => setCompanion(e.target.checked)}
            className="mt-0.5 h-5 w-5 accent-info-fg"
          />
          <span>
            本週有{apply.companionKind === 'elderly' ? '年長者' : '學齡前幼兒'}同行
            <span className="mt-0.5 block text-xs text-muted">勾選後本次享 P2 優先順序</span>
          </span>
        </label>
      )}

      <p className="mt-3 h-5 text-sm text-danger-fg" role="alert">{error ?? ''}</p>

      <button
        type="submit"
        disabled={submitting}
        className={`${BTN} bg-primary text-white active:bg-primary-strong`}
      >
        {submitting ? '送出中…' : '送出登記'}
      </button>
    </form>
  )
}
