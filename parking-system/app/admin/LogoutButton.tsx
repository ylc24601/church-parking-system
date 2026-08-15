'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

// Per-device logout: deletes this device's session row and clears the cookie.
export default function LogoutButton() {
  const router = useRouter()
  const [submitting, setSubmitting] = useState(false)

  async function logout() {
    if (submitting) return
    setSubmitting(true)
    try {
      await fetch('/api/admin/logout', { method: 'POST' })
    } catch {
      // Even a failed request falls through to refresh — the server clears the
      // cookie on success; on network failure the user can simply retry.
    } finally {
      setSubmitting(false)
      router.refresh()
    }
  }

  return (
    <button
      type="button"
      onClick={logout}
      disabled={submitting}
      className="inline-flex min-h-11 items-center justify-center rounded-xl border border-border px-4 text-sm text-ink transition-colors hover:border-primary disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
    >
      登出
    </button>
  )
}
