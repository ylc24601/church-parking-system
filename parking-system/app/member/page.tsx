import type { Metadata, Viewport } from 'next'
import { canDeclareCompanion } from '@/lib/allocation/priority'
import { taipeiToday } from '@/lib/taipeiDate'
import { getMemberSession } from '@/server/http/memberAuth'
import { MemberAuthConfigError, resolveMemberAuthMode } from '@/server/services/memberAuthService'
import { createParkingRepository } from '@/server/repositories/parkingRepository'
import MemberLiffGate from './MemberLiffGate'
import MemberStatus, { type MemberWeekStatus } from './MemberStatus'

export const metadata: Metadata = {
  title: '會友專區 · 教會停車',
}

// LIFF is a phone surface: lock layout to device width (same posture as /staff).
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#06c755',
}

// Server component: gate on the member session. Logged out → LIFF/mock login gate.
// Logged in → fetch this week's own reservation server-side and map it to the
// member-safe DTO (never the raw DB row).
export default async function MemberPage() {
  const session = await getMemberSession()

  if (!session) {
    let mode: 'liff' | 'mock'
    try {
      mode = resolveMemberAuthMode().mode
    } catch (e) {
      if (e instanceof MemberAuthConfigError) return <ConfigError code={e.code} />
      throw e
    }
    const liffId = process.env.NEXT_PUBLIC_LIFF_ID ?? null
    if (mode === 'liff' && !liffId) return <ConfigError code="missing_liff_id" />
    return <MemberLiffGate mode={mode} liffId={liffId} />
  }

  const repo = createParkingRepository()
  const now = new Date()
  const [displayName, event] = await Promise.all([
    repo.getUserDisplayName(session.userId),
    repo.getMemberEvent(taipeiToday(now)),
  ])
  const reservation = event ? await repo.getMemberWeekReservation(session.userId, event.id) : null

  // A cancelled row is not "live": the member may re-apply (the one-active index
  // excludes cancelled rows), so the apply block shows alongside the cancelled card.
  const live =
    reservation !== null &&
    reservation.status !== 'cancelled_by_user' &&
    reservation.status !== 'cancelled_late'

  // Live queue position (#29), only meaningful while waiting. allocation_order is assigned to
  // every row at Friday allocation, so a waiting row should always have one — guard anyway and
  // fall back to the generic copy rather than invent a position. allocation_order itself is
  // server-only; just the derived rank reaches the DTO.
  const waitingRank =
    event && reservation?.status === 'waiting' && reservation.allocation_order !== null
      ? await repo.getWaitingRank(event.id, reservation.allocation_order)
      : null

  // Apply affordance (Slice 3): only assembled when there is an open week and no live
  // reservation. Eligibility stays server-side — the DTO carries derived bits only.
  let apply: MemberWeekStatus['apply'] = null
  if (event && event.status === 'open' && !live) {
    const [role, vehicles, eligibility, allocationRan] = await Promise.all([
      repo.getUserRole(session.userId),
      repo.getMemberVehicles(session.userId),
      repo.getMemberEligibility(session.userId),
      repo.hasFridayAllocationRun(event.id),
    ])
    apply = {
      closed: allocationRan,
      staffP1: role === 'full_time_staff',
      vehicles: vehicles.map(v => ({ id: v.id, plate: v.license_plate, nickname: v.nickname })),
      companionKind: canDeclareCompanion(eligibility, event.sunday_date),
    }
  }

  const status: MemberWeekStatus = {
    displayName: displayName ?? '會友',
    sundayDate: event?.sunday_date ?? null,
    reservation: reservation
      ? {
          status: reservation.status,
          plate: reservation.license_plate,
          releaseDeadlineAt: reservation.release_deadline_at?.toISOString() ?? null,
          offerExpiresAt: reservation.offer_expires_at?.toISOString() ?? null,
          p2OnTheWay: reservation.p2_on_the_way,
          waitingRank,
        }
      : null,
    apply,
    canCancel:
      live && (reservation!.status === 'pending' || reservation!.status === 'waiting' || reservation!.status === 'approved'),
    // Slice 4 affordances, computed server-side from server-only row fields
    // (effective_priority / attended_at never reach the DTO themselves).
    canRespondOffer:
      live &&
      reservation!.status === 'temp_approved' &&
      (reservation!.offer_expires_at === null || reservation!.offer_expires_at.getTime() > now.getTime()),
    canReportOnTheWay:
      live &&
      reservation!.status === 'approved' &&
      reservation!.effective_priority === 2 &&
      !reservation!.p2_on_the_way &&
      reservation!.attended_at === null &&
      reservation!.release_deadline_at !== null &&
      reservation!.release_deadline_at.getTime() >= now.getTime(),
  }
  return <MemberStatus status={status} />
}

// Deploy-time misconfiguration (bad MEMBER_AUTH_MODE / missing channel or LIFF id).
// Member-facing copy stays generic; the code is operator-diagnosable and secret-free.
function ConfigError({ code }: { code: string }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-3 bg-page px-6 text-ink">
      <h1 className="text-xl font-semibold">會友專區暫時無法使用</h1>
      <p className="text-sm text-muted">請聯繫管理同工（{code}）</p>
    </main>
  )
}
