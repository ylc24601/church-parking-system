import type { Metadata, Viewport } from 'next'
import { getStaffSession } from '@/server/http/staffAuth'
import { createParkingRepository } from '@/server/repositories/parkingRepository'
import StaffLogin from './StaffLogin'
import StaffCheckIn, { type StaffRow } from './StaffCheckIn'

export const metadata: Metadata = {
  title: '現場點名 · 教會停車',
}

// Mobile-first: lock zoom layout to device width for one-hand use in the basement.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#14532d',
}

// Server component: gate on the Staff PIN session. Logged out → PIN login. Logged
// in → fetch the privacy-projected list for the session's bound event server-side
// (close to the data, secrets never touch the client) and hand it to the list.
export default async function StaffPage() {
  const session = await getStaffSession()
  if (!session) return <StaffLogin />

  const repo = createParkingRepository()
  const event = await repo.getWeeklyEvent(session.eventId)
  const rows: StaffRow[] = event
    ? (await repo.getStaffCheckInList(event.id)).map(r => ({
        reservation_id: r.reservation_id,
        display_name: r.display_name,
        license_plate: r.license_plate,
        walk_in_name: r.walk_in_name,
        walk_in_license_plate: r.walk_in_license_plate,
        is_priority: r.is_priority,
        status: r.status,
        attended_at: r.attended_at ? r.attended_at.toISOString() : null,
        owner_notifiable: r.owner_notifiable,
      }))
    : []

  return <StaffCheckIn initialEvent={event} initialRows={rows} />
}
