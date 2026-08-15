import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { can } from '@/lib/adminRoles'
import { getAdminSession } from '@/server/http/adminAuth'
import { listMembersPage } from '@/server/services/memberAdminService'
import AddMemberForm from './AddMemberForm'
import ExportMembersButton from './ExportMembersButton'
import MemberSearch from './MemberSearch'
import MemberTable from './MemberTable'
import { parsePage } from './parsePage'

export const metadata: Metadata = {
  title: '會友管理 · 管理後台',
}

// The roster below renders masked PII (name / masked phone / plate summary) for every member, so
// this page must never be cached or prerendered — same posture as /admin/eligibility and
// /admin/members/[id]. The search stays a client POST so its query never lands in a URL or access
// log; the roster has no query at all — only ?page=N — so nothing identifying reaches the URL.
export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function AdminMembersPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const session = await getAdminSession()
  if (!session) redirect('/admin')

  const requestedPage = parsePage((await searchParams).page)
  const { items, page, totalPages, total } = await listMembersPage({ page: requestedPage })

  // A stale or hand-typed ?page=999 would otherwise render an empty table over a non-empty
  // roster, which reads as "the members are gone". Send it to the real last page instead.
  if (total > 0 && page > totalPages) redirect(`/admin/members?page=${totalPages}`)

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col gap-6 bg-page px-6 py-10 text-ink">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">會友管理</h1>
        {/* Bulk-PII roster export — superadmin only (#5B-a). Hiding it is UX; the route gates. */}
        {can(session.role, 'export_members') && <ExportMembersButton />}
      </header>

      <MemberSearch />

      {/* Tier 0-2 (0038) — add ONE member without writing a one-row CSV. Collapsed by
          default: the roster is what this page is for, and the CSV import is still the
          right tool for a batch. */}
      <AddMemberForm />

      <section className="flex flex-col gap-3">
        <header className="flex items-baseline justify-between gap-3">
          <h2 className="text-lg font-semibold">全體名冊</h2>
          <p className="text-sm text-muted">共 {total} 位</p>
        </header>

        {total === 0 ? (
          <p className="rounded-xl border border-border bg-surface px-6 py-12 text-center text-muted">
            尚無會友資料——可至「名單匯入」匯入名冊。
          </p>
        ) : (
          <>
            <MemberTable items={items} />
            <nav className="flex items-center justify-between gap-3" aria-label="名冊分頁">
              {page > 1 ? (
                <Link
                  href={{ pathname: '/admin/members', query: { page: page - 1 } }}
                  className="inline-flex min-h-11 items-center rounded-lg border border-border bg-surface px-4 text-sm text-ink transition-colors hover:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                >
                  ‹ 上一頁
                </Link>
              ) : (
                <span />
              )}
              <p className="text-sm text-muted">第 {page}／{totalPages} 頁</p>
              {page < totalPages ? (
                <Link
                  href={{ pathname: '/admin/members', query: { page: page + 1 } }}
                  className="inline-flex min-h-11 items-center rounded-lg border border-border bg-surface px-4 text-sm text-ink transition-colors hover:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                >
                  下一頁 ›
                </Link>
              ) : (
                <span />
              )}
            </nav>
          </>
        )}
      </section>
    </main>
  )
}
