'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import {
  memberMaintenanceMessage,
  type IdentityCandidate,
} from '@/lib/memberMaintenanceTypes'

// Add ONE member by hand (Tier 0-2 / 0038). Before this, adding a single member meant
// writing a one-row CSV and running the import.
//
// The interesting part is the homonym step. Two 王小明 may both genuinely attend, so the
// name key CANNOT be a unique index — it is a candidate detector, and the decision is a
// human one. The flow is therefore two-phase:
//
//   1. submit → the server answers `homonym_requires_confirmation` with the members who
//      already carry that name;
//   2. the operator looks at them and either opens one (this IS that person — go edit
//      them instead of creating a duplicate) or confirms they are different people.
//
// The confirmation sends the exact ids it was shown. If the roster moved in between, the
// server answers `homonym_confirmation_stale` and we re-render from the NEW list — never
// from the one already on screen. That is the whole point: "I confirm this is not A" must
// not silently mean "…and not B".
//
// Deliberately NOT here: a vehicle field. Plates are managed on the member's own page,
// where the active/retired distinction and the reactivate path are visible.

type Phase =
  | { kind: 'form' }
  | { kind: 'confirm'; candidates: IdentityCandidate[]; stale: boolean }
  | { kind: 'done'; userId: string; displayName: string }

const EVIDENCE_LABEL: Record<IdentityCandidate['evidence'], string> = {
  same_name: '同名',
  same_name_and_plate: '同名且車牌相同',
}

export default function AddMemberForm() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [displayName, setDisplayName] = useState('')
  const [phone, setPhone] = useState('')
  const [phase, setPhase] = useState<Phase>({ kind: 'form' })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function resetAll() {
    setDisplayName('')
    setPhone('')
    setPhase({ kind: 'form' })
    setError(null)
  }

  // confirmed === null → first attempt (the server decides whether to ask).
  // confirmed === string[] → "I have seen exactly these people and they are not this one".
  // The two are NOT interchangeable, all the way down to the RPC.
  async function submit(confirmed: string[] | null) {
    if (submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/members/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: displayName.trim(),
          phone: phone.trim(),
          ...(confirmed === null ? {} : { confirmedCandidateIds: confirmed }),
        }),
      })
      const data = await res.json().catch(() => null)

      if (res.ok && data?.ok) {
        setPhase({ kind: 'done', userId: data.userId, displayName: displayName.trim() })
        // The roster below is server-rendered; refresh so the new member appears there
        // too rather than only in this component's success line.
        router.refresh()
        return
      }

      const reason = typeof data?.reason === 'string' ? data.reason : ''
      if (reason === 'homonym_requires_confirmation' || reason === 'homonym_confirmation_stale') {
        setPhase({
          kind: 'confirm',
          candidates: (data.candidates ?? []) as IdentityCandidate[],
          stale: reason === 'homonym_confirmation_stale',
        })
        // A stale confirmation needs saying out loud — the operator already decided once,
        // and silently redrawing the list would look like their click did nothing.
        setError(reason === 'homonym_confirmation_stale' ? memberMaintenanceMessage(reason) : null)
        return
      }
      setError(reason === 'invalid_request' ? '請確認姓名與手機號碼格式。' : memberMaintenanceMessage(reason))
    } catch {
      setError('連線失敗，請再試一次。')
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => { resetAll(); setOpen(true) }}
        className="inline-flex min-h-11 items-center rounded-xl border border-border bg-surface px-4 text-sm font-semibold text-ink transition-colors hover:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
      >
        新增會友
      </button>
    )
  }

  return (
    <section className="rounded-xl border border-border bg-surface p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold">新增會友</h2>
        <button
          type="button"
          onClick={() => { resetAll(); setOpen(false) }}
          className="inline-flex min-h-11 items-center text-sm text-muted hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
        >
          關閉
        </button>
      </div>

      {phase.kind === 'done' ? (
        <div className="mt-3 flex flex-col gap-3">
          <p className="rounded-xl border border-primary/40 bg-success-bg px-4 py-3 text-sm text-primary-deep">
            已新增 {phase.displayName}。車輛與 P2 資格請到該會友的明細頁設定。
          </p>
          <div className="flex flex-wrap gap-3">
            <Link
              href={`/admin/members/${phase.userId}`}
              className="inline-flex min-h-11 items-center rounded-xl bg-primary px-5 text-sm font-semibold text-white transition-colors hover:bg-primary-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            >
              前往會友明細
            </Link>
            <button
              type="button"
              onClick={resetAll}
              className="inline-flex min-h-11 items-center rounded-xl border border-border px-4 text-sm text-ink transition-colors hover:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            >
              再新增一位
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-4">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted">姓名</span>
              <input
                type="text"
                value={displayName}
                maxLength={50}
                disabled={phase.kind === 'confirm'}
                onChange={e => setDisplayName(e.target.value)}
                className="w-48 rounded-lg border border-border bg-surface px-3 py-2 text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/30 disabled:opacity-60"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted">手機號碼</span>
              <input
                type="tel"
                inputMode="numeric"
                value={phone}
                maxLength={10}
                placeholder="09xxxxxxxx"
                disabled={phase.kind === 'confirm'}
                onChange={e => setPhone(e.target.value)}
                className="w-40 rounded-lg border border-border bg-surface px-3 py-2 font-mono text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/30 disabled:opacity-60"
              />
            </label>
          </div>

          {phase.kind === 'confirm' && (
            <div className="rounded-xl border border-warning-fg/30 bg-warning-bg px-4 py-3 text-sm text-warning-fg">
              <p className="font-semibold">名冊中已有同名會友</p>
              <p className="mt-1">
                若其中一位就是這個人，請直接開啟該筆資料修改，不要重複新增——重複的會友會各自持有一部分綁定、預約與資格紀錄，且系統沒有合併工具。
              </p>
              {/* The masked phone is the identifier here, not a name: every candidate
                  matched on the NAME, so repeating it back would tell the operator
                  nothing. Each row opens that member's page in a new tab so the
                  half-filled form and this decision survive the detour. */}
              <ul className="mt-2 flex flex-col gap-1">
                {phase.candidates.map(c => (
                  <li key={c.id} className="flex flex-wrap items-center gap-3">
                    <Link
                      href={`/admin/members/${c.id}`}
                      target="_blank"
                      rel="noopener"
                      className="font-semibold underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                    >
                      開啟這位會友
                    </Link>
                    <span className="font-mono">{c.phoneMasked}</span>
                    <span className="text-xs">{EVIDENCE_LABEL[c.evidence]}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {error && (
            <p className="rounded-lg border border-danger-fg/30 bg-danger-bg px-4 py-2 text-sm text-danger-fg">
              {error}
            </p>
          )}

          <div className="flex flex-wrap gap-3">
            {phase.kind === 'confirm' ? (
              <>
                <button
                  type="button"
                  onClick={() => submit(phase.candidates.map(c => c.id))}
                  disabled={submitting}
                  className="inline-flex min-h-11 items-center rounded-xl bg-primary px-5 text-sm font-semibold text-white transition-colors hover:bg-primary-strong disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                >
                  {submitting ? '新增中…' : '確認都是不同人，仍要新增'}
                </button>
                <button
                  type="button"
                  onClick={() => { setPhase({ kind: 'form' }); setError(null) }}
                  disabled={submitting}
                  className="inline-flex min-h-11 items-center rounded-xl border border-border px-4 text-sm text-ink transition-colors hover:border-primary disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                >
                  返回修改
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => submit(null)}
                disabled={submitting || displayName.trim() === '' || phone.trim() === ''}
                className="inline-flex min-h-11 items-center rounded-xl bg-primary px-5 text-sm font-semibold text-white transition-colors hover:bg-primary-strong disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
              >
                {submitting ? '新增中…' : '新增'}
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
