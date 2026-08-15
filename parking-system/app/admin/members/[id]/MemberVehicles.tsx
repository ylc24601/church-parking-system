'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { memberMaintenanceMessage } from '@/lib/memberMaintenanceTypes'
import Badge from '../../../ui/Badge'

// A member's cars (Tier 0-2 / 0038).
//
// Retired cars are SHOWN, greyed, not hidden. Three reasons, all of them operational:
//   * a plate that simply vanishes leaves nobody able to tell "never had it" from "sold
//     it", and the second one is the question people actually ask;
//   * re-adding a plate this member once had is refused with `inactive_plate_exists` —
//     the remedy is to reactivate THAT row, and the operator has to be able to see it;
//   * reservations reference (vehicle_id, user_id), so the row is the record of who drove
//     what. Deactivation is the closest thing to a delete this system has, and on purpose.
//
// Deactivation is confirmed and can still be refused by the server while a reservation is
// unfinished — that check happens inside the transaction, under the vehicle's row lock. A
// disabled button is not a guard; this UI is a convenience over a real one.
interface VehicleItem {
  id: string
  plate: string
  nickname: string | null
  isActive: boolean
}

export default function MemberVehicles({
  userId,
  vehicles,
}: {
  userId: string
  vehicles: VehicleItem[]
}) {
  const router = useRouter()
  const [plate, setPlate] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [pendingDeactivate, setPendingDeactivate] = useState<VehicleItem | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const active = vehicles.filter(v => v.isActive)
  const retired = vehicles.filter(v => !v.isActive)

  async function post(body: unknown, busy: string): Promise<{ ok: boolean; data: Record<string, unknown> | null }> {
    setBusyId(busy)
    setError(null)
    setNotice(null)
    try {
      const res = await fetch('/api/admin/members/vehicles', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null
      if (res.ok && data?.ok === true) return { ok: true, data }

      const reason = typeof data?.reason === 'string' ? data.reason : ''
      if (reason === 'unfinished_reservations') {
        const n = typeof data?.unfinished === 'number' ? data.unfinished : 0
        // The count is the actionable part: it tells the operator how much is waiting on
        // them, and where (the week's reservation list) rather than just "no".
        setError(`這輛車還有 ${n} 筆尚未結束的預約，請先在該週的預約中取消或結算，再停用車輛。`)
      } else {
        setError(reason === 'invalid_request' ? '車牌格式不正確。' : memberMaintenanceMessage(reason))
      }
      return { ok: false, data }
    } catch {
      setError('連線失敗，請再試一次。')
      return { ok: false, data: null }
    } finally {
      setBusyId(null)
    }
  }

  async function add() {
    const value = plate.trim()
    if (value === '' || busyId !== null) return
    const { ok, data } = await post({ action: 'add', userId, licensePlate: value }, '__add__')
    if (ok) {
      setPlate('')
      setNotice(`已新增車牌 ${value}。`)
      router.refresh()
      return
    }
    // `inactive_plate_exists` is guidance, not a wall: the row to bring back is already on
    // screen below, so point at it instead of leaving the operator to work it out.
    if (typeof data?.reason === 'string' && data.reason === 'inactive_plate_exists') {
      setError(`${memberMaintenanceMessage('inactive_plate_exists')}（見下方「已停用」）`)
    }
  }

  async function setActive(v: VehicleItem, isActive: boolean) {
    if (busyId !== null) return
    const { ok } = await post({ action: 'set_active', vehicleId: v.id, isActive }, v.id)
    if (ok) {
      setPendingDeactivate(null)
      setNotice(isActive ? `已恢復使用 ${v.plate}。` : `已停用 ${v.plate}。`)
      router.refresh()
    }
  }

  return (
    <div className="mt-3 flex flex-col gap-4">
      {active.length === 0 && retired.length === 0 ? (
        <p className="text-sm text-muted">尚未登記車輛。</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {[...active, ...retired].map(v => (
            <li
              key={v.id}
              className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-page px-4 py-3"
            >
              <span className={`font-mono ${v.isActive ? 'text-ink' : 'text-muted line-through'}`}>{v.plate}</span>
              {v.nickname && <span className="text-sm text-muted">{v.nickname}</span>}
              {v.isActive ? (
                <Badge variant="outline" tone="success">使用中</Badge>
              ) : (
                <Badge variant="outline" tone="neutral">已停用</Badge>
              )}
              <div className="ml-auto">
                {v.isActive ? (
                  <button
                    type="button"
                    onClick={() => { setError(null); setNotice(null); setPendingDeactivate(v) }}
                    disabled={busyId !== null}
                    className="inline-flex min-h-11 items-center rounded-lg border border-border px-3 text-sm text-ink transition-colors hover:border-danger-fg disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                  >
                    停用
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setActive(v, true)}
                    disabled={busyId !== null}
                    className="inline-flex min-h-11 items-center rounded-lg border border-border px-3 text-sm text-ink transition-colors hover:border-primary disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                  >
                    {busyId === v.id ? '處理中…' : '恢復使用'}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {pendingDeactivate && (
        <div className="rounded-xl border border-warning-fg/30 bg-warning-bg px-4 py-3 text-sm text-warning-fg">
          <p className="font-semibold">停用 {pendingDeactivate.plate}？</p>
          <p className="mt-1">
            停用後這輛車不能再申請車位、現場也不會比對到這個車牌，但過去的預約紀錄會完整保留。車牌釋出後可登記給其他會友；日後這位會友若換回同一輛車，回到這裡按「恢復使用」即可。
          </p>
          <div className="mt-3 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => setActive(pendingDeactivate, false)}
              disabled={busyId !== null}
              className="inline-flex min-h-11 items-center rounded-xl bg-primary px-5 text-sm font-semibold text-white transition-colors hover:bg-primary-strong disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            >
              {busyId === pendingDeactivate.id ? '停用中…' : '確認停用'}
            </button>
            <button
              type="button"
              onClick={() => setPendingDeactivate(null)}
              disabled={busyId !== null}
              className="inline-flex min-h-11 items-center rounded-xl border border-border px-4 text-sm text-ink transition-colors hover:border-primary disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            >
              取消
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">新增車牌</span>
          <input
            type="text"
            value={plate}
            maxLength={20}
            placeholder="ABC-1234"
            onChange={e => setPlate(e.target.value)}
            className="w-44 rounded-lg border border-border bg-surface px-3 py-2 font-mono text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/30"
          />
        </label>
        <button
          type="button"
          onClick={add}
          disabled={busyId !== null || plate.trim() === ''}
          className="inline-flex min-h-11 items-center rounded-xl border border-border px-4 text-sm font-semibold text-ink transition-colors hover:border-primary disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
        >
          {busyId === '__add__' ? '新增中…' : '新增'}
        </button>
      </div>

      {error && (
        <p className="rounded-lg border border-danger-fg/30 bg-danger-bg px-4 py-2 text-sm text-danger-fg">{error}</p>
      )}
      {notice && <p className="text-sm text-primary-deep">{notice}</p>}
    </div>
  )
}
