import type { NotificationOutboxEntry, Reservation, ReleaseResult } from '@/lib/types'
import { RELEASE_TIMES, TAIPEI_UTC_OFFSET_HOURS } from './rules'

// The three Sunday release deadlines (UTC Dates representing Taipei times).
export interface ReleaseDeadlines {
  p3: Date       // 10:30 — P3 一般會友
  p2: Date       // 10:30 — P2 關懷會友（#42：對齊 P3）
  p2Grace: Date  // 10:50 — P2 who replied 「正在路上」
}

// Per-reservation release deadline, derived from priority and the "on the way"
// flag. P2 (effective_priority 2) holds until 10:30, or 10:50 if on the way;
// everyone else (P3) holds until 10:30.
export function computeReleaseDeadline(
  reservation: Pick<Reservation, 'effective_priority' | 'p2_on_the_way'>,
  deadlines: ReleaseDeadlines,
): Date {
  if (reservation.effective_priority === 2) {
    return reservation.p2_on_the_way ? deadlines.p2Grace : deadlines.p2
  }
  return deadlines.p3
}

// Build the three concrete Sunday release deadlines from a Sunday date string, using
// the canonical times in rules.ts (10:30 / 10:30 / 10:50 Asia/Taipei). The date is an
// explicit 'YYYY-MM-DD' (what supabase-js returns for a `date` column), parsed by its
// calendar parts — no Date-parsing ambiguity. Taipei is UTC+8 year-round (no DST), so
// the offset is the rules constant.
export function buildReleaseDeadlines(
  sundayDate: string,
  timezone: string = 'Asia/Taipei',
): ReleaseDeadlines {
  if (timezone !== 'Asia/Taipei') {
    throw new Error(
      `buildReleaseDeadlines: unsupported timezone "${timezone}" (MVP supports Asia/Taipei only)`,
    )
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(sundayDate)
  if (!m) {
    throw new Error(`buildReleaseDeadlines: invalid sundayDate "${sundayDate}" (expected YYYY-MM-DD)`)
  }
  const y = Number(m[1])
  const mo = Number(m[2]) - 1   // JS month is 0-based
  const d = Number(m[3])
  const at = (t: { hour: number; minute: number }): Date =>
    new Date(Date.UTC(y, mo, d, t.hour - TAIPEI_UTC_OFFSET_HOURS, t.minute))

  return {
    p3: at(RELEASE_TIMES.p3),
    p2: at(RELEASE_TIMES.p2),
    p2Grace: at(RELEASE_TIMES.p2Grace),
  }
}

// Sunday 00:00 Asia/Taipei as a UTC Date, from a 'YYYY-MM-DD' Sunday string. Used as
// the substitution cutover (after this instant, offers are direct-approved) and as the
// cap for the offer-confirm window. Taipei is UTC+8 (no DST).
export function buildSundayMidnight(sundayDate: string, timezone: string = 'Asia/Taipei'): Date {
  if (timezone !== 'Asia/Taipei') {
    throw new Error(
      `buildSundayMidnight: unsupported timezone "${timezone}" (MVP supports Asia/Taipei only)`,
    )
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(sundayDate)
  if (!m) {
    throw new Error(`buildSundayMidnight: invalid sundayDate "${sundayDate}" (expected YYYY-MM-DD)`)
  }
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0 - TAIPEI_UTC_OFFSET_HOURS, 0))
}

// Sunday release sweep, driven by each reservation's own release_deadline_at:
//   - now < release_deadline_at         → not released (still held)
//   - now >= release_deadline_at, status approved, not yet attended → released_late
// attended / attended_after_release / cancelled_* / temp_approved are never touched.
// When anything is released, two notification sets are emitted:
//   - broadcast_release   → every still-waiting user (freed capacity, first-come)
//   - reservation_released → each member whose own seat was just released (this sweep)
// The two are distinguished by template_key so the caller can dedupe them differently.
//
// Idempotent: approved reservations become released_late on the first run, so
// subsequent calls release 0 records and emit nothing.
export function releaseExpired(
  reservations: Reservation[],
  now: Date,
): ReleaseResult {
  const releasedIds = new Set<string>()
  const updated = reservations.map(r => {
    if (
      r.status === 'approved' &&
      r.attended_at === null &&
      r.release_deadline_at !== null &&
      now >= r.release_deadline_at
    ) {
      releasedIds.add(r.id)
      return { ...r, status: 'released_late' as const, released_at: now }
    }
    return r
  })
  const releasedCount = releasedIds.size

  const outbox: NotificationOutboxEntry[] = []
  if (releasedCount > 0) {
    const releasedAt = now.toISOString()
    for (const r of updated) {
      // The member who just lost their seat — one informational notice per released row.
      if (releasedIds.has(r.id)) {
        outbox.push({
          user_id: r.user_id,
          reservation_id: r.id,
          template_key: 'reservation_released',
          payload: { released_at: releasedAt },
        })
      }
      // Everyone still waiting hears that capacity opened up.
      if (r.status === 'waiting') {
        outbox.push({
          user_id: r.user_id,
          reservation_id: r.id,
          template_key: 'broadcast_release',
          payload: { released_count: releasedCount },
        })
      }
    }
  }

  return { reservations: updated, outbox, releasedCount }
}
