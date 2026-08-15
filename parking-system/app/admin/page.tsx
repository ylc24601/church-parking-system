import type { Metadata } from 'next'
import { getAdminSession } from '@/server/http/adminAuth'
import { getWeekOverview } from '@/server/services/adminOverviewService'
import { getAdminRequestNow } from '@/server/services/adminTodoService'
import AdminOverview from './AdminOverview'
import AdminLogin from './AdminLogin'

export const metadata: Metadata = {
  title: '管理後台 · 教會停車',
}

// The overview's numbers (stage, capacity) must be live per request; getAdminRequestNow
// gives this page and the layout's todo snapshot ONE shared "now" (same Sunday / today).
export const dynamic = 'force-dynamic'

// Server component: gate on the admin session. Logged out → username/password login.
// Logged in → the back-office overview (上指標 fetched here; 下待辦 counts come from the
// layout's AdminTodoProvider so they match the sidebar badges).
export default async function AdminPage() {
  const session = await getAdminSession()
  if (!session) return <AdminLogin />

  const overview = await getWeekOverview({ now: getAdminRequestNow() })
  return <AdminOverview overview={overview} />
}
