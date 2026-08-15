import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getAdminSession } from '@/server/http/adminAuth'
import { getAdminPrintSheet } from '@/server/services/printSheetService'
import {
  rowName,
  rowPlate,
  isWalkIn,
  sundayLabel,
  statusLabel,
  sortRowsForPrint,
} from '@/lib/staffRow'
import PrintButton from './PrintButton'

export const metadata: Metadata = {
  title: '列印點名表 · 管理後台',
}

// The Sunday comes from the Taipei calendar (see printSheetService) — never getActiveEvent().
// Live, uncacheable: the roster changes right up to the moment it is printed.
export const dynamic = 'force-dynamic'
export const revalidate = 0

const printTimeFmt = new Intl.DateTimeFormat('zh-TW', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'Asia/Taipei',
})

// Printable paper backup for the on-site list (Wave 1a #23 — moved off the shared on-site PIN to an
// admin account). Same Staff-safe source and same printed minimum as before: never reads
// reservations / user_eligibility / user_penalties. Light theme, manual print only.
export default async function AdminPrintPage() {
  if (!(await getAdminSession())) redirect('/admin')

  // One clock for the whole request: the same instant decides the Sunday and stamps the sheet, so a
  // request straddling Taipei midnight can't resolve one week and print another week's timestamp.
  const now = new Date()
  const { event, rows } = await getAdminPrintSheet({ now })

  const sorted = sortRowsForPrint(rows)
  const priorityCount = rows.filter(r => r.is_priority).length
  const generatedAt = printTimeFmt.format(now)

  return (
    <main className="mx-auto min-h-dvh w-full max-w-3xl bg-white px-6 py-6 text-black">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold">
            {event ? `${sundayLabel(event.sunday_date)} 停車點名備援清單` : '停車點名備援清單'}
          </h1>
          <p className="mt-1 text-sm text-gray-700">
            列印時間 {generatedAt}　·　共 {rows.length} 台（⭐ 優先 {priorityCount} 台）
          </p>
          <p className="mt-1 text-sm text-gray-700">
            紙本僅供網路異常備援，恢復網路後請於系統補登。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2 print:hidden">
          <PrintButton />
          <Link href="/admin" className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700">
            返回
          </Link>
        </div>
      </div>

      {/* Two distinct empty states: "no weekly_event yet" is an operations problem to act on,
          whereas an event with no rows is simply an empty roster. */}
      {!event ? (
        <p className="py-16 text-center text-gray-500">
          尚未建立本週主日活動，請先確認每週活動排程或聯絡系統管理者。
        </p>
      ) : rows.length === 0 ? (
        <p className="py-16 text-center text-gray-500">本週尚無可列印的點名資料。</p>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b-2 border-black text-left">
              <th className="w-8 border border-gray-400 px-2 py-1 text-center">⭐</th>
              <th className="border border-gray-400 px-2 py-1">姓名</th>
              <th className="border border-gray-400 px-2 py-1">車牌</th>
              <th className="w-20 border border-gray-400 px-2 py-1">目前狀態</th>
              <th className="w-12 border border-gray-400 px-2 py-1 text-center">到場</th>
              <th className="w-44 border border-gray-400 px-2 py-1">
                現場備註
                <span className="ml-1 block text-[10px] font-normal text-gray-500">
                  請勿記錄電話、病況、行動不便原因等個資
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(r => (
              <tr key={r.reservation_id} className="border-b border-gray-300">
                <td className="border border-gray-400 px-2 py-2 text-center">
                  {r.is_priority ? '⭐' : ''}
                </td>
                <td className="border border-gray-400 px-2 py-2">
                  {rowName(r)}
                  {isWalkIn(r) && <span className="ml-1 text-gray-500">· 現場</span>}
                </td>
                <td className="border border-gray-400 px-2 py-2 font-mono tracking-wide">{rowPlate(r)}</td>
                <td className="border border-gray-400 px-2 py-2">{statusLabel(r.status)}</td>
                <td className="border border-gray-400 px-2 py-2 text-center text-gray-400">☐</td>
                <td className="border border-gray-400 px-2 py-2" />
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  )
}
