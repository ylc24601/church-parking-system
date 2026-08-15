'use client'

import { useState } from 'react'
import type { MemberSearchItem } from '@/lib/memberAdminTypes'
import MemberTable from './MemberTable'

// Admin member search. Results show a MASKED phone; the full number is only on the
// session-gated detail page. The query is POSTed (never a URL/query string).
// The result table itself is shared with the roster browse (MemberTable) so the two
// lists can't drift; the search-specific states (idle / loading / error / no results /
// hasMore) stay here.
// Renders a <section>: the page owns the <main> and the heading, since the roster browse
// is a second section of the same page.

export default function MemberSearch() {
  const [query, setQuery] = useState('')
  // The shared DTO, not a local copy: a structurally-identical duplicate is exactly the drift
  // MemberTable exists to prevent.
  const [items, setItems] = useState<MemberSearchItem[] | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = query.trim()
    if (trimmed.length === 0 || loading) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/members/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: trimmed }),
      })
      const data = await res.json().catch(() => null)
      if (res.ok && data?.ok) {
        setItems(data.items as MemberSearchItem[])
        setHasMore(Boolean(data.hasMore))
      } else {
        setItems(null)
        setError(res.status === 400 ? '請輸入 1–50 字的關鍵字' : '查詢失敗，請再試一次')
      }
    } catch {
      setItems(null)
      setError('連線失敗，請再試一次')
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <form onSubmit={submit} className="flex gap-3">
        <input
          type="text"
          value={query}
          onChange={e => { setQuery(e.target.value); setError(null) }}
          placeholder="姓名 / 電話 / 車牌"
          maxLength={50}
          autoComplete="off"
          className="flex-1 rounded-xl border border-border bg-surface px-4 py-3 text-base text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/30"
        />
        <button
          type="submit"
          disabled={loading || query.trim().length === 0}
          className="inline-flex min-h-11 items-center rounded-xl bg-primary px-6 text-base font-semibold text-white transition-colors active:bg-primary-strong disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
        >
          {loading ? '查詢中…' : '查詢'}
        </button>
      </form>

      {error && (
        <p className="rounded-xl border border-danger-fg/30 bg-danger-bg px-4 py-3 text-sm text-danger-fg">{error}</p>
      )}

      {items !== null && (
        items.length === 0 ? (
          <p className="rounded-xl border border-border bg-surface px-6 py-12 text-center text-muted">
            查無符合的會友
          </p>
        ) : (
          <>
            {hasMore && (
              <p className="rounded-xl border border-warning-fg/30 bg-warning-bg px-4 py-3 text-sm text-warning-fg">
                結果過多，僅顯示前 {items.length} 筆——請縮小關鍵字。
              </p>
            )}
            <MemberTable items={items} />
          </>
        )
      )}
    </section>
  )
}
