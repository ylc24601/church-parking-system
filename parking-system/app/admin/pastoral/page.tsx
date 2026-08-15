import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getAdminSession } from '@/server/http/adminAuth'
import { listPastoralAlerts } from '@/server/services/pastoralAlertService'
import PastoralAlerts from './PastoralAlerts'

export const metadata: Metadata = {
  title: '牧養關懷 · 管理後台',
}

// Sensitive surface (names + absence counts + pastoral notes): admin session only,
// always live, never cached. `router.refresh()` re-runs this fetch after a resolve.
export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function AdminPastoralPage() {
  if (!(await getAdminSession())) redirect('/admin')

  const data = await listPastoralAlerts()
  return <PastoralAlerts {...data} />
}
