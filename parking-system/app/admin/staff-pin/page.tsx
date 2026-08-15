import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getAdminSession } from '@/server/http/adminAuth'
import { getStaffPinStatus } from '@/server/services/staffPinAdminService'
import StaffPinManager from './StaffPinManager'

export const metadata: Metadata = {
  title: '現場 PIN 管理 · 管理後台',
}

// The managed Sundays (current + next) come from the Taipei-calendar helper shared with
// the mutation routes — never from getActiveEvent(). Live, uncacheable; router.refresh()
// re-runs this fetch after an issue/unlock.
export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function AdminStaffPinPage() {
  if (!(await getAdminSession())) redirect('/admin')

  const status = await getStaffPinStatus()
  return <StaffPinManager current={status.current} next={status.next} />
}
