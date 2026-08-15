import Link from 'next/link'

// Shown to a signed-in admin who reached a surface their role does not cover
// (Wave 2C-1 / #19). Rendered rather than redirected: a silent bounce to /admin reads
// as a broken link, and the operator needs to know the page exists but is not theirs.
//
// Next's forbidden() would be the idiomatic answer, but it is experimental and requires
// next.config's experimental.authInterrupts — not worth an experimental flag for a
// server-rendered notice (see node_modules/next/dist/docs/.../authInterrupts.md).
//
// It names no role and lists no other page: an operator who cannot open this does not
// need to learn the shape of what they cannot open.
export default function NoPermission() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col items-start gap-4 bg-page px-6 py-10 text-ink">
      <h1 className="text-2xl font-bold tracking-tight">權限不足</h1>
      <p className="text-muted">
        這個頁面只開放給系統管理員。若你需要使用，請聯絡教會的系統管理員調整你的帳號權限。
      </p>
      <Link
        href="/admin"
        className="inline-flex min-h-11 items-center rounded-xl border border-border px-4 text-sm text-ink transition-colors hover:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
      >
        回管理後台首頁
      </Link>
    </main>
  )
}
