import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { can } from '@/lib/adminRoles'
import { getAdminSession } from '@/server/http/adminAuth'
import { getOutboxHealth } from '@/server/services/outboxHealthService'
import { buildOutboxAlertFromHealth, readAlertThresholds } from '@/server/services/outboxAlertService'
import NoPermission from '../NoPermission'
import OpsDashboard from './OpsDashboard'

export const metadata: Metadata = {
  title: '通知系統狀態 · 管理後台',
}

// Operational numbers must be live, so this is uncacheable. A SINGLE health snapshot
// drives both the counts and the alert verdict (via buildOutboxAlertFromHealth) so the
// banner can never disagree with the stats. `router.refresh()` re-runs this fetch.
export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function AdminOpsPage() {
  const session = await getAdminSession()
  if (!session) redirect('/admin')
  if (!can(session.role, 'view_ops')) return <NoPermission />

  const now = new Date()
  const health = await getOutboxHealth({ now })
  const alert = buildOutboxAlertFromHealth(health, readAlertThresholds(), now)

  return <OpsDashboard health={health} alert={alert} snapshotAt={now.toISOString()} />
}
