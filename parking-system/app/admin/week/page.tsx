import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { fmtTaipeiDateTime } from '@/lib/taipeiDate'
import type { WeekApplicationRow, WeekWaitingRow } from '@/lib/weekApplications'
import { getAdminSession } from '@/server/http/adminAuth'
import { getWeekApplications } from '@/server/services/weekApplicationsService'
import Badge, { type BadgeTone } from '../../ui/Badge'
import { isPriorityBand, matchesBand, parseWeekFilters } from './parseWeekFilters'

export const metadata: Metadata = {
  title: '本週申請清單 · 管理後台',
}

// Named-row PII (display name + plate) — same posture as members/[id] and #5A's roster:
// force-dynamic, no-store, never prerendered/cached.
export const dynamic = 'force-dynamic'
export const revalidate = 0

// #35 — no capability gate (使用者 2026-07-30 定): a clerk can already open the full
// roster (/admin/members) and the full plate list (/admin/print), so this page is not a
// new disclosure tier. Session-only, matching those two pages.

const STATUS_LABEL: Record<WeekApplicationRow['status'], string> = {
  pending: '申請中',
  waiting: '候補中',
}
const STATUS_TONE: Record<WeekApplicationRow['status'], BadgeTone> = {
  pending: 'warning',
  waiting: 'info',
}

function priorityCell(row: WeekApplicationRow) {
  return isPriorityBand(row.effective_priority)
    ? <Badge tone="priority" variant="outline">優先</Badge>
    : <span className="text-sm text-muted">一般</span>
}

const TH = 'px-4 py-3 font-medium'
const TD = 'px-4 py-3'

function Row({ row, rank }: { row: WeekApplicationRow; rank?: number }) {
  return (
    <tr className="border-b border-border last:border-0">
      <td className={`${TD} font-medium text-ink`}>{row.display_name}</td>
      <td className={`${TD} tabular-nums text-ink`}>{row.license_plate}</td>
      <td className={TD}><Badge tone={STATUS_TONE[row.status]}>{STATUS_LABEL[row.status]}</Badge></td>
      <td className={TD}>{priorityCell(row)}</td>
      <td className={`${TD} text-muted`}>{fmtTaipeiDateTime(row.applied_at)}</td>
      {rank !== undefined && <td className={`${TD} tabular-nums text-ink`}>第 {rank} 位</td>}
    </tr>
  )
}

function Table({ children, showRank }: { children: React.ReactNode; showRank: boolean }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-surface">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead>
          <tr className="border-b border-border text-xs text-muted">
            <th className={TH}>姓名</th>
            <th className={TH}>車牌</th>
            <th className={TH}>狀態</th>
            <th className={TH}>優先·一般</th>
            <th className={TH}>申請時間</th>
            {showRank && <th className={TH}>候補序位</th>}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return <p className="rounded-xl border border-border bg-surface px-6 py-8 text-center text-muted">{text}</p>
}

export default async function AdminWeekPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  if (!(await getAdminSession())) redirect('/admin')

  const sp = await searchParams
  const { showPending, showWaiting, band } = parseWeekFilters({ status: sp.status, priority: sp.priority })

  const { sunday, pending, waiting } = await getWeekApplications()
  // Filtering happens HERE, after the service assigned waitingRank over the complete
  // waiting set — so a ?priority= view shows the members' real positions (…, 4, 7, …)
  // rather than renumbering the subset from 1.
  const shownPending = pending.filter(r => matchesBand(r.effective_priority, band))
  const shownWaiting: WeekWaitingRow[] = waiting.filter(r => matchesBand(r.effective_priority, band))

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col gap-6 bg-page px-6 py-10 text-ink">
      <header>
        <Link href="/admin" className="inline-flex min-h-11 items-center text-sm text-muted hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2">← 本週概覽</Link>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">本週申請清單</h1>
        <p className="mt-1 text-sm text-muted">主日 {sunday}</p>
      </header>

      {showPending && (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">申請中（{shownPending.length}）</h2>
          <p className="text-xs text-muted">依申請時間排序；實際候補／分配順序於週五分配時產生，此處僅供除錯參考。</p>
          {shownPending.length === 0 ? (
            <Empty text="目前沒有申請中的紀錄。" />
          ) : (
            <Table showRank={false}>
              {shownPending.map(r => <Row key={r.id} row={r} />)}
            </Table>
          )}
        </section>
      )}

      {showWaiting && (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">候補（{shownWaiting.length}）</h2>
          <p className="text-xs text-muted">候補序位即會友在 LINE 與會員頁看到的「候補第 N 位」，依實際遞補順序排列。</p>
          {shownWaiting.length === 0 ? (
            <Empty text="目前沒有候補中的紀錄。" />
          ) : (
            <Table showRank>
              {shownWaiting.map(r => <Row key={r.id} row={r} rank={r.waitingRank} />)}
            </Table>
          )}
        </section>
      )}
    </main>
  )
}
