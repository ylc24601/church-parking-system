'use client'

import { useRouter } from 'next/navigation'
import Link from 'next/link'
import type { WeekOverview } from '@/lib/adminTodoTypes'
import { buildAdminTodoRows } from '@/lib/adminTodoRows'
import { fmtTaipeiTime } from '@/lib/taipeiDate'
import { pendingNeedsAttention, type DemandCounts } from '@/lib/weekDemand'
import { WEEK_STAGE_LABEL, type WeekStage } from '@/lib/weekStage'
import Badge, { type BadgeTone } from '../ui/Badge'
import { useAdminTodos } from './AdminTodoProvider'

// Back-office overview (Wave 3 / #8). The landing dashboard: 上指標 (this week's stage
// + capacity, live from the server) over 下待辦 (attention items, from the shared todo
// snapshot). The todo numbers come from useAdminTodos() — the SAME snapshot the sidebar
// badges read — so the two can never disagree.

const STAGE_TONE: Record<WeekStage, BadgeTone> = {
  no_event: 'warning',
  application_open: 'success',
  allocated: 'info',
  finalized: 'neutral',
  closed: 'neutral',
}

// A metric. `sub` carries the 優先/一般 split under 申請中; `tone="warning"` recolours the
// number — never on its own, always alongside wording in `sub` that says what is off
// (design-spec §1.6: colour is not the only carrier of meaning). An optional `href` (#35)
// makes the whole tile a drilldown link into /admin/week — the only entry point for that
// page, so the number stays clickable without the dashboard growing new PII of its own.
function Stat({
  label,
  value,
  sub,
  tone,
  href,
}: {
  label: string
  value: number
  sub?: string
  tone?: 'warning'
  href?: string
}) {
  const accent = tone === 'warning' ? 'text-warning-fg' : ''
  const body = (
    <>
      <span className="text-xs text-muted">{label}</span>
      <span className={`text-2xl font-bold tabular-nums ${accent || 'text-ink'}`}>{value}</span>
      {sub && <span className={`text-xs ${accent || 'text-muted'}`}>{sub}</span>}
    </>
  )
  if (href) {
    // The affordance is spelled out rather than left to hover alone: this tile is the only
    // entry point to /admin/week, and a number that merely changes colour on hover is
    // invisible to anyone who never hovers it (and to touch entirely).
    return (
      <Link
        href={href}
        className="group flex flex-col gap-0.5 rounded-lg transition-colors hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
      >
        {body}
        <span className="text-xs font-medium text-primary underline-offset-2 group-hover:underline">
          查看名單 →
        </span>
      </Link>
    )
  }
  return <div className="flex flex-col gap-0.5">{body}</div>
}

// 供給 / 需求 group heading — design-spec §1.2 micro-label (11px/700, tracked, muted).
// No uppercase: the labels are CJK, where it does nothing.
const GROUP_LABEL = 'text-[11px] font-bold tracking-[0.1em] text-muted'

// The 優先/一般 split, plus — when the number is highlighted — wording for why. Says what the
// state IS ("still pending"), not what the operator did wrong: a running allocation job
// legitimately shows pending rows (see lib/weekDemand.ts).
//
// Zero gets no sub-line: 「優先 0 ／ 一般 0」 restates the 0 above it, and a normal post-
// allocation week would carry that noise permanently.
function pendingSub(pending: DemandCounts, needsAttention: boolean): string | undefined {
  if (pending.total === 0) return undefined
  const split = `優先 ${pending.priority} ／ 一般 ${pending.general}`
  return needsAttention ? `${split} · 分配後仍有申請中` : split
}

// A count-less row (a clerk's notification verdict, #17 C) carries its severity in the
// container colour instead of a badge — otherwise a danger row would look like plain text.
const NOTICE_TONE: Record<BadgeTone, string> = {
  danger: 'border-danger-fg/30 bg-danger-bg text-danger-fg',
  warning: 'border-warning-fg/30 bg-warning-bg text-warning-fg',
  info: 'border-border bg-page text-muted',
  success: 'border-success-fg/30 bg-success-bg text-success-fg',
  priority: 'border-priority-fg/30 bg-priority-bg text-priority-fg',
  neutral: 'border-border bg-page text-muted',
}

// A todo row. With an href it links to the page that clears it and shows a count badge;
// without one it is a non-interactive notice tinted by tone (#17 C: clerk health verdict).
function TodoRow({ href, label, count, tone }: { href?: string; label: string; count?: number; tone: BadgeTone }) {
  if (href) {
    return (
      <Link
        href={href}
        className="flex items-center justify-between gap-3 rounded-lg border border-border bg-page px-4 py-3 text-sm transition-colors hover:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
      >
        <span className="font-medium text-ink">{label}</span>
        {count !== undefined && <Badge tone={tone}>{count}</Badge>}
      </Link>
    )
  }
  return (
    <div className={`flex items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm font-medium ${NOTICE_TONE[tone]}`}>
      <span>{label}</span>
      {count !== undefined && <Badge tone={tone}>{count}</Badge>}
    </div>
  )
}

export default function AdminOverview({ overview }: { overview: WeekOverview }) {
  const router = useRouter()
  const { counts, snapshotAt } = useAdminTodos()

  // Rows come from the shared pure builder, so 🎉 shows iff it returns [] — meaning
  // "nothing THIS ROLE needs to handle" (#17 C). A superadmin's healthy-but-draining
  // backlog still produces its own "通知待送" row, so their 🎉 is genuine; a clerk's plain
  // verdict has no backlog to surface, so a draining queue correctly shows no row.
  const todos = counts ? buildAdminTodoRows(counts) : []
  const pendingAttention = pendingNeedsAttention(overview.stage, overview.demand?.pending.total ?? 0)

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col gap-6 bg-page px-6 py-8 text-ink">
      <h1 className="text-2xl font-bold tracking-tight">本週概覽</h1>

      {/* 上指標 — this week's stage + capacity (live) */}
      <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-muted">本週主日</span>
          <span className="font-semibold tabular-nums text-ink">{overview.sunday}</span>
          <Badge tone={STAGE_TONE[overview.stage]}>{WEEK_STAGE_LABEL[overview.stage]}</Badge>
        </div>
        {overview.capacity && overview.demand ? (
          <div className="grid gap-5 pt-1 sm:grid-cols-2">
            <div role="group" aria-labelledby="week-supply" className="flex flex-col gap-3">
              <h2 id="week-supply" className={GROUP_LABEL}>供給</h2>
              <div className="flex flex-wrap gap-8">
                <Stat label="可分配總數" value={overview.capacity.allocatable} />
                <Stat label="保留·停用" value={overview.capacity.blocked} />
                <Stat label="已核准" value={overview.capacity.promised} />
              </div>
            </div>
            {/* Hairline divider (design-spec §2.3: no shadows) — above the group on a
                narrow screen, beside it once the two columns sit side by side. */}
            <div
              role="group"
              aria-labelledby="week-demand"
              className="flex flex-col gap-3 border-t border-border pt-5 sm:border-l sm:border-t-0 sm:pl-6 sm:pt-0"
            >
              <h2 id="week-demand" className={GROUP_LABEL}>需求</h2>
              <div className="flex flex-wrap gap-8">
                <Stat
                  label="申請中"
                  value={overview.demand.pending.total}
                  sub={pendingSub(overview.demand.pending, pendingAttention)}
                  tone={pendingAttention ? 'warning' : undefined}
                  href="/admin/week?status=pending"
                />
                <Stat label="候補" value={overview.demand.waiting.total} href="/admin/week?status=waiting" />
              </div>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted">尚未建立本週場次，車位資料待排定後顯示。</p>
        )}
      </section>

      {/* 下待辦 — attention items from the shared snapshot */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">待辦事項</h2>
          <div className="flex items-center gap-3 text-xs text-muted">
            <span>資料時間 {fmtTaipeiTime(snapshotAt)}</span>
            <button
              type="button"
              onClick={() => router.refresh()}
              className="rounded-lg border border-border px-3 py-1.5 font-medium text-ink transition-colors hover:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            >
              重新整理
            </button>
          </div>
        </div>

        {counts === null ? (
          <p className="rounded-lg border border-border bg-page px-4 py-3 text-sm text-muted">
            待辦資料暫時無法取得，請點「重新整理」再試。
          </p>
        ) : todos.length === 0 ? (
          <p className="rounded-lg border border-border bg-page px-4 py-6 text-center text-sm text-muted">
            目前沒有需要處理的事項 🎉
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {todos.map(t => (
              <TodoRow key={t.id} href={t.href} label={t.label} count={t.count} tone={t.tone} />
            ))}
          </div>
        )}

        <p className="text-xs text-muted">
          待辦數字為最近一次載入／重新整理的快照，處理後會自動更新；跨裝置或系統背景的變動請重新整理。
        </p>
      </section>
    </main>
  )
}
