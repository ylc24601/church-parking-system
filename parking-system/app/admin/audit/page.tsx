import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { can } from '@/lib/adminRoles'
import { getAdminSession } from '@/server/http/adminAuth'
import { AUDIT_BOUNDARY_NOTE } from '@/server/services/auditPresentation'
import { idSuffix, listAuditTimeline } from '@/server/services/auditViewService'
import Badge, { type BadgeTone } from '../../ui/Badge'
import NoPermission from '../NoPermission'

export const metadata: Metadata = {
  title: '稽核記錄 · 管理後台',
}

// Live governance data behind a session — never cached or prerendered, same posture
// as the other admin pages that render account-identifying rows.
export const dynamic = 'force-dynamic'
export const revalidate = 0

const RESULT: Record<string, { label: string; tone: BadgeTone }> = {
  success: { label: '已完成', tone: 'success' },
  denied: { label: '已拒絕', tone: 'danger' },
  conflict: { label: '衝突', tone: 'warning' },
}

export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const session = await getAdminSession()
  if (!session) redirect('/admin')
  // Before the timeline is read: the log records every operator's governance actions,
  // so a clerk must not be able to pull a page of it at all.
  if (!can(session.role, 'view_audit')) return <NoPermission />

  const raw = (await searchParams).cursor
  // A malformed/stale cursor is not an error: the service falls back to the newest
  // page rather than throwing, so a garbled link still shows the timeline.
  const cursor = typeof raw === 'string' ? raw : undefined
  const { items, nextCursor } = await listAuditTimeline({ cursor })

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col gap-6 bg-page px-6 py-10 text-ink">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">稽核記錄</h1>
      </header>

      <p className="rounded-xl border border-border bg-surface px-4 py-3 text-sm text-muted">
        {AUDIT_BOUNDARY_NOTE}
      </p>

      {items.length === 0 ? (
        <p className="rounded-xl border border-border bg-surface px-6 py-12 text-center text-muted">
          目前沒有紀錄。
        </p>
      ) : (
        <>
          <div className="w-full overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[880px] text-left text-sm">
              <thead className="bg-surface text-muted">
                <tr>
                  <th className="whitespace-nowrap px-4 py-3 font-normal">時間</th>
                  <th className="whitespace-nowrap px-4 py-3 font-normal">操作者</th>
                  <th className="whitespace-nowrap px-4 py-3 font-normal">動作</th>
                  <th className="whitespace-nowrap px-4 py-3 font-normal">對象</th>
                  <th className="whitespace-nowrap px-4 py-3 font-normal">結果</th>
                  <th className="px-4 py-3 font-normal">細節</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {items.map(item => {
                  const result = RESULT[item.result] ?? { label: item.result, tone: 'neutral' as BadgeTone }
                  return (
                    <tr key={item.id} className="bg-surface">
                      <td className="whitespace-nowrap px-4 py-3 text-muted">{item.occurredAt}</td>
                      <td className="px-4 py-3 text-ink">{item.actorLabel}</td>
                      <td className="px-4 py-3 text-ink">
                        {item.actionLabel}
                        {/* An action with no label still shows its raw code — hiding the
                            row would read as "it never happened". */}
                        {item.actionLabel === item.actionCode && (
                          <span className="ml-1 font-mono text-xs text-muted">（未知動作）</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-ink">{item.entityLabel}</td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <Badge tone={result.tone}>{result.label}</Badge>
                      </td>
                      <td className="px-4 py-3 text-muted">
                        <div className="flex flex-col gap-1">
                          {item.detailFallback !== null ? (
                            <span>{item.detailFallback}</span>
                          ) : (
                            item.details.map(d => (
                              <span key={d.label}>
                                {d.label}：{d.value}
                              </span>
                            ))
                          )}
                          {item.unsupportedDetailCount > 0 && (
                            <span className="text-xs">另有 {item.unsupportedDetailCount} 項未顯示</span>
                          )}
                          <span className="font-mono text-xs" title={item.requestId}>
                            操作編號：尾碼 {idSuffix(item.requestId)}
                          </span>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Forward-only: a timeline needs 不漏/不重, not page numbers. The cursor
              is exclusive, so an insert while reading cannot shift this boundary. */}
          <nav className="flex items-center justify-between gap-3" aria-label="稽核記錄分頁">
            <Link
              href="/admin/audit"
              className="inline-flex min-h-11 items-center rounded-xl border border-border px-4 text-sm text-ink transition-colors hover:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            >
              回到最新
            </Link>
            {nextCursor ? (
              <Link
                href={{ pathname: '/admin/audit', query: { cursor: nextCursor } }}
                className="inline-flex min-h-11 items-center rounded-xl border border-border px-4 text-sm text-ink transition-colors hover:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
              >
                較舊紀錄 →
              </Link>
            ) : (
              <span className="text-sm text-muted">已到最舊的紀錄</span>
            )}
          </nav>
        </>
      )}
    </main>
  )
}
