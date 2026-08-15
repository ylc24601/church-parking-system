import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getAdminSession } from '@/server/http/adminAuth'
import MemberImport from './MemberImport'

export const metadata: Metadata = {
  title: '名單匯入 · 管理後台',
}

// Server component: session gate only. The upload + report are interactive (client)
// and carry PII, so nothing is fetched here.
export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function AdminImportPage() {
  if (!(await getAdminSession())) redirect('/admin')
  return <MemberImport />
}
