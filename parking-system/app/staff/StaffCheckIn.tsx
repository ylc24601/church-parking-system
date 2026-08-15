'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { normalizePlate, highlightPlateMatch } from '@/lib/plate'
import { saveStaffCache, loadStaffCache, clearStaffCache, isCacheCurrent } from '@/lib/staffCache'
import {
  type StaffRow,
  DONE_STATUSES,
  rowName,
  rowPlate,
  isWalkIn,
  sundayLabel,
  statusLabel,
} from '@/lib/staffRow'
import Badge, { type BadgeTone } from '../ui/Badge'

export type { StaffRow }

const UNDO_MS = 5000

// Row status badge tone. Text always comes from statusLabel() (the lib/staffRow
// single source shared with the print sheet) — this only picks the colour. Walk-ins
// read as info (現場) to signal the on-site source; otherwise it tracks attendance.
function statusTone(r: StaffRow): BadgeTone {
  if (isWalkIn(r)) return 'info'
  if (r.status === 'released_late') return 'warning'
  if (DONE_STATUSES.has(r.status)) return 'success'
  return 'neutral' // approved / not yet arrived
}

// Left card stripe = attendance/operational status ONLY (walk-in counts as done);
// vehicle type (優先/現場) is shown as a separate badge, not encoded in the stripe.
function stripeClass(r: StaffRow): string {
  if (r.status === 'released_late') return 'border-l-warning-fg'
  if (DONE_STATUSES.has(r.status)) return 'border-l-success-fg'
  return 'border-l-neutral-fg/40'
}

interface EventInfo {
  id: string
  sunday_date: string
  status: string
}

type Filter = 'all' | 'pending' | 'done' | 'released'

function toStaffRow(r: StaffRow & { weekly_event_id?: string }): StaffRow {
  return {
    reservation_id: r.reservation_id,
    display_name: r.display_name,
    license_plate: r.license_plate,
    walk_in_name: r.walk_in_name,
    walk_in_license_plate: r.walk_in_license_plate,
    is_priority: r.is_priority,
    status: r.status,
    attended_at: r.attended_at,
    owner_notifiable: r.owner_notifiable ?? false,
  }
}

const timeFmt = new Intl.DateTimeFormat('zh-TW', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'Asia/Taipei',
})
function attendedTime(iso: string | null): string {
  return iso ? timeFmt.format(new Date(iso)) : ''
}

export default function StaffCheckIn({
  initialEvent,
  initialRows,
}: {
  initialEvent: EventInfo | null
  initialRows: StaffRow[]
}) {
  const router = useRouter()
  const [rows, setRows] = useState<StaffRow[]>(initialRows)
  const [event, setEvent] = useState<EventInfo | null>(initialEvent)
  const [refreshing, setRefreshing] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [toast, setToast] = useState<string | null>(null)
  // Connectivity: set on fetch failure / 'offline' event; cleared ONLY by a
  // successful reload (the 'online' event just triggers a retry).
  const [offline, setOffline] = useState(false)
  const [noCurrentList, setNoCurrentList] = useState(false)
  const [pendingName, setPendingName] = useState<string | null>(null)
  const [walkInOpen, setWalkInOpen] = useState(false)
  const [walkInPlate, setWalkInPlate] = useState('')
  const [walkInName, setWalkInName] = useState('')
  const [walkInBusy, setWalkInBusy] = useState(false)
  const [settleOpen, setSettleOpen] = useState(false)
  const [settleBusy, setSettleBusy] = useState(false)
  const [moveCarRow, setMoveCarRow] = useState<StaffRow | null>(null)
  const [moveCarBusy, setMoveCarBusy] = useState(false)
  const [moveSearchOpen, setMoveSearchOpen] = useState(false)
  const [moveSearchQuery, setMoveSearchQuery] = useState('')

  // Undo-window state lives in refs so the setTimeout never reads stale state.
  const pendingRef = useRef<{
    reservationId: string
    prevStatus: string
    prevAttendedAt: string | null
  } | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // When the shown list was last confirmed (server fetch or cache). Rendered in the
  // offline banner → must be state. Initialized from props (only read post-mount).
  const [lastUpdated, setLastUpdated] = useState<string | null>(() =>
    initialEvent && initialRows.length > 0 ? new Date().toISOString() : null,
  )

  const isOffline = () =>
    offline || (typeof navigator !== 'undefined' && navigator.onLine === false)

  // Manual refresh re-pulls the list (event handler → setState-in-effect rule N/A).
  async function reload(opts?: { silent?: boolean }): Promise<boolean> {
    if (refreshing) return false
    setRefreshing(true)
    try {
      const res = await fetch('/api/staff/checkin-list')
      if (res.status === 401) {
        router.refresh() // session gone → back to PIN
        return false
      }
      if (!res.ok) throw new Error('load failed')
      const data = (await res.json()) as {
        event: EventInfo | null
        rows: (StaffRow & { weekly_event_id?: string })[]
      }
      const fresh = data.rows.map(toStaffRow)
      setEvent(data.event)
      setRows(fresh)
      if (data.event) saveStaffCache(data.event, fresh) // confirmed → cache
      setLastUpdated(new Date().toISOString())
      setOffline(false)
      setNoCurrentList(false)
      return true
    } catch {
      // Network failure → degraded/offline. Keep the current in-memory list;
      // only fall back to cache if the screen has nothing to show.
      setOffline(true)
      if (rows.length === 0) {
        const c = loadStaffCache()
        if (c && isCacheCurrent(c)) {
          setRows(c.rows)
          setEvent({ id: c.event.id, sunday_date: c.event.sunday_date, status: '' })
          setLastUpdated(c.cachedAt)
          setNoCurrentList(false)
        } else {
          setNoCurrentList(true) // stale week / no cache → don't fake today's list
        }
      }
      if (!opts?.silent) setToast('更新失敗，顯示的是最後一次資料')
      return false
    } finally {
      setRefreshing(false)
    }
  }

  // A write returned 409 event_finalized → the week closed under us. Flip the whole
  // screen into the finalized read-only state. Returns true if it was that 409.
  async function applyFinalized409(res: Response): Promise<boolean> {
    if (res.status !== 409) return false
    const body = (await res.clone().json().catch(() => null)) as { error?: string } | null
    if (body?.error !== 'event_finalized') return false
    setEvent(e => (e ? { ...e, status: 'finalized' } : e))
    setToast('本週已結束')
    return true
  }

  // ── Undo-window check-in ─────────────────────────────────────────────────────
  function clearTimer() {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  // Commit the pending check-in to the server (called by the timer, by tapping a
  // different row, or before logout). Idempotent server-side; reconciles status.
  async function commitPending(): Promise<boolean> {
    const p = pendingRef.current
    if (!p) return true
    pendingRef.current = null
    clearTimer()
    setPendingName(null)
    try {
      const res = await fetch('/api/staff/checkin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reservationId: p.reservationId }),
      })
      if (res.status === 401) {
        router.refresh()
        return false
      }
      if (await applyFinalized409(res)) {
        // Week closed under us — roll back the optimistic row, go read-only.
        setRows(rs =>
          rs.map(x =>
            x.reservation_id === p.reservationId
              ? { ...x, status: p.prevStatus, attended_at: p.prevAttendedAt }
              : x,
          ),
        )
        return false
      }
      if (!res.ok) throw new Error('checkin failed')
      const data = (await res.json()) as { status: string }
      const next = rows.map(x =>
        x.reservation_id === p.reservationId ? { ...x, status: data.status } : x,
      )
      setRows(next)
      setOffline(false)
      if (event) saveStaffCache(event, next) // confirmed → cache
      return true
    } catch {
      setRows(rs =>
        rs.map(x =>
          x.reservation_id === p.reservationId
            ? { ...x, status: p.prevStatus, attended_at: p.prevAttendedAt }
            : x,
        ),
      )
      setOffline(true)
      setToast('點名失敗，請重試')
      return false
    }
  }

  function tapCheckIn(r: StaffRow) {
    if (settleBusy) return // settlement in flight → block concurrent writes
    if (finalized) {
      setToast('本週已結束，無法點名')
      return
    }
    if (isOffline()) {
      setToast('目前離線，請恢復網路後再操作')
      return
    }
    // Flush any previous pending first (one undo window at a time).
    if (pendingRef.current) void commitPending()

    const targetStatus = r.status === 'released_late' ? 'attended_after_release' : 'attended'
    setRows(rs =>
      rs.map(x =>
        x.reservation_id === r.reservation_id
          ? { ...x, status: targetStatus, attended_at: new Date().toISOString() }
          : x,
      ),
    )
    pendingRef.current = {
      reservationId: r.reservation_id,
      prevStatus: r.status,
      prevAttendedAt: r.attended_at,
    }
    setPendingName(rowName(r))
    timerRef.current = setTimeout(() => void commitRef.current(), UNDO_MS)
  }

  function undo() {
    const p = pendingRef.current
    if (!p) return
    clearTimer()
    pendingRef.current = null
    setPendingName(null)
    setRows(rs =>
      rs.map(x =>
        x.reservation_id === p.reservationId
          ? { ...x, status: p.prevStatus, attended_at: p.prevAttendedAt }
          : x,
      ),
    )
  }

  // "Latest callback" refs so the timer / window listeners use current state.
  const commitRef = useRef(commitPending)
  const reloadRef = useRef(reload)
  useEffect(() => {
    commitRef.current = commitPending
    reloadRef.current = reload
  })

  // Connectivity listeners + one-time confirmed cache write of the SSR data.
  useEffect(() => {
    if (initialEvent && initialRows.length > 0) saveStaffCache(initialEvent, initialRows)
    const goOffline = () => setOffline(true)
    const goOnline = () => void reloadRef.current() // may retry; reload success clears offline
    window.addEventListener('offline', goOffline)
    window.addEventListener('online', goOnline)
    return () => {
      window.removeEventListener('offline', goOffline)
      window.removeEventListener('online', goOnline)
      clearTimer()
    }
  }, [initialEvent, initialRows])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 2500)
    return () => clearTimeout(t)
  }, [toast])

  const attendedCount = useMemo(() => rows.filter(r => DONE_STATUSES.has(r.status)).length, [rows])
  // Currently-visible released-late count for the confirm sheet. The actual number
  // settled may differ — settle() runs a final release sweep server-side first.
  const releasedLateCount = useMemo(
    () => rows.filter(r => r.status === 'released_late').length,
    [rows],
  )
  // Header count bar — four MUTUALLY EXCLUSIVE buckets that sum to rows.length (so a
  // volunteer can trust the arithmetic). Walk-ins are their own bucket, NOT folded
  // into 已到 (unlike attendedCount above, which stays for the "all done" empty state).
  const arrivedCount = useMemo(
    () => rows.filter(r => !isWalkIn(r) && DONE_STATUSES.has(r.status)).length,
    [rows],
  )
  const notArrivedCount = useMemo(() => rows.filter(r => r.status === 'approved').length, [rows])
  const walkInCount = useMemo(() => rows.filter(isWalkIn).length, [rows])
  // A finalized event is a terminal, read-only week: all writes are blocked.
  const finalized = event?.status === 'finalized'

  const visibleRows = useMemo(() => {
    const q = normalizePlate(query)
    return rows.filter(r => {
      if (filter === 'pending' && r.status !== 'approved') return false
      if (filter === 'released' && r.status !== 'released_late') return false
      if (filter === 'done' && !DONE_STATUSES.has(r.status)) return false
      if (q) {
        const plate = normalizePlate(rowPlate(r))
        if (!plate.includes(q)) return false
      }
      return true
    })
  }, [rows, query, filter])

  const chips: { key: Filter; label: string }[] = [
    { key: 'all', label: '全部' },
    { key: 'pending', label: '未到' },
    { key: 'done', label: '已到' },
    { key: 'released', label: '已釋出' },
  ]

  async function logout() {
    await commitPending() // best-effort flush of an un-sent check-in
    clearStaffCache() // don't leave Staff-safe data on a shared device
    await fetch('/api/staff/logout', { method: 'POST' })
    router.refresh()
  }

  function openWalkIn(prefillPlate = '') {
    if (settleBusy || finalized) return
    setWalkInPlate(prefillPlate)
    setWalkInName('')
    setWalkInOpen(true)
  }

  async function submitWalkIn() {
    const plate = walkInPlate.trim()
    if (!plate || walkInBusy || settleBusy || finalized) return
    if (isOffline()) {
      setToast('目前離線，請恢復網路後再操作')
      return
    }
    setWalkInBusy(true)
    try {
      const res = await fetch('/api/staff/walkins', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ license_plate: plate, walk_in_name: walkInName.trim() || null }),
      })
      if (res.status === 401) {
        router.refresh()
        return
      }
      if (await applyFinalized409(res)) {
        setWalkInOpen(false)
        return
      }
      if (res.status === 409) {
        setToast('此車牌已在清單')
        return
      }
      if (!res.ok) throw new Error('walkin failed')
      const data = (await res.json()) as { row: StaffRow & { weekly_event_id?: string } }
      const next = [toStaffRow(data.row), ...rows]
      setRows(next)
      if (event) saveStaffCache(event, next) // confirmed → cache
      setWalkInOpen(false)
      setQuery('')
      setToast('已登記現場車輛')
    } catch {
      setOffline(true)
      setToast('登記失敗，請重試')
    } finally {
      setWalkInBusy(false)
    }
  }

  // 結束當週點名: settle still-released_late rows into no_show (server applies the
  // no-show/pastoral rules — none of which surface here). Irreversible → confirmed.
  async function submitSettle() {
    if (settleBusy || finalized) return
    if (isOffline()) {
      setToast('目前離線，請恢復網路後再操作')
      return
    }
    // Flush an un-sent undo check-in first; if it can't be committed, abort settle
    // so a not-yet-saved attendance isn't swept into a no-show.
    const flushed = await commitPending()
    if (!flushed) {
      setToast('尚有點名未送出，請重試')
      return
    }
    setSettleBusy(true)
    try {
      const res = await fetch('/api/staff/settle', { method: 'POST' })
      if (res.status === 401) {
        router.refresh()
        return
      }
      if (await applyFinalized409(res)) {
        // Already finalized (e.g. another device) → go read-only.
        setSettleOpen(false)
        return
      }
      if (!res.ok) {
        // Server/HTTP error is NOT the same as being offline — don't flip offline.
        setToast('結算失敗，請重試')
        return
      }
      const data = (await res.json()) as { settled: number; finalized: boolean }
      if (!data.finalized) {
        // Settlement succeeded but the week didn't close. settle() is idempotent,
        // so this is retryable — don't go read-only, don't claim full failure.
        setToast('結束本週失敗，請重新整理後再試')
        return
      }
      setSettleOpen(false)
      setEvent(e => (e ? { ...e, status: 'finalized' } : e)) // flip to read-only now
      const successMsg = `已結束本週點名（本次結算 ${data.settled} 台未到）`
      // Settle succeeded — refresh the list (settled rows become no_show and drop
      // out of the Staff list). Keep the success toast even if the reload fails.
      const reloaded = await reload({ silent: true })
      setToast(reloaded ? successMsg : `${successMsg} · 清單重新整理失敗，請稍後重新整理`)
    } catch {
      // Genuine network failure → degraded/offline.
      setOffline(true)
      setToast('結算失敗，請重試')
    } finally {
      setSettleBusy(false)
    }
  }

  // 請車主移車: enqueue a LINE OA push to the car's owner. Only for a member row with a
  // bound line_id (owner_notifiable) — the button is disabled otherwise. The owner is
  // resolved server-side; nothing here or in the response reveals contact info.
  function openMoveCar(r: StaffRow) {
    if (settleBusy || finalized || moveCarBusy) return
    if (!r.owner_notifiable) return
    setMoveCarRow(r)
  }

  // 通知移車 unified entry (38a). Only ever reaches vehicles already on this week's list —
  // it is NOT a cross-week vehicle lookup (that's #38b, gated on #6A, still Deferred).
  function openMoveSearch() {
    if (settleBusy || finalized) return
    setMoveSearchQuery('')
    setMoveSearchOpen(true)
  }

  // At most one bottom sheet is ever open: every transition out of the search sheet closes
  // it (and clears the query, so reopening always starts blank) BEFORE opening the next one.
  function closeMoveSearch() {
    setMoveSearchOpen(false)
    setMoveSearchQuery('')
  }

  function selectMoveCandidate(r: StaffRow) {
    if (!r.owner_notifiable) return
    closeMoveSearch() // close this sheet first — openMoveCar() opens the next one
    openMoveCar(r)
  }

  function moveSearchToWalkIn() {
    const plate = moveSearchQuery // capture before closeMoveSearch() clears it
    closeMoveSearch()
    openWalkIn(plate)
  }

  const moveCandidates = useMemo(() => {
    const q = normalizePlate(moveSearchQuery)
    if (!q) return []
    return rows.filter(r => normalizePlate(rowPlate(r)).includes(q))
  }, [rows, moveSearchQuery])

  async function submitMoveCar() {
    const r = moveCarRow
    if (!r || moveCarBusy || settleBusy || finalized) return
    if (isOffline()) {
      setToast('目前離線，請恢復網路後再操作')
      return
    }
    // Flush an un-sent undo check-in first (same guard as settle); abort if it can't commit.
    const flushed = await commitPending()
    if (!flushed) {
      setToast('尚有點名未送出，請重試')
      return
    }
    setMoveCarBusy(true)
    try {
      const res = await fetch('/api/staff/move-car', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reservationId: r.reservation_id }),
      })
      if (res.status === 401) {
        router.refresh()
        return
      }
      if (await applyFinalized409(res)) {
        setMoveCarRow(null)
        return
      }
      if (res.status === 422) {
        setToast('此車主未綁定 LINE，無法通知')
        setMoveCarRow(null)
        return
      }
      if (!res.ok) {
        // Server/HTTP error is not the same as offline — allow a retry from the open sheet.
        setToast('移車通知失敗，請重試')
        return
      }
      setMoveCarRow(null)
      // Enqueue-only: don't imply instant delivery (dispatcher sends on its schedule).
      setToast('已建立移車通知，系統將透過 LINE 發送')
    } catch {
      setOffline(true)
      setToast('移車通知失敗，請重試')
    } finally {
      setMoveCarBusy(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col bg-page text-ink">
      {/* Deep-green app bar. White text on primary-deep passes AA. */}
      <header className="sticky top-0 z-10 bg-primary-deep px-4 pb-3 pt-[calc(env(safe-area-inset-top)+0.75rem)] text-white shadow-sm">
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-lg font-bold">{event ? sundayLabel(event.sunday_date) : '現場點名'}</h1>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => void reload()}
              disabled={refreshing}
              aria-label="重新整理"
              className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-lg text-white/90 transition-colors active:bg-black/15 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-primary-deep"
            >
              🔄
            </button>
            {/* Irreversible end-of-service settlement (#37): a labelled button, not hidden behind
                an overflow menu — it sits in the top-right corner, away from the thumb zone where
                footer taps happen, so #24's anti-mis-tap intent holds without needing a menu. */}
            <button
              type="button"
              disabled={!event || finalized || settleBusy || offline}
              onClick={() => setSettleOpen(true)}
              className="inline-flex min-h-11 items-center rounded-lg border border-white/55 px-2.5 text-sm font-semibold text-white transition-colors active:bg-black/15 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-primary-deep"
            >
              結束點名
            </button>
            <button
              type="button"
              onClick={logout}
              className="inline-flex min-h-11 items-center justify-center rounded-lg px-2 text-sm font-medium text-white/90 transition-colors active:bg-black/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-primary-deep"
            >
              登出
            </button>
          </div>
        </div>

        {/* Mutually-exclusive counts (sum = total). */}
        <div className="mt-2 flex gap-1.5 text-xs font-semibold tabular-nums">
          <span className="rounded-md bg-black/15 px-2.5 py-1">已到 {arrivedCount}</span>
          <span className="rounded-md bg-black/15 px-2.5 py-1">未到 {notArrivedCount}</span>
          <span className="rounded-md bg-black/15 px-2.5 py-1">已釋出 {releasedLateCount}</span>
          <span className="rounded-md bg-black/15 px-2.5 py-1">現場 {walkInCount}</span>
        </div>

        <input
          inputMode="numeric"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="🔍 輸入車牌任意數字…"
          className="mt-3 h-12 w-full rounded-xl bg-white px-4 text-base text-ink placeholder:text-muted outline-none focus:ring-2 focus:ring-primary"
        />

        <div className="mt-2.5 flex gap-2">
          {chips.map(c => (
            <button
              key={c.key}
              type="button"
              onClick={() => setFilter(c.key)}
              className={`inline-flex min-h-11 items-center rounded-full px-3.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-primary-deep ${
                filter === c.key ? 'bg-white text-primary-deep' : 'bg-white/15 text-white'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      </header>

      {offline && (
        <div className="bg-warning-bg px-4 py-2 text-center text-sm font-medium text-warning-fg">
          ⚠ 離線中
          {lastUpdated ? ` · 資料更新於 ${attendedTime(lastUpdated)}` : '，請恢復網路後重新整理'}
          {lastUpdated && event ? `（${sundayLabel(event.sunday_date)}）` : ''}
        </div>
      )}

      {finalized && (
        <div className="bg-neutral-bg px-4 py-2 text-center text-sm text-neutral-fg">
          本週點名已結束，僅供檢視
        </div>
      )}

      {/* List */}
      <section className="flex-1 px-4">
        {noCurrentList ? (
          <p className="py-16 text-center text-muted">
            尚未下載本週清單，請恢復網路後重新整理
          </p>
        ) : rows.length === 0 ? (
          <p className="py-16 text-center text-muted">
            {event ? '本週尚無核准車輛' : '尚未開放本週點名'}
          </p>
        ) : visibleRows.length === 0 ? (
          <div className="py-16 text-center text-muted">
            {query ? (
              <>
                <p>找不到符合車牌</p>
                <button
                  type="button"
                  onClick={() => openWalkIn(query)}
                  className="mt-4 h-12 rounded-xl bg-primary px-5 text-base font-semibold text-white transition-colors active:bg-primary/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                >
                  ＋ 登記為現場車輛
                </button>
              </>
            ) : attendedCount === rows.length ? (
              <p>全部車輛已到 🎉</p>
            ) : (
              <p>沒有符合的車輛</p>
            )}
          </div>
        ) : (
          <ul className="flex flex-col gap-2 py-3">
            {visibleRows.map(r => {
              const done = DONE_STATUSES.has(r.status)
              const released = r.status === 'released_late'
              return (
                <li
                  key={r.reservation_id}
                  className={`flex items-center justify-between gap-3 rounded-xl border border-border border-l-4 ${stripeClass(r)} bg-surface p-3 ${done ? 'opacity-70' : ''}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      {r.is_priority && <Badge tone="priority">⭐ 優先</Badge>}
                      <span className="truncate text-base font-bold">{rowName(r)}</span>
                    </div>
                    <p className="mt-0.5 font-mono text-base tracking-wide text-muted">
                      {rowPlate(r)}
                    </p>
                    <div className="mt-1">
                      <Badge tone={statusTone(r)}>
                        {statusLabel(r.status)}
                        {done && attendedTime(r.attended_at) ? ` ${attendedTime(r.attended_at)}` : ''}
                      </Badge>
                    </div>
                  </div>

                  <div className="flex shrink-0 flex-col items-end gap-2">
                    {!done && (
                      <button
                        type="button"
                        onClick={() => tapCheckIn(r)}
                        disabled={finalized}
                        className={`h-12 rounded-xl px-5 text-base font-semibold text-white transition-colors disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ${
                          released ? 'bg-warning-fg active:bg-warning-fg/90' : 'bg-primary active:bg-primary/90'
                        }`}
                      >
                        {released ? '補點名' : '點名'}
                      </button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {/* Thumb zone holds ONLY the two high-frequency actions. Printing moved to /admin/print
          (#23); the irreversible end-of-service settlement moved to an appbar button (#37) so
          it can't be hit by mistake while reaching for either of these. */}
      <footer className="border-t border-border bg-surface px-4 pt-4 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => openWalkIn()}
            disabled={finalized}
            className="h-12 flex-1 rounded-xl bg-primary text-base font-semibold text-white transition-colors active:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
          >
            ＋ 登記現場車輛
          </button>
          {/* 通知移車 (38a): unified entry point — plate search over the on-site list, replacing
              the old per-row button. Only reaches vehicles already on this week's list. */}
          <button
            type="button"
            onClick={openMoveSearch}
            disabled={finalized || settleBusy}
            className="h-12 shrink-0 rounded-xl border border-priority-fg/40 px-4 text-base font-semibold text-priority-fg transition-colors active:bg-priority-bg disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
          >
            🚗 通知移車
          </button>
        </div>
      </footer>

      {walkInOpen && (
        <div className="fixed inset-0 z-20 flex flex-col justify-end bg-black/50">
          <button
            type="button"
            aria-label="關閉"
            className="flex-1"
            onClick={() => !walkInBusy && setWalkInOpen(false)}
          />
          <div className="mx-auto max-h-[calc(100dvh-env(safe-area-inset-top))] w-full max-w-md overflow-y-auto overscroll-contain rounded-t-2xl border-t border-border bg-surface px-4 pt-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)]">
            <h2 className="text-lg font-bold">登記現場車輛</h2>
            <label className="mt-4 block text-sm text-muted">車牌 *</label>
            <input
              autoFocus
              value={walkInPlate}
              onChange={e => setWalkInPlate(e.target.value)}
              placeholder="例：ABC-1234"
              className="mt-1 h-12 w-full rounded-xl border border-border bg-surface px-4 text-base text-ink placeholder:text-muted outline-none focus:border-primary focus:ring-2 focus:ring-primary/30"
            />
            <label className="mt-3 block text-sm text-muted">姓名／備註（選填）</label>
            <input
              value={walkInName}
              onChange={e => setWalkInName(e.target.value)}
              className="mt-1 h-12 w-full rounded-xl border border-border bg-surface px-4 text-base text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/30"
            />
            <div className="mt-5 flex gap-3">
              <button
                type="button"
                onClick={() => setWalkInOpen(false)}
                disabled={walkInBusy}
                className="h-12 flex-1 rounded-xl border border-border bg-surface text-base text-ink transition-colors active:bg-border-subtle disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void submitWalkIn()}
                disabled={walkInBusy || walkInPlate.trim() === ''}
                className="h-12 flex-1 rounded-xl bg-primary text-base font-semibold text-white transition-colors active:bg-primary/90 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
              >
                確認登記
              </button>
            </div>
          </div>
        </div>
      )}

      {settleOpen && (
        <div className="fixed inset-0 z-20 flex flex-col justify-end bg-black/50">
          <button
            type="button"
            aria-label="關閉"
            className="flex-1"
            onClick={() => !settleBusy && setSettleOpen(false)}
          />
          <div className="mx-auto max-h-[calc(100dvh-env(safe-area-inset-top))] w-full max-w-md overflow-y-auto overscroll-contain rounded-t-2xl border-t border-border bg-surface px-4 pt-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)]">
            <h2 className="text-lg font-bold">結束本週點名</h2>
            <p className="mt-3 text-sm text-ink">
              目前有 {releasedLateCount} 台已釋出未到將被結算。
            </p>
            <p className="mt-2 text-sm text-ink">
              將所有「已釋出未到」標記為未到並結束本週點名，<span className="font-semibold text-danger-fg">此動作無法復原</span>。
            </p>
            <p className="mt-2 text-xs text-muted">
              實際結算台數可能不同：系統會先做一次最終釋出掃描再結算。
            </p>
            <div className="mt-5 flex gap-3">
              <button
                type="button"
                onClick={() => setSettleOpen(false)}
                disabled={settleBusy}
                className="h-12 flex-1 rounded-xl border border-border bg-surface text-base text-ink transition-colors active:bg-border-subtle disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void submitSettle()}
                disabled={settleBusy}
                className="h-12 flex-1 rounded-xl bg-danger-fg text-base font-semibold text-white transition-colors active:bg-danger-fg/90 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
              >
                {settleBusy ? '結算中…' : '確認結束'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 通知移車 search sheet (38a). Mutually exclusive with moveCarRow/walkInOpen — every
          transition below closes this sheet before opening the next one (see
          selectMoveCandidate / moveSearchToWalkIn), so at most one bottom sheet is ever up. */}
      {moveSearchOpen && (
        <div className="fixed inset-0 z-20 flex flex-col justify-end bg-black/50">
          <button
            type="button"
            aria-label="關閉"
            className="flex-1"
            onClick={closeMoveSearch}
          />
          <div className="mx-auto flex max-h-[calc(100dvh-env(safe-area-inset-top))] w-full max-w-md flex-col overflow-y-auto overscroll-contain rounded-t-2xl border-t border-border bg-surface px-4 pt-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)]">
            <h2 className="text-lg font-bold">通知移車</h2>
            <input
              autoFocus
              inputMode="numeric"
              value={moveSearchQuery}
              onChange={e => setMoveSearchQuery(e.target.value)}
              placeholder="輸入車牌任意數字…"
              className="mt-3 h-12 w-full rounded-xl border border-border bg-surface px-4 font-mono text-lg tracking-wide text-ink placeholder:font-sans placeholder:text-base placeholder:tracking-normal placeholder:text-muted outline-none focus:border-primary focus:ring-2 focus:ring-primary/30"
            />

            {moveSearchQuery.trim() === '' ? null : moveCandidates.length === 0 ? (
              <div className="mt-4 rounded-xl border border-dashed border-border p-3 text-center">
                <p className="text-sm font-semibold">本週清單中沒有含「{moveSearchQuery}」的車牌</p>
                <p className="mt-1.5 text-xs text-muted">
                  這裡只找得到本週已核准與已登記的現場車輛。若是訪客或沒登記就開進來的車，目前無法從系統查到車主。
                </p>
                <button
                  type="button"
                  onClick={moveSearchToWalkIn}
                  className="mt-3 h-11 rounded-lg bg-primary px-4 text-sm font-semibold text-white transition-colors active:bg-primary/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                >
                  ＋ 登記為現場車輛
                </button>
              </div>
            ) : (
              <ul className="mt-3 flex flex-col gap-2">
                {moveCandidates.map(r => {
                  const { before, match, after } = highlightPlateMatch(rowPlate(r), moveSearchQuery)
                  return (
                    <li
                      key={r.reservation_id}
                      className="flex items-center justify-between gap-3 rounded-xl border border-border p-2.5"
                    >
                      <div className="min-w-0">
                        <p className="font-mono text-base tracking-wide">
                          {before}
                          <mark className="rounded-sm bg-warning-bg text-warning-fg">{match}</mark>
                          {after}
                        </p>
                        <div className="mt-0.5 flex items-center gap-1.5">
                          {r.is_priority && <Badge tone="priority">⭐ 優先</Badge>}
                          {isWalkIn(r) && <Badge tone="info">現場</Badge>}
                          <span className="truncate text-sm font-medium">{rowName(r)}</span>
                        </div>
                      </div>
                      {r.owner_notifiable ? (
                        <button
                          type="button"
                          onClick={() => selectMoveCandidate(r)}
                          className="inline-flex min-h-11 shrink-0 items-center rounded-lg border border-priority-fg/40 px-3 text-sm font-medium text-priority-fg transition-colors active:bg-priority-bg focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                        >
                          通知移車
                        </button>
                      ) : (
                        <span className="shrink-0 text-xs text-muted">無法通知</span>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}

            <div className="mt-5">
              <button
                type="button"
                onClick={closeMoveSearch}
                className="h-12 w-full rounded-xl border border-border bg-surface text-base text-ink transition-colors active:bg-border-subtle focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {moveCarRow && (
        <div className="fixed inset-0 z-20 flex flex-col justify-end bg-black/50">
          <button
            type="button"
            aria-label="關閉"
            className="flex-1"
            onClick={() => !moveCarBusy && setMoveCarRow(null)}
          />
          <div className="mx-auto max-h-[calc(100dvh-env(safe-area-inset-top))] w-full max-w-md overflow-y-auto overscroll-contain rounded-t-2xl border-t border-border bg-surface px-4 pt-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)]">
            <h2 className="text-lg font-bold">請車主移車</h2>
            <p className="mt-3 text-sm text-ink">
              透過教會 LINE 通知車牌 <span className="font-mono tracking-wide">{rowPlate(moveCarRow)}</span> 的車主移車？
            </p>
            <p className="mt-2 text-xs text-muted">
              通知由教會官方帳號代發，不會顯示您的個人聯絡方式。
            </p>
            <div className="mt-5 flex gap-3">
              <button
                type="button"
                onClick={() => setMoveCarRow(null)}
                disabled={moveCarBusy}
                className="h-12 flex-1 rounded-xl border border-border bg-surface text-base text-ink transition-colors active:bg-border-subtle disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void submitMoveCar()}
                disabled={moveCarBusy}
                className="h-12 flex-1 rounded-xl bg-priority-fg text-base font-semibold text-white transition-colors active:bg-priority-fg/90 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
              >
                {moveCarBusy ? '傳送中…' : '送出通知'}
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingName && (
        <div className="fixed inset-x-0 bottom-28 z-30 mx-auto flex w-fit items-center gap-2 rounded-full bg-ink pl-4 pr-1.5 text-sm text-white shadow-lg">
          <span>已點名 {pendingName} · 尚未送出</span>
          <button
            type="button"
            onClick={undo}
            className="inline-flex min-h-11 items-center rounded-full px-3 font-bold text-white underline underline-offset-2 transition-opacity active:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            復原
          </button>
        </div>
      )}

      {toast && (
        <div className="fixed inset-x-0 bottom-24 z-30 mx-auto w-fit rounded-full bg-danger-fg px-4 py-2 text-sm font-medium text-white shadow-lg">
          {toast}
        </div>
      )}
    </main>
  )
}
