import type { NotificationTemplate } from '@/lib/types'
import type { OutboxRow, ParkingRepository } from '@/server/repositories/parkingRepository'

// Wave 1d (#27) — stamp the week and the car onto outbox payloads at ENQUEUE time.
//
// Why here and not in the dispatcher: templates.ts renders from the payload persisted on the row
// and nothing else, so the message is a snapshot of the moment it was queued. A member who swaps
// their vehicle after being approved should still see the plate they applied with.
//
// This is the single authority for `sunday_date` / `license_plate` in a payload: it drops both
// and re-adds only what it confirmed, so a producer can neither pre-empt it nor leave a stale
// value behind when a lookup fails soft. It also strips `license_plate` from templates that
// don't render one — data the message won't show has no business sitting in
// notification_outbox.payload_json, which nothing purges yet.

// OutboxRow.template_key is a plain string, but these sets are authored as NotificationTemplate
// so a typo is a compile error. Widening the SET (never the key) keeps that guarantee at the
// lookup — casting the key instead would silently accept any string.
function has(set: ReadonlySet<NotificationTemplate>, key: string): boolean {
  return (set as ReadonlySet<string>).has(key)
}

// Every member-facing template names its Sunday. move_car_request is deliberately absent: it is
// an on-site, right-now request, and a date would only muddy it.
const DATE_TEMPLATES: ReadonlySet<NotificationTemplate> = new Set<NotificationTemplate>([
  'reservation_approved',
  'reservation_waiting',
  'offer_2hr_confirm',
  'offer_auto_approved',
  'broadcast_release',
  'reservation_released',
  'reservation_cancelled',
  'p2_arrival_reminder',
])

// Only the templates whose subject IS the member's own car. Excluded on purpose:
//   broadcast_release     — it announces someone else's freed spot, not their car
//   reservation_cancelled — they just pressed cancel; the plate adds nothing
//   reservation_released  — Phase 4 Slice D (e83451e) fixed this payload as aggregate-safe:
//                           released_at and no per-member field. The release sweep is the one
//                           path that fans out to many members at once, so keeping per-member
//                           data out of its payload is defence in depth against a batch ever
//                           pairing the wrong row with the wrong member. The copy loses nothing:
//                           a member holds one reservation a week, and「您 7月19日 主日保留的
//                           車位已於 10:30 釋出」already identifies it.
//                           Guarded by tests/integration/release-owner-notice.db.test.ts.
const PLATE_TEMPLATES: ReadonlySet<NotificationTemplate> = new Set<NotificationTemplate>([
  'reservation_approved',
  'reservation_waiting',
  'offer_2hr_confirm',
  'offer_auto_approved',
  'p2_arrival_reminder',
])

// The templates this helper is the authority for. Anything outside it passes through untouched —
// notably move_car_request, which resolves its own plate (including a walk-in's, which no
// reservation→vehicle lookup could find). Without this line, routing that template through here
// would silently strip the one field its message is built around.
const MANAGED = new Set<NotificationTemplate>([...DATE_TEMPLATES, ...PLATE_TEMPLATES])

// The Sunday for a notification whose producer does NOT otherwise need the event.
//
// Fail-soft on purpose: plain (pending/waiting) cancellation and the release sweep read no event
// today. Adding a throwing read for the sake of a date would mean a blip on weekly_events could
// stop a member cancelling, or stop the Sunday release. A missing date costs one word in the
// message (templates fall back to「本週」); it must never cost the operation.
//
// Producers that ALREADY read the event for core logic (allocation, offers, auto-approve,
// approved-cancellation deadlines) must pass event.sunday_date straight in — that read is not
// decoration and must keep throwing.
export async function getSundayDateForNotification(
  eventId: string,
  repo: ParkingRepository,
): Promise<string | null> {
  try {
    const event = await repo.getWeeklyEvent(eventId)
    return event?.sunday_date ?? null
  } catch {
    // Deliberately silent: no raw error, no ids. There is no sanitized logger here yet, and a
    // plate/line_id/message must never reach a log. Tests cover this path.
    return null
  }
}

export async function withNotificationContext(
  rows: OutboxRow[],
  ctx: { sundayDate: string | null; repo: ParkingRepository },
): Promise<OutboxRow[]> {
  if (rows.length === 0) return rows

  const ids = [
    ...new Set(
      rows
        .filter(r => has(PLATE_TEMPLATES, r.template_key) && r.reservation_id !== null)
        .map(r => r.reservation_id as string),
    ),
  ]

  let plates = new Map<string, string>()
  try {
    // Skip the round trip entirely when nothing in this batch renders a plate — the release
    // sweep, for one, never does.
    if (ids.length > 0) plates = await ctx.repo.getPlatesForReservations(ids)
  } catch {
    // Same contract as the date above: the plate decorates the message, so a failed lookup
    // drops the plate line — it never fails the allocation/offer/release that is being announced.
    plates = new Map()
  }

  return rows.map(row => {
    if (!has(MANAGED, row.template_key)) return row

    const plateAllowed = has(PLATE_TEMPLATES, row.template_key)
    const plate = plateAllowed && row.reservation_id ? plates.get(row.reservation_id) : undefined

    // Drop BOTH context keys before re-adding whatever was actually confirmed. Dropping them
    // unconditionally is what makes this the authority: a template that shows neither never
    // persists one, and a template that does can never show a value the lookup didn't confirm.
    //
    // The date matters as much as the plate here. When the decorative event lookup fails soft,
    // ctx.sundayDate is null — and a producer-written sunday_date left in place would then be an
    // unverified date rendered as fact, instead of the honest「本週」fallback. No producer writes
    // one today, but p2ReminderService did until this very slice, so treat it as reachable.
    const base = { ...row.payload }
    delete base.sunday_date
    delete base.license_plate

    return {
      ...row,
      payload: {
        ...base,
        ...(has(DATE_TEMPLATES, row.template_key) && ctx.sundayDate
          ? { sunday_date: ctx.sundayDate }
          : {}),
        ...(plate ? { license_plate: plate } : {}),
      },
    }
  })
}
