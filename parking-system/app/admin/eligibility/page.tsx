import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { p2ReasonLabel } from '@/lib/p2Reason'
import { getAdminSession } from '@/server/http/adminAuth'
import {
  listEligibilityReview,
  type EligibilityReviewItem,
  type ReviewListStatus,
} from '@/server/services/eligibilityReviewService'
import DataMinimizationNotice from '../DataMinimizationNotice'

export const metadata: Metadata = {
  title: '資格審查 · 管理後台',
}

// Read-only P2 eligibility review. Rows carry names + P2 reasons (health-adjacent
// sensitive info), so gate on the session and never cache. No phone / dependent names
// reach this page — identify by name and open the detail page for the rest.
export const dynamic = 'force-dynamic'
export const revalidate = 0


const SECTIONS: { status: ReviewListStatus; title: string; hint: string }[] = [
  { status: 'expired', title: '已過期', hint: '資格已失效，目前套用中會掉回 P3——需重新核定或更新' },
  { status: 'review_due', title: '待覆核', hint: '覆核日已到（含匯入時缺日期者）' },
  { status: 'upcoming', title: '60 天內到期或需覆核', hint: '尚未過期，但覆核／到期日將在 60 天內' },
]

export default async function AdminEligibilityPage() {
  if (!(await getAdminSession())) redirect('/admin')

  const { items, hasMore, counts } = await listEligibilityReview()

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col gap-6 bg-page px-6 py-10 text-ink">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">P2 資格審查</h1>
        <p className="mt-1 text-sm text-muted">
          {hasMore ? '目前顯示（最急迫前 500 筆）：' : ''}
          已過期 {counts.expired} · 待覆核 {counts.review_due} · 60 天內 {counts.upcoming}
        </p>
      </header>

      {/* Stated before the reasons below are visible (#12). */}
      <DataMinimizationNotice />

      {hasMore && (
        <p className="rounded-xl border border-warning-fg/30 bg-warning-bg px-4 py-3 text-sm text-warning-fg">
          結果超過 500 筆；以下計數與清單僅包含最急迫的前 500 筆。
        </p>
      )}

      {items.length === 0 ? (
        <p className="rounded-xl border border-border bg-surface px-6 py-12 text-center text-muted">
          目前沒有需要處理的資格
        </p>
      ) : (
        SECTIONS.map(section => {
          const rows = items.filter(i => i.status === section.status)
          if (rows.length === 0) return null
          return (
            <section key={section.status} className="flex flex-col gap-2">
              <div>
                <h2 className="text-lg font-semibold text-ink">{section.title}（{rows.length}）</h2>
                <p className="text-xs text-muted">{section.hint}</p>
              </div>
              <div className="w-full overflow-x-auto rounded-xl border border-border">
                <table className="w-full min-w-[640px] text-left text-sm">
                  <thead className="bg-surface text-muted">
                    <tr>
                      <th className="px-4 py-3 font-normal">姓名</th>
                      <th className="px-4 py-3 font-normal">事由</th>
                      <th className="whitespace-nowrap px-4 py-3 font-normal">有效至</th>
                      <th className="whitespace-nowrap px-4 py-3 font-normal">覆核日</th>
                      <th className="whitespace-nowrap px-4 py-3 font-normal">最近覆核</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {rows.map(row => (
                      <Row key={row.userId} row={row} />
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )
        })
      )}
    </main>
  )
}

function Row({ row }: { row: EligibilityReviewItem }) {
  return (
    <tr className="bg-surface">
      <td className="px-4 py-3">
        <Link href={`/admin/members/${row.userId}`} className="font-medium text-primary hover:underline">
          {row.displayName}
        </Link>
      </td>
      <td className="px-4 py-3 text-ink">{p2ReasonLabel(row.reason)}</td>
      <td className="whitespace-nowrap px-4 py-3 text-muted">{row.validUntil ?? '—'}</td>
      <td className="whitespace-nowrap px-4 py-3 text-muted">{row.reviewDate ?? '—'}</td>
      <td className="whitespace-nowrap px-4 py-3 text-muted">{row.reviewedAt ? row.reviewedAt.slice(0, 10) : '—'}</td>
    </tr>
  )
}
