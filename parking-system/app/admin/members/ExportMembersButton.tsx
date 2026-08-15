'use client'

import { useState } from 'react'
import { parseExportFilename } from '@/lib/csv'

// Superadmin-only roster export trigger (Wave 3 3d / #5B-a). Rendered by the page ONLY when the
// session has export_members (the real gate is the route). Two-step confirm (bulk-PII warning),
// then a POST — never a GET link, which prefetch could mis-fire. The blob download must set
// a.download itself: a blob: URL does not inherit the response's Content-Disposition filename.
export default function ExportMembersButton() {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function doExport() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/members/export', { method: 'POST' })
      // Must check res.ok BEFORE reading the body — a 403 returns JSON, which must never be
      // downloaded as a .csv.
      if (!res.ok) {
        setError(
          res.status === 403
            ? '你的權限可能已變更，請重新整理頁面後再試。'
            : '匯出失敗，請再試一次。',
        )
        return
      }
      const filename = parseExportFilename(res.headers.get('content-disposition'))
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      setConfirming(false)
    } catch {
      setError('連線失敗，請再試一次。')
    } finally {
      setBusy(false)
    }
  }

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => { setConfirming(true); setError(null) }}
        className="inline-flex min-h-11 shrink-0 items-center rounded-xl border border-border px-4 text-sm font-medium text-ink transition-colors hover:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
      >
        匯出 CSV
      </button>
    )
  }

  return (
    <div className="flex max-w-md flex-col gap-2 rounded-xl border border-warning-fg/30 bg-warning-bg p-4 text-sm text-warning-fg">
      <p>
        將下載<strong>全體會友的姓名與完整電話</strong>等個資，僅供行政聯絡使用。
        下載後檔案即離開系統存取控制，請妥善保管、切勿上傳公開雲端或群組。確定匯出？
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={doExport}
          disabled={busy}
          className="inline-flex min-h-11 items-center rounded-xl bg-primary px-5 text-sm font-semibold text-white transition-colors hover:bg-primary-strong disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
        >
          {busy ? '匯出中…' : '確認匯出'}
        </button>
        <button
          type="button"
          onClick={() => { setConfirming(false); setError(null) }}
          disabled={busy}
          className="inline-flex min-h-11 items-center rounded-xl border border-border bg-surface px-4 text-sm text-ink transition-colors hover:border-primary disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
        >
          取消
        </button>
      </div>
      {error && <p className="text-danger-fg">{error}</p>}
    </div>
  )
}
