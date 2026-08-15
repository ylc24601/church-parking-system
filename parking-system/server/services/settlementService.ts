import type { AllocationUser } from '@/lib/types'
import { settleNoShow } from '@/lib/allocation/settle'
import {
  createParkingRepository,
  type PastoralAlertPayload,
  type ParkingRepository,
  type SettlementPenaltyPayload,
} from '@/server/repositories/parkingRepository'
import { runRelease } from './releaseService'

export interface SettlementSummary {
  releasedNow: number      // rows the pre-settle release sweep moved to released_late
  settled: number          // released_late → no_show this run
  penaltiesApplied: number
  alertsCreated: number
}

const dateToStr = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null)

// Staff「結束當週點名」: settle every still-released_late reservation into no_show, apply the
// no-show penalty rules, and raise a pastoral-care alert for P1/P2 who hit the consecutive
// threshold. Runs a final release sweep first so a missed/delayed release job doesn't leave
// approved-but-past-deadline rows un-settled. Idempotent: a re-run settles 0 rows.
export async function settle(
  params: { eventId: string; now?: Date },
  repo: ParkingRepository = createParkingRepository(),
): Promise<SettlementSummary> {
  const { eventId, now = new Date() } = params

  // 1) Final release sweep — promote any approved-but-past-deadline rows to released_late.
  // These rows are settled to no_show right below; the pastoral path stays silent, so the
  // release-owner notice is suppressed here (a normal near-real-time sweep still sends it).
  const release = await runRelease({ eventId, now, notifyReleasedOwners: false }, repo)

  // 2) Reload what is now released_late.
  const released = await repo.getReleasedLateForSettlement(eventId)
  if (released.length === 0) {
    return { releasedNow: release.released, settled: 0, penaltiesApplied: 0, alertsCreated: 0 }
  }

  // 3) Build AllocationUser per member (privilege from frozen effective_priority; counters from DB).
  const userIds = [...new Set(released.map(r => r.user_id).filter((id): id is string => id !== null))]
  const counters = await repo.getPenaltyCountersForUsers(userIds)
  const countersById = new Map(counters.map(c => [c.user_id, c]))

  const users: AllocationUser[] = released
    .filter((r): r is typeof r & { user_id: string } => r.user_id !== null)
    .map(r => {
      const c = countersById.get(r.user_id)
      return {
        id: r.user_id,
        p1_eligible: r.effective_priority === 1,
        p2_eligible: r.effective_priority === 2,
        penalty_score: c?.penalty_score ?? 0,
        consecutive_no_show: c?.consecutive_no_show ?? 0,
        last_successful_attended_at: c?.last_successful_attended_at ?? null,
      }
    })

  // 4) Pure settlement → penalty updates (+ pastoral_care_flag).
  const { penaltyUpdates } = settleNoShow(released, users)

  // 5) Map to payloads. No outbox is built — pastoral notification routing is deferred.
  const penalties: SettlementPenaltyPayload[] = penaltyUpdates.map(pu => ({
    user_id: pu.user_id,
    penalty_score: pu.penalty_score,
    consecutive_no_show: pu.consecutive_no_show,
    last_successful_attended_at: dateToStr(pu.last_successful_attended_at),
  }))
  const alerts: PastoralAlertPayload[] = penaltyUpdates
    .filter(pu => pu.pastoral_care_flag)
    .map(pu => ({ user_id: pu.user_id, reason: 'consecutive_no_show', trigger_count: pu.consecutive_no_show }))

  // 6) Apply atomically.
  const res = await repo.applySettlement({ eventId, nowIso: now.toISOString(), penalties, alerts })
  return {
    releasedNow: release.released,
    settled: res.settled,
    penaltiesApplied: res.penalties_applied,
    alertsCreated: res.alerts_created,
  }
}
