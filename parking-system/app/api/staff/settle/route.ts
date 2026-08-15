import { getStaffSession, staffUnauthorized } from '@/server/http/staffAuth'
import { requireWritableEvent } from '@/server/http/staffEventGuard'
import { createParkingRepository } from '@/server/repositories/parkingRepository'
import { settle } from '@/server/services/settlementService'

// Staff「結束當週點名」: settle every still-released_late reservation into no_show,
// then finalize the event (status → 'finalized'), closing the week to further Staff
// writes. Thin Staff-safe wrapper over the existing Phase 2 Slice 4
// settlementService.settle() (final release sweep + no-show penalties + pastoral
// alerts, all server-side). Binds to the PIN session's event — never a client id.
//
// settle and finalize are NOT one DB transaction. If settle succeeds but finalize
// fails, `finalized:false` is returned: settle() is idempotent, so re-pressing
// re-settles 0 rows and retries finalize. An already-finalized event short-circuits
// with 409 before settling.
//
// Returns a STRICT Staff-safe DTO: only { ok, settled, releasedNow, finalized }.
// `penaltiesApplied` / `alertsCreated` reveal penalty/pastoral activity — never exposed.
export async function POST(): Promise<Response> {
  const session = await getStaffSession()
  if (!session) return staffUnauthorized()

  try {
    const repo = createParkingRepository()
    const blocked = await requireWritableEvent(repo, session.eventId)
    if (blocked) return blocked

    const s = await settle({ eventId: session.eventId }, repo)

    // Close the week. Separate try: settlement already succeeded, so a finalize
    // failure is reported (finalized:false) rather than failing the whole action.
    let finalized = false
    try {
      await repo.finalizeWeeklyEvent(session.eventId)
      finalized = true
    } catch {
      finalized = false
    }

    // Whitelist only — drop penaltiesApplied / alertsCreated.
    return Response.json({ ok: true, settled: s.settled, releasedNow: s.releasedNow, finalized })
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
