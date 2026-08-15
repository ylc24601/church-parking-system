import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getAdminSession } from '@/server/http/adminAuth'
import { listPendingBindingsPage } from '@/server/services/bindingAdminService'
import BindingReview from './BindingReview'

export const metadata: Metadata = {
  title: '綁定審核 · 管理後台',
}

// Server component: session gate + the masked pending list. PendingClaimListItem
// is already service-masked (code/phone) — it IS the client DTO; hasMore comes from
// a limit+1 read so 100 rows never silently pretends to be everything.
export default async function AdminBindingsPage() {
  const session = await getAdminSession()
  if (!session) redirect('/admin')

  const { items, hasMore } = await listPendingBindingsPage({ limit: 100 })
  return <BindingReview items={items} hasMore={hasMore} />
}
