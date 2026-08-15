import { describe, expect, it, vi } from 'vitest'
import type { OutboxRow } from '@/server/repositories/parkingRepository'
import {
  getSundayDateForNotification,
  withNotificationContext,
} from '@/server/services/notification/context'
import { renderTemplate } from '@/server/services/notification/templates'
import { asRepo, makeMockRepo, type MockRepo } from './mockRepo'

// Wave 1d (#27). This helper is the single authority for `sunday_date` / `license_plate` in a
// notification payload, and the place where "decoration must never break the operation" is
// enforced. Both properties are asserted per template key — never by counting keys, which would
// rot the moment a template is added.

const SUNDAY = '2026-07-19'

function row(template_key: string, overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    dedupe_key: `k:${template_key}`,
    template_key,
    user_id: 'user-1',
    reservation_id: 'res-1',
    payload: {},
    ...overrides,
  }
}

function repoWithPlates(plates: Record<string, string> = { 'res-1': 'ABC-1234' }): MockRepo {
  return makeMockRepo({
    getPlatesForReservations: vi.fn(async () => new Map(Object.entries(plates))),
  })
}

// Named explicitly rather than imported from the module under test: if someone edits the
// allowlist, these must fail rather than silently agree with the change.
const DATE_KEYS = [
  'reservation_approved',
  'reservation_waiting',
  'offer_2hr_confirm',
  'offer_auto_approved',
  'broadcast_release',
  'reservation_released',
  'reservation_cancelled',
  'p2_arrival_reminder',
]
const PLATE_KEYS = [
  'reservation_approved',
  'reservation_waiting',
  'offer_2hr_confirm',
  'offer_auto_approved',
  'p2_arrival_reminder',
]
// reservation_released is here, not in PLATE_KEYS: Phase 4 Slice D fixed its payload as
// aggregate-safe (no per-member field) — see the note in context.ts and
// tests/integration/release-owner-notice.db.test.ts, which is the authority for that rule.
const NO_PLATE_KEYS = ['broadcast_release', 'reservation_cancelled', 'reservation_released']

describe('withNotificationContext', () => {
  it.each(DATE_KEYS)('stamps the Sunday onto %s', async key => {
    const [out] = await withNotificationContext([row(key)], {
      sundayDate: SUNDAY,
      repo: asRepo(repoWithPlates()),
    })
    expect(out.payload.sunday_date).toBe(SUNDAY)
  })

  it('leaves move_car_request entirely alone (it resolves its own plate, incl. walk-ins)', async () => {
    const original = row('move_car_request', { payload: { license_plate: 'WALK-IN-9' } })
    const [out] = await withNotificationContext([original], {
      sundayDate: SUNDAY,
      repo: asRepo(repoWithPlates()),
    })
    expect(out.payload).toEqual({ license_plate: 'WALK-IN-9' })
    expect(out.payload.sunday_date).toBeUndefined()
  })

  it.each(PLATE_KEYS)('stamps the plate onto %s', async key => {
    const [out] = await withNotificationContext([row(key)], {
      sundayDate: SUNDAY,
      repo: asRepo(repoWithPlates()),
    })
    expect(out.payload.license_plate).toBe('ABC-1234')
  })

  it.each(NO_PLATE_KEYS)('never gives %s a plate', async key => {
    const [out] = await withNotificationContext([row(key)], {
      sundayDate: SUNDAY,
      repo: asRepo(repoWithPlates()),
    })
    expect(out.payload.license_plate).toBeUndefined()
  })

  // Minimization has to hold in the OUTBOX, not just on screen: payload_json is retained and
  // nothing purges it yet, so a plate the message won't show must not be persisted at all.
  it.each(NO_PLATE_KEYS)('strips an inherited plate from %s rather than just not adding one', async key => {
    const [out] = await withNotificationContext([row(key, { payload: { license_plate: 'OLD-1' } })], {
      sundayDate: SUNDAY,
      repo: asRepo(repoWithPlates()),
    })
    expect(out.payload).not.toHaveProperty('license_plate')
  })

  it('overwrites stale context a producer may have written', async () => {
    const [out] = await withNotificationContext(
      [row('reservation_approved', { payload: { sunday_date: '1999-01-01', license_plate: 'OLD-1' } })],
      { sundayDate: SUNDAY, repo: asRepo(repoWithPlates()) },
    )
    expect(out.payload.sunday_date).toBe(SUNDAY)
    expect(out.payload.license_plate).toBe('ABC-1234')
  })

  it('never leaves an unconfirmed plate behind when the lookup finds nothing', async () => {
    const [out] = await withNotificationContext(
      [row('reservation_approved', { payload: { license_plate: 'STALE-1' } })],
      { sundayDate: SUNDAY, repo: asRepo(repoWithPlates({})) },
    )
    expect(out.payload).not.toHaveProperty('license_plate')
  })

  it('preserves the payload fields the producers own', async () => {
    const rows = [
      row('reservation_waiting', { payload: { rank: 3 } }),
      row('offer_2hr_confirm', { payload: { expires_at: '2026-07-19T02:00:00Z' } }),
      row('reservation_released', { payload: { released_at: '2026-07-19T02:45:00Z' } }),
      row('reservation_cancelled', { payload: { cancel_status: 'cancelled_late' } }),
    ]
    const out = await withNotificationContext(rows, { sundayDate: SUNDAY, repo: asRepo(repoWithPlates()) })
    expect(out[0].payload.rank).toBe(3)
    expect(out[1].payload.expires_at).toBe('2026-07-19T02:00:00Z')
    expect(out[2].payload.released_at).toBe('2026-07-19T02:45:00Z')
    expect(out[3].payload.cancel_status).toBe('cancelled_late')
  })

  it('keeps dedupe_key / user_id / reservation_id untouched, so nothing re-sends', async () => {
    const original = row('reservation_approved')
    const [out] = await withNotificationContext([original], {
      sundayDate: SUNDAY,
      repo: asRepo(repoWithPlates()),
    })
    expect(out.dedupe_key).toBe(original.dedupe_key)
    expect(out.user_id).toBe(original.user_id)
    expect(out.reservation_id).toBe(original.reservation_id)
    expect(out.template_key).toBe(original.template_key)
  })

  // The fail-soft boundary: when the decorative event lookup returns nothing, an inherited date
  // must go too. Leaving it would render an unverified date as fact instead of falling back to
  //「本週」 — and would quietly break the single-authority contract this helper claims.
  it('strips an inherited Sunday when the date lookup produced no trusted date', async () => {
    const [out] = await withNotificationContext(
      [
        row('reservation_cancelled', {
          payload: { cancel_status: 'cancelled_by_user', sunday_date: '1999-01-01' },
        }),
      ],
      { sundayDate: null, repo: asRepo(repoWithPlates()) },
    )

    expect(out.payload.cancel_status).toBe('cancelled_by_user')
    expect(out.payload).not.toHaveProperty('sunday_date')
    expect(renderTemplate('reservation_cancelled', out.payload)).toContain('本週')
    expect(renderTemplate('reservation_cancelled', out.payload)).not.toContain('1999')
  })

  it('omits sunday_date when there is no date, rather than writing null', async () => {
    const [out] = await withNotificationContext([row('reservation_approved')], {
      sundayDate: null,
      repo: asRepo(repoWithPlates()),
    })
    expect(out.payload).not.toHaveProperty('sunday_date')
    expect(out.payload.license_plate).toBe('ABC-1234')
  })

  it('issues no query at all for an empty batch', async () => {
    const repo = repoWithPlates()
    const out = await withNotificationContext([], { sundayDate: SUNDAY, repo: asRepo(repo) })
    expect(out).toEqual([])
    expect(repo.getPlatesForReservations).not.toHaveBeenCalled()
  })

  it('asks only for the reservations that will actually render a plate, deduped', async () => {
    const repo = repoWithPlates()
    await withNotificationContext(
      [
        row('reservation_approved', { reservation_id: 'res-1' }),
        row('p2_arrival_reminder', { reservation_id: 'res-1' }),   // same id twice
        row('broadcast_release', { reservation_id: 'res-2' }),      // no plate → not looked up
        row('reservation_waiting', { reservation_id: null }),       // no id → not looked up
      ],
      { sundayDate: SUNDAY, repo: asRepo(repo) },
    )
    expect(repo.getPlatesForReservations).toHaveBeenCalledWith(['res-1'])
  })

  it('issues no query when nothing in the batch renders a plate (e.g. the release sweep)', async () => {
    const repo = repoWithPlates()
    await withNotificationContext([row('broadcast_release'), row('reservation_released')], {
      sundayDate: SUNDAY,
      repo: asRepo(repo),
    })
    expect(repo.getPlatesForReservations).not.toHaveBeenCalled()
  })

  // The whole point of the helper owning the lookup: a Friday allocation reads plates AFTER it has
  // claimed the job, so a throw here would fail the week's allocation over a message detail.
  it('degrades to no plate when the lookup fails, instead of throwing', async () => {
    const repo = makeMockRepo({
      getPlatesForReservations: vi.fn(async () => {
        throw new Error('boom')
      }),
    })
    const [out] = await withNotificationContext([row('reservation_approved')], {
      sundayDate: SUNDAY,
      repo: asRepo(repo),
    })
    expect(out.payload.sunday_date).toBe(SUNDAY)
    expect(out.payload).not.toHaveProperty('license_plate')
  })
})

describe('getSundayDateForNotification', () => {
  it('returns the event Sunday', async () => {
    const repo = makeMockRepo({
      getWeeklyEvent: vi.fn(async () => ({ id: 'e1', sunday_date: SUNDAY, status: 'open' })),
    })
    expect(await getSundayDateForNotification('e1', asRepo(repo))).toBe(SUNDAY)
  })

  // Only plain cancellation and the release sweep use this — neither reads an event for its own
  // logic, so this lookup exists solely for the copy and must never be able to block them.
  it('returns null instead of throwing when the event read fails', async () => {
    const repo = makeMockRepo({
      getWeeklyEvent: vi.fn(async () => {
        throw new Error('db down')
      }),
    })
    expect(await getSundayDateForNotification('e1', asRepo(repo))).toBeNull()
  })
})
