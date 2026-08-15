import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { taipeiToday } from '@/lib/taipeiDate'
import { ageInYears, childCompanionValidUntil, deriveEligibilityStatus, type EligibilityStatus } from '@/lib/eligibilityStatus'
import { p2ReasonLabel } from '@/lib/p2Reason'
import { ROLE_LABEL } from '@/lib/memberAdminTypes'
import { getAdminSession } from '@/server/http/adminAuth'
import { getMemberDetail, type MemberDetail } from '@/server/services/memberAdminService'
import Badge, { type BadgeTone } from '../../../ui/Badge'
import DataMinimizationNotice from '../../DataMinimizationNotice'
import EligibilityForm from './EligibilityForm'
import IssueBindingCode from './IssueBindingCode'
import MemberIdentityForm from './MemberIdentityForm'
import MemberVehicles from './MemberVehicles'

export const metadata: Metadata = {
  title: '會友明細 · 管理後台',
}

// This page renders complete PII (full phone, eligibility reasons, dependent names +
// birthdates). Force it dynamic + uncacheable so none of it is ever stored in a
// prerender / route cache.
export const dynamic = 'force-dynamic'
export const revalidate = 0

const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const DEP_KIND_LABEL: Record<string, string> = { impaired: '身障', child: '幼兒', elder: '長者' }

export default async function AdminMemberDetailPage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await getAdminSession())) redirect('/admin')

  const { id } = await params
  // Validate BEFORE any DB call — a malformed id must not reach the repository.
  const detail = UUID_FORMAT.test(id) ? await getMemberDetail(id) : null

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col gap-6 bg-page px-6 py-10 text-ink">
      <header>
        <Link href="/admin/members" className="inline-flex min-h-11 items-center text-sm text-muted hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2">← 會友管理</Link>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">會友明細</h1>
      </header>

      {detail === null ? (
        <p className="rounded-xl border border-border bg-surface px-6 py-12 text-center text-muted">
          查無此會友
        </p>
      ) : (
        <>
          {/* Stated before the reasons / dependents below become visible (#12). */}
          <DataMinimizationNotice />
          <DetailBody id={id} detail={detail} />
        </>
      )}
    </main>
  )
}

function DetailBody({ id, detail }: { id: string; detail: MemberDetail }) {
  // Shared across both the P2 badge and the dependent ages below: "what is true today",
  // not any event's Sunday (see lib/eligibilityStatus.ts header).
  const asOf = taipeiToday(new Date())
  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-xl border border-border bg-surface p-6">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-xl font-semibold">{detail.displayName}</h2>
          <Badge variant="outline" tone="neutral">{ROLE_LABEL[detail.role] ?? detail.role}</Badge>
          {detail.bound ? (
            <Badge variant="outline" tone="success">已綁定 LINE</Badge>
          ) : (
            <Badge variant="outline" tone="neutral">未綁定</Badge>
          )}
        </div>
        <dl className="mt-4 grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
          <Row label="電話">{detail.phone ?? '—'}</Row>
        </dl>
        {/* Tier 0-2 (0038). The member is edited BY ID — the phone is an attribute here,
            never the key it used to be in the CSV path. */}
        <MemberIdentityForm userId={id} displayName={detail.displayName} phone={detail.phone} />
      </section>

      <section className="rounded-xl border border-border bg-surface p-6">
        <h3 className="text-lg font-semibold">車輛</h3>
        <MemberVehicles userId={id} vehicles={detail.vehicles} />
      </section>

      <section className="rounded-xl border border-border bg-surface p-6">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="text-lg font-semibold">P2 資格</h3>
          {detail.eligibility !== null && detail.eligibility.p2Eligible && (
            <EligibilityBadge
              status={deriveEligibilityStatus(
                {
                  validUntil: detail.eligibility.p2ValidUntil,
                  reviewDate: detail.eligibility.p2ReviewDate,
                  validFrom: detail.eligibility.p2ValidFrom,
                },
                // as-of = today: this badge answers "what is this member's eligibility
                // state now", not "are they P2 for some Sunday" — the allocator asks that
                // one against the event's own date.
                asOf,
              )}
              validUntil={detail.eligibility.p2ValidUntil}
            />
          )}
        </div>
        {detail.eligibility === null || !detail.eligibility.p2Eligible ? (
          <p className="mt-2 text-sm text-muted">無 P2 資格</p>
        ) : (
          <dl className="mt-3 grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
            <Row label="事由">{p2ReasonLabel(detail.eligibility.p2Reason)}</Row>
            <Row label="有效至">{detail.eligibility.p2ValidUntil ?? '—'}</Row>
            <Row label="覆核日">{detail.eligibility.p2ReviewDate ?? '—'}</Row>
            <Row label="最近覆核">{detail.eligibility.reviewedAt ? detail.eligibility.reviewedAt.slice(0, 10) : '—'}</Row>
          </dl>
        )}
        {detail.dependents.length > 0 && (
          <div className="mt-4">
            <h4 className="text-sm text-muted">眷屬</h4>
            <ul className="mt-1 space-y-0.5 text-sm">
              {detail.dependents.map((d, i) => (
                <li key={i}>
                  <span className="text-muted">{DEP_KIND_LABEL[d.kind] ?? d.kind}</span>
                  <span className="ml-2">{d.name}</span>
                  {d.birthdate ? (
                    <>
                      <span className="ml-2 text-muted">{d.birthdate}</span>
                      <span className="ml-2 text-muted">{ageInYears(d.birthdate, asOf)} 歲</span>
                      {d.kind === 'child' && (
                        <Badge
                          variant="outline"
                          tone="neutral"
                          className="ml-2"
                        >
                          {asOf <= childCompanionValidUntil(d.birthdate) ? '學齡前' : '已入學'}
                        </Badge>
                      )}
                    </>
                  ) : (
                    <span className="ml-2 text-muted">生日未填</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* The write path (#10). Rendered even when there is NO eligibility row: a general
            member is exactly that — a users row with no eligibility — and granting them P2 is
            the whole point of this slice. */}
        <EligibilityForm
          userId={id}
          reviewStatus={detail.eligibility?.reviewStatus ?? null}
          reason={detail.eligibility?.p2Reason ?? null}
          validFrom={detail.eligibility?.p2ValidFrom ?? null}
          validUntil={detail.eligibility?.p2ValidUntil ?? null}
          reviewDate={detail.eligibility?.p2ReviewDate ?? null}
          childBirthdate={detail.eligibility?.p2ChildBirthdate ?? null}
          note={detail.eligibility?.reviewNote ?? null}
          reviewedAt={detail.eligibility?.reviewedAt ?? null}
          reviewVersion={detail.eligibility?.reviewVersion ?? 0}
        />
      </section>

      <section className="rounded-xl border border-border bg-surface p-6">
        <h3 className="text-lg font-semibold">綁定碼（fallback 綁定）</h3>
        <IssueBindingCode userId={id} bound={detail.bound} />
      </section>
    </div>
  )
}

// Makes an EXPIRED-but-still-p2_eligible qualification unmistakable — otherwise the
// section reads as "has P2" while apply-time priority silently drops the member to P3.
function EligibilityBadge({ status, validUntil }: { status: EligibilityStatus; validUntil: string | null }) {
  const meta: Record<EligibilityStatus, { label: string; tone: BadgeTone }> = {
    active: { label: '有效', tone: 'success' },
    expired: { label: validUntil ? `已過期（${validUntil}）` : '已過期', tone: 'danger' },
    review_due: { label: '待覆核', tone: 'warning' },
    permanent: { label: '永久', tone: 'neutral' },
    // Approved, but the window hasn't opened — so the member is P3 today and P2 later.
    // Unreachable until 2B-2b writes p2_valid_from; the Record is total so that slice
    // cannot ship the state without choosing its copy.
    not_yet_effective: { label: '尚未生效', tone: 'neutral' },
  }
  const { label, tone } = meta[status]
  return <Badge variant="outline" tone={tone}>{label}</Badge>
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-20 shrink-0 text-muted">{label}</dt>
      <dd className="text-ink">{children}</dd>
    </div>
  )
}
