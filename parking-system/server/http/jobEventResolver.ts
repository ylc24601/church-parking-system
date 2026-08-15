import { taipeiToday } from '@/lib/taipeiDate'
import { isUuidFormat } from '@/lib/uuid'
import { createParkingRepository, type ParkingRepository } from '@/server/repositories/parkingRepository'

// Phase 9 Slice 1 — shared eventId resolution for the weekly job routes, so a static
// external scheduler (fixed URL + `{}` body) can drive them without knowing this
// week's UUID. Contract:
//   * body is not an object / no body       → resolve the upcoming Sunday's event.
//   * `eventId` property PRESENT            → must be a well-formed UUID string.
//     Anything else (null, '', number, malformed) is a 400: a present-but-invalid
//     value must NEVER silently fall back to resolution, or a scheduler
//     misconfiguration stays invisible.
//   * no upcoming event exists              → 503 `upcoming_event_missing`: the
//     scheduling precondition is broken (ensure-weekly-event didn't run / event was
//     deleted) and the external scheduler should alert. Distinct from a legitimate
//     "event exists but nothing to do this round", which stays a service-level 200.
export type ResolvedJobEvent = { ok: true; eventId: string } | { ok: false; response: Response }

export async function resolveJobEventId(
  body: unknown,
  deps: { now?: Date; repo?: ParkingRepository } = {},
): Promise<ResolvedJobEvent> {
  if (typeof body === 'object' && body !== null && 'eventId' in body) {
    const eventId = (body as { eventId?: unknown }).eventId
    if (!isUuidFormat(eventId)) {
      return {
        ok: false,
        response: Response.json({ ok: false, error: 'invalid eventId' }, { status: 400 }),
      }
    }
    // Explicit event always wins — no DB lookup, manual ops behavior unchanged.
    return { ok: true, eventId }
  }

  const repo = deps.repo ?? createParkingRepository()
  const now = deps.now ?? new Date()
  const event = await repo.getUpcomingScheduledEvent(taipeiToday(now))
  if (!event) {
    return {
      ok: false,
      response: Response.json({ ok: false, error: 'upcoming_event_missing' }, { status: 503 }),
    }
  }
  return { ok: true, eventId: event.id }
}
