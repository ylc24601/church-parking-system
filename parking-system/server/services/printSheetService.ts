import { upcomingSundayISO } from '@/lib/taipeiDate'
import type { StaffRow } from '@/lib/staffRow'
import { createParkingRepository, type ParkingRepository } from '@/server/repositories/parkingRepository'

// Wave 1a (#23) — data for the printable roster backup sheet, now an ADMIN page (/admin/print).
// Printing is an office task done before service, while online: it belongs to an admin account, not
// to the shared on-site PIN.
//
// The Sunday comes from the Taipei CALENDAR (upcomingSundayISO: the smallest Sunday >= today, so
// Sunday itself counts all day) — NOT getActiveEvent(), whose "latest non-finalized" semantics would
// print last week's roster whenever that week was left unfinalized. Same rule, and same reasoning, as
// staffPinAdminService.
//
// Privacy: reads ONLY the Staff-safe projection (staff_checkin_view via getStaffCheckInList) — never
// reservations / user_eligibility / user_penalties. The printed sheet keeps the Staff-safe minimum.

export interface PrintSheet {
  // snake_case mirrors the repo row + StaffRow the same page renders (sundayLabel takes sunday_date);
  // a camelCase DTO here would mean two styles on one page.
  event: { id: string; sunday_date: string } | null
  rows: StaffRow[]
}

export async function getAdminPrintSheet(
  params: { now?: Date } = {},
  repo: ParkingRepository = createParkingRepository(),
): Promise<PrintSheet> {
  const sunday = upcomingSundayISO(params.now ?? new Date())
  const event = await repo.getWeeklyEventBySunday(sunday)
  // No weekly_event for this Sunday: nothing to print, and no reason to query a roster.
  if (!event) return { event: null, rows: [] }

  const rows = (await repo.getStaffCheckInList(event.id)).map(r => ({
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
  return { event: { id: event.id, sunday_date: event.sunday_date }, rows }
}
