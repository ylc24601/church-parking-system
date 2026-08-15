'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import BindingClaimForm from './BindingClaimForm'

// Member login gate. liff mode: init the LIFF SDK, obtain the ID token, and hand it
// to the server for verification (the client never learns or sends a LINE userId —
// identity claims are server-verified only). mock mode: a dev-only form that posts a
// fake LINE userId; the server refuses mock mode in production.
//
// Distinct terminal states (review requirement): not_bound / invalid_token /
// unreachable / error render different guidance, not one generic failure.
type GateState =
  | 'connecting'    // liff.init / token exchange in flight
  | 'not_bound'     // verified, but no member has this LINE account bound yet
  | 'invalid_token' // LINE rejected the ID token (stale LIFF login)
  | 'unreachable'   // LINE verify endpoint unreachable — retryable
  | 'error'         // LIFF init failed / unexpected

export default function MemberLiffGate({
  mode,
  liffId,
}: {
  mode: 'liff' | 'mock'
  liffId: string | null
}) {
  const router = useRouter()
  const [state, setState] = useState<GateState>('connecting')
  const [mockId, setMockId] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const submitLogin = useCallback(
    async (payload: { idToken?: string; mockLineUserId?: string }) => {
      const res = await fetch('/api/member/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (res.ok) {
        const body = (await res.json()) as { ok: boolean; reason?: string }
        if (body.ok) {
          router.refresh()
          return
        }
        setState(body.reason === 'not_bound' ? 'not_bound' : 'error')
        return
      }
      setState(res.status === 401 ? 'invalid_token' : res.status === 503 ? 'unreachable' : 'error')
    },
    [router],
  )

  useEffect(() => {
    if (mode !== 'liff') return
    let cancelled = false
    async function run() {
      try {
        const liff = (await import('@line/liff')).default
        await liff.init({ liffId: liffId ?? '' })
        if (!liff.isLoggedIn()) {
          liff.login() // redirects; nothing to await
          return
        }
        const idToken = liff.getIDToken()
        if (cancelled) return
        if (!idToken) {
          setState('invalid_token')
          return
        }
        await submitLogin({ idToken })
      } catch {
        if (!cancelled) setState('error')
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [mode, liffId, submitLogin])

  async function submitMock(e: React.FormEvent) {
    e.preventDefault()
    if (mockId.trim() === '' || submitting) return
    setSubmitting(true)
    try {
      await submitLogin({ mockLineUserId: mockId.trim() })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-6 bg-page px-6 py-10 text-ink">
      <div className="flex flex-col items-center text-center">
        <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-brand text-2xl" aria-hidden>
          ⛪
        </span>
        <h1 className="text-2xl font-bold tracking-tight">教會停車 · 會友專區</h1>
      </div>

      {state === 'not_bound' ? (
        // Verified LINE identity, but no member bound yet → self-serve claim form
        // (Slice 2). The keyword `綁定 <code>` flow remains the operator-assisted fallback.
        <BindingClaimForm mode={mode} mockLineUserId={mockId.trim() || undefined} />
      ) : mode === 'mock' ? (
        <form onSubmit={submitMock} className="w-full space-y-3">
          <p className="text-center text-sm font-medium text-warning-fg">開發模式（mock）</p>
          <input
            value={mockId}
            onChange={e => setMockId(e.target.value)}
            placeholder="mock LINE userId（如 U_member_01）"
            className="h-12 w-full rounded-xl border border-border bg-surface px-4 text-base text-ink placeholder:text-muted/70 outline-none focus:border-primary focus:ring-2 focus:ring-primary/30"
          />
          <button
            type="submit"
            disabled={submitting || mockId.trim() === ''}
            className="h-12 w-full rounded-2xl bg-primary text-base font-semibold text-white transition-colors active:bg-primary-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:opacity-50"
          >
            登入
          </button>
          {state !== 'connecting' && <GateMessage state={state} />}
        </form>
      ) : (
        <GateMessage state={state} />
      )}
    </main>
  )
}

function GateMessage({ state }: { state: GateState }) {
  if (state === 'connecting') {
    return <p className="text-base text-muted">連線中，請稍候…</p>
  }
  if (state === 'invalid_token') {
    return (
      <div className="text-center">
        <p className="text-base font-medium text-danger-fg">登入已過期，請關閉此頁後重新開啟</p>
      </div>
    )
  }
  if (state === 'unreachable') {
    return (
      <div className="text-center">
        <p className="text-base font-medium text-danger-fg">連線驗證服務失敗</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-4 h-12 rounded-2xl border border-border bg-surface px-6 text-base text-ink transition-colors active:bg-border-subtle focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
        >
          再試一次
        </button>
      </div>
    )
  }
  return <p className="text-base font-medium text-danger-fg">發生錯誤，請稍後再試</p>
}
