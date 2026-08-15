'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

// Binding claim form (Phase 7 Slice 2), shown to a verified-but-unbound LINE account.
// Submits name + mobile phone; an admin approves the claim by matching the phone
// against member records — no auto-bind, and the response never reveals whether the
// phone matched (no membership oracle), so the success copy only promises review.
//
// liff mode: the ID token is fetched FRESH at each submit (never kept in state — the
// member may fill the form long after liff.init; a stale token would keep failing).
// mock mode: re-sends the mockLineUserId the login attempt used.
type FormState =
  | 'idle'
  | 'submitting'
  | 'submitted'      // claim recorded (first submit or an update)
  | 'relogin'        // account turned out bound → auto-login in flight
  | 'expired'        // LIFF ID token unavailable → needs a fresh page open
  | 'unreachable'    // verify endpoint down — retryable
  | 'error'

const NAME_MAX = 50

export default function BindingClaimForm({
  mode,
  mockLineUserId,
}: {
  mode: 'liff' | 'mock'
  mockLineUserId?: string
}) {
  const router = useRouter()
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [state, setState] = useState<FormState>('idle')
  const [fieldError, setFieldError] = useState<string | null>(null)

  const nameLength = Array.from(name.trim()).length
  const phoneDigits = phone.replace(/\D/g, '')
  const phoneValid = /^09\d{8}$/.test(phoneDigits)

  async function identityPayload(): Promise<{ idToken?: string; mockLineUserId?: string } | null> {
    if (mode === 'mock') return { mockLineUserId }
    const liff = (await import('@line/liff')).default
    const idToken = liff.getIDToken()
    return idToken ? { idToken } : null
  }

  // The account was bound while the member had the form open (admin just approved) —
  // log it straight in instead of showing a dead end.
  async function autoLogin() {
    setState('relogin')
    try {
      const payload = await identityPayload()
      if (!payload) {
        setState('expired')
        return
      }
      const res = await fetch('/api/member/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const bodyJson = (await res.json()) as { ok: boolean }
      if (res.ok && bodyJson.ok) {
        router.refresh()
        return
      }
      setState('error')
    } catch {
      setState('error')
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (state === 'submitting' || state === 'relogin') return  // double-click guard

    setFieldError(null)
    if (nameLength < 1 || nameLength > NAME_MAX) {
      setFieldError(`請填寫姓名（最多 ${NAME_MAX} 字）`)
      return
    }
    if (!phoneValid) {
      setFieldError('手機號碼格式須為 09 開頭共 10 碼')
      return
    }

    setState('submitting')
    try {
      const identity = await identityPayload()
      if (!identity) {
        setState('expired')
        return
      }
      const res = await fetch('/api/member/binding-claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...identity, name: name.trim(), phone: phoneDigits }),
      })
      if (res.ok) {
        const bodyJson = (await res.json()) as { ok: boolean; reason?: string }
        if (bodyJson.ok) {
          setState('submitted')
          return
        }
        if (bodyJson.reason === 'line_account_already_bound') {
          await autoLogin()
          return
        }
        setState('error')
        return
      }
      if (res.status === 401) setState('expired')
      else if (res.status === 503) setState('unreachable')
      else if (res.status === 400) {
        setState('idle')
        setFieldError('資料格式有誤，請檢查姓名與手機號碼')
      } else setState('error')
    } catch {
      setState('error')
    }
  }

  if (state === 'submitted') {
    return (
      <div className="w-full rounded-2xl border border-success-fg/30 bg-success-bg p-6 text-center">
        <p className="text-lg font-semibold text-success-fg">已送出綁定申請</p>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          同工核准後即可使用會友專區。若資料填錯，重新送出一次即會更新申請內容。
        </p>
        <button
          type="button"
          onClick={() => setState('idle')}
          className="mt-5 h-12 rounded-2xl border border-border bg-surface px-6 text-base text-ink transition-colors active:bg-border-subtle focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
        >
          修改重送
        </button>
      </div>
    )
  }

  if (state === 'relogin') {
    return <p className="text-base text-muted">此帳號已完成綁定，正在為您登入…</p>
  }
  if (state === 'expired') {
    return <p className="text-base font-medium text-danger-fg">登入已過期，請關閉此頁後重新開啟</p>
  }

  return (
    <form onSubmit={submit} className="w-full space-y-4">
      <div className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
        <p className="text-lg font-semibold">申請綁定會友專區</p>
        <p className="mt-1 text-sm leading-relaxed text-muted">
          請填寫您在教會登記的姓名與手機，送出後由同工核對並核准。
        </p>

        <label className="mt-4 block text-sm text-muted" htmlFor="claim-name">姓名</label>
        <input
          id="claim-name"
          value={name}
          onChange={e => setName(e.target.value)}
          maxLength={NAME_MAX}
          autoComplete="name"
          className="mt-1 h-12 w-full rounded-xl border border-border bg-surface px-4 text-base text-ink placeholder:text-muted/70 outline-none focus:border-primary focus:ring-2 focus:ring-primary/30"
        />

        <label className="mt-3 block text-sm text-muted" htmlFor="claim-phone">手機號碼</label>
        <input
          id="claim-phone"
          value={phone}
          onChange={e => setPhone(e.target.value)}
          inputMode="tel"
          autoComplete="tel"
          placeholder="09xxxxxxxx"
          maxLength={20}
          className="mt-1 h-12 w-full rounded-xl border border-border bg-surface px-4 text-base text-ink placeholder:text-muted/70 outline-none focus:border-primary focus:ring-2 focus:ring-primary/30"
        />
        {phone !== '' && !phoneValid && (
          <p className="mt-1 text-xs text-warning-fg">格式：09 開頭共 10 碼</p>
        )}
      </div>

      <p className="h-5 text-center text-sm text-danger-fg" role="alert">
        {fieldError ?? (state === 'unreachable' ? '連線驗證服務失敗，請再試一次' : state === 'error' ? '發生錯誤，請稍後再試' : '')}
      </p>

      <button
        type="submit"
        disabled={state === 'submitting'}
        className="h-12 w-full rounded-2xl bg-primary text-base font-semibold text-white transition-colors active:bg-primary-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:opacity-50"
      >
        {state === 'submitting' ? '送出中…' : '送出申請'}
      </button>
    </form>
  )
}
