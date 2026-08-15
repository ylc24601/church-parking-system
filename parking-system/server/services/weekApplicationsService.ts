import { upcomingSundayISO } from '@/lib/taipeiDate'
import { splitWeekApplications, type WeekApplicationsSplit } from '@/lib/weekApplications'
import { createParkingRepository, type ParkingRepository } from '@/server/repositories/parkingRepository'

// #35 — the /admin/week drilldown that #32's 申請中/候補 counts link into. Same "this
// week" resolution as the overview (getWeekOverview): the Taipei CALENDAR's upcoming
// Sunday, NOT getActiveEvent() — so the two pages can never point at different weeks.
export interface WeekApplicationsResult extends WeekApplicationsSplit {
  sunday: string
}

export async function getWeekApplications(
  params: { now?: Date } = {},
  repo: ParkingRepository = createParkingRepository(),
): Promise<WeekApplicationsResult> {
  const sunday = upcomingSundayISO(params.now ?? new Date())
  const event = await repo.getWeeklyEventBySunday(sunday)

  // No weekly_events row yet: nothing scheduled, not an error — same posture as
  // getWeekOverview's no_event stage.
  if (!event) return { sunday, pending: [], waiting: [] }

  const rows = await repo.listWeekApplications(event.id)
  return { sunday, ...splitWeekApplications(rows) }
}
