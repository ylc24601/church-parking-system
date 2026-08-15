import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getAdminSession } from '@/server/http/adminAuth'
import { getCapacityCards } from '@/server/services/capacityAdminService'
import CapacityForm from './CapacityForm'

export const metadata: Metadata = {
  title: '車位設定 · 管理後台',
}

// Live capacity behind a session, and the numbers must never be stale — a cached page
// would show a 幹事 the wrong version and turn every submit into a conflict.
export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function AdminCapacityPage() {
  if (!(await getAdminSession())) redirect('/admin')

  const { current, next } = await getCapacityCards()

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col gap-6 bg-page px-6 py-10 text-ink">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">車位設定</h1>
      </header>

      <p className="rounded-xl border border-border bg-surface px-4 py-3 text-sm text-muted">
        「保留·停用」是本週不開放分配的車位總數（外賓、施工、維修等一併計入）。
        可分配車位 ＝ 總車位 − 保留·停用 − 同工保留位。
        已核准的車位不會因為調整而被收回——系統不會讓可分配數低於已核准數。
      </p>

      <div className="flex flex-col gap-4">
        {[current, next].map((card, i) => (
          <CapacityForm key={card?.sunday ?? i} card={card} heading={i === 0 ? '本週' : '下週'} />
        ))}
      </div>
    </main>
  )
}
