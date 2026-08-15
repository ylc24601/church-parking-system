import { describe, expect, it } from 'vitest'
import { RELEASE_TIMES } from '@/lib/allocation/rules'
import { releaseTimeLabel } from '@/lib/memberLabels'
import { renderTemplate } from '@/server/services/notification/templates'

// Rendering reads ONLY the payload persisted on the row. Each enqueued key must render a
// non-empty, church-tone line; an unknown key throws so the dispatcher fails that one row.
describe('renderTemplate', () => {
  it('renders every currently-enqueued template key with a non-empty【教會停車】line', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['reservation_approved', {}],
      ['reservation_approved', { direct: true }],
      ['reservation_waiting', { rank: 3 }],
      ['reservation_waiting', {}],
      ['offer_2hr_confirm', { expires_at: '2026-06-20T02:00:00Z' }],
      ['offer_2hr_confirm', {}],
      ['offer_auto_approved', {}],
      ['broadcast_release', { released_count: 2 }],
      ['reservation_released', { released_at: '2026-06-21T02:45:00Z' }],
      ['reservation_cancelled', { cancel_status: 'cancelled_late' }],
      ['reservation_cancelled', { cancel_status: 'cancelled_by_user' }],
      ['p2_arrival_reminder', { sunday_date: '2026-06-21' }],
    ]
    for (const [key, payload] of cases) {
      const text = renderTemplate(key, payload)
      expect(text).toContain('【教會停車】')
      expect(text.length).toBeGreaterThan(10)
    }
  })

  it('includes the waiting rank when provided', () => {
    expect(renderTemplate('reservation_waiting', { rank: 7 })).toContain('第 7 位')
  })

  it('formats the offer expiry as an Asia/Taipei HH:MM', () => {
    // 02:00Z == 10:00 Taipei
    expect(renderTemplate('offer_2hr_confirm', { expires_at: '2026-06-20T02:00:00Z' })).toContain('10:00')
  })

  it('falls back to a generic offer window when expires_at is missing/invalid', () => {
    expect(renderTemplate('offer_2hr_confirm', { expires_at: 'not-a-date' })).toContain('2 小時內')
  })

  it('includes the Sunday label in the P2 reminder', () => {
    // Was 'toContain(2026-06-21)' — this template used to print the raw ISO date at members
    // (triage #27). The label is now member-voice prose, and the ISO string must never appear.
    const text = renderTemplate('p2_arrival_reminder', { sunday_date: '2026-06-21' })
    expect(text).toContain('6月21日 主日')
    expect(text).not.toContain('2026-06-21')
  })

  it('renders move_car_request with the plate', () => {
    const text = renderTemplate('move_car_request', { license_plate: 'ABC-1234' })
    expect(text).toContain('【教會停車】')
    expect(text).toContain('ABC-1234')
    expect(text).toContain('移車')
  })

  it('renders move_car_request with a fallback when the plate is missing', () => {
    expect(renderTemplate('move_car_request', {})).toContain('車牌未提供')
  })

  it('renders reservation_released with the release time (Asia/Taipei HH:MM), framed as 釋出 not a deadline', () => {
    // 02:45Z == 10:45 Taipei
    const text = renderTemplate('reservation_released', { released_at: '2026-06-21T02:45:00Z' })
    expect(text).toContain('【教會停車】')
    expect(text).toContain('10:45')
    expect(text).toContain('釋出')
    expect(text).toContain('洽詢停車同工')
    // must not reprimand / leak, and must not promise on-site spots exist
    expect(text).not.toMatch(/罰|penalty|逾時|遲到/)
    expect(text).not.toContain('尚有名額')
  })

  it('renders reservation_released with a graceful fallback when released_at is missing/invalid', () => {
    const text = renderTemplate('reservation_released', {})
    expect(text).toContain('【教會停車】')
    expect(text).toContain('釋出')
    expect(renderTemplate('reservation_released', { released_at: 'not-a-date' })).toContain('釋出')
  })

  it('renders reservation_cancelled with distinct wording per cancel_status, and a neutral fallback', () => {
    const late = renderTemplate('reservation_cancelled', { cancel_status: 'cancelled_late' })
    const byUser = renderTemplate('reservation_cancelled', { cancel_status: 'cancelled_by_user' })
    expect(late).toContain('【教會停車】')
    expect(late).toContain('已核准')          // gave up an approved seat
    expect(late).toContain('釋出給候補')
    expect(byUser).toContain('申請／候補')      // was pending/waiting
    expect(late).not.toBe(byUser)
    // unknown / missing status → the neutral (cancelled_by_user) line, never a throw or wrong wording
    expect(renderTemplate('reservation_cancelled', {})).toBe(byUser)
    expect(renderTemplate('reservation_cancelled', { cancel_status: 'weird' })).toBe(byUser)
    // no penalty / personal data in either line
    for (const t of [late, byUser]) expect(t).not.toMatch(/罰|penalty|逾期|名字|車牌/)
  })

  // triage #25: the LINE webhook is capture-only and drops replies, so a "回覆…" instruction
  // is a dead command. Both action templates must route the member to the member page instead
  // (the offer-confirm / on-the-way buttons live there). Forbid ANY 回覆 wording so future
  // rewrites can't silently reintroduce a dead reply command (covers the tail too).
  it.each([
    ['offer_2hr_confirm', { expires_at: '2026-06-20T02:00:00Z' }, '確認保留車位'],
    ['p2_arrival_reminder', { sunday_date: '2026-06-21' }, '我正在路上'],
  ] as const)('%s directs members to the member page instead of replying', (key, payload, action) => {
    const text = renderTemplate(key, payload)
    expect(text).not.toContain('回覆')
    expect(text).toContain('會員頁面')
    expect(text).toContain(action)
  })

  it('throws on an unknown template_key', () => {
    expect(() => renderTemplate('totally_unknown_key', {})).toThrow(/unknown template_key/)
  })

  // ── triage #27: the week, the car, and a legible deadline ──────────────────────────────────
  // The payload's sunday_date / license_plate are stamped at enqueue time by
  // server/services/notification/context (see notificationContext.test.ts for which keys get what).

  const DATE_KEYS: Array<[string, Record<string, unknown>]> = [
    ['reservation_approved', {}],
    ['reservation_waiting', { rank: 3 }],
    ['offer_2hr_confirm', { expires_at: '2026-07-19T02:00:00Z' }],
    ['offer_auto_approved', {}],
    ['broadcast_release', { released_count: 2 }],
    ['reservation_released', { released_at: '2026-07-19T02:45:00Z' }],
    ['reservation_cancelled', { cancel_status: 'cancelled_late' }],
    ['p2_arrival_reminder', {}],
  ]

  it.each(DATE_KEYS)('%s names the Sunday in prose, never as an ISO date', (key, payload) => {
    const text = renderTemplate(key, { ...payload, sunday_date: '2026-07-19' })
    expect(text).toContain('7月19日 主日')
    expect(text).not.toContain('2026-07-19')
  })

  it.each(DATE_KEYS)('%s falls back to 本週 when the payload has no usable date', (key, payload) => {
    // An unparseable date must degrade to the vaguer wording, never print itself or throw.
    for (const bad of [{}, { sunday_date: '2026-02-31' }, { sunday_date: 'nope' }]) {
      const text = renderTemplate(key, { ...payload, ...bad })
      expect(text).toContain('本週')
      expect(text).not.toContain('2026-02-31')
    }
  })

  const PLATE_KEYS: Array<[string, Record<string, unknown>]> = [
    ['reservation_approved', {}],
    ['reservation_waiting', { rank: 3 }],
    ['offer_2hr_confirm', { expires_at: '2026-07-19T02:00:00Z' }],
    ['offer_auto_approved', {}],
    ['p2_arrival_reminder', {}],
  ]

  it.each(PLATE_KEYS)('%s shows which car the message is about', (key, payload) => {
    expect(renderTemplate(key, { ...payload, license_plate: 'ABC-1234' })).toContain('車牌：ABC-1234')
  })

  it.each(PLATE_KEYS)('%s omits the plate line entirely when no plate is known', (key, payload) => {
    // Here the plate is supplementary, so a missing one drops the line rather than announcing
    // 「（車牌未提供）」 — that fallback belongs only to move_car_request, whose subject IS the car.
    expect(renderTemplate(key, payload)).not.toContain('車牌')
  })

  // The payload-level guarantee lives in context.ts (it strips the key); this is the second line
  // of defence — even handed a plate, these renderers must not print one.
  // reservation_released is on this list because Phase 4 Slice D fixed its payload as
  // aggregate-safe; tests/integration/release-owner-notice.db.test.ts is that rule's authority.
  it.each([
    ['broadcast_release', { released_count: 2 }],
    ['reservation_cancelled', { cancel_status: 'cancelled_late' }],
    ['reservation_released', { released_at: '2026-07-19T02:45:00Z' }],
  ])('%s never renders a plate, even if the payload carries one', (key, payload) => {
    expect(renderTemplate(key, { ...payload, license_plate: 'ABC-1234' })).not.toContain('ABC-1234')
  })

  it('puts the offer deadline on its own ⏰ line', () => {
    // triage asked for bold; LINE text messages have no bold, so emphasis is position + whitespace.
    const text = renderTemplate('offer_2hr_confirm', { expires_at: '2026-07-19T02:00:00Z' })
    expect(text).toContain('\n\n⏰ 請於 10:00 前確認\n\n')
    expect(renderTemplate('offer_2hr_confirm', {})).toContain('⏰ 請於 2 小時內確認')
  })

  it('derives the P2 reminder deadlines from RELEASE_TIMES, not hard-coded copy', () => {
    const text = renderTemplate('p2_arrival_reminder', { sunday_date: '2026-07-19' })
    expect(text).toContain(`⏰ 車位保留至 ${releaseTimeLabel(RELEASE_TIMES.p2)}`)
    expect(text).toContain(`保留至 ${releaseTimeLabel(RELEASE_TIMES.p2Grace)}`)
  })

  it.each(DATE_KEYS)('%s keeps the 【教會停車】 sender label on its own line', (key, payload) => {
    // The label is a sender tag (the 【中華電信】… convention), not someone being addressed:
    // 「【教會停車】您好」 on one line reads as greeting the parking system rather than the member.
    const text = renderTemplate(key, { ...payload, sunday_date: '2026-07-19' })
    expect(text.startsWith('【教會停車】\n您好，')).toBe(true)
    expect(text).not.toContain('【教會停車】您好')
  })

  it('never renders a blank section gap', () => {
    // joinSections skips absent sections; a fixed skeleton would leave a hole where a template
    // has no plate and no deadline.
    for (const [key, payload] of [...DATE_KEYS, ['move_car_request', { license_plate: 'A-1' }] as const]) {
      const text = renderTemplate(key, { ...payload, sunday_date: '2026-07-19' })
      expect(text, key).not.toMatch(/\n{3}/)
      expect(text, key).not.toMatch(/^\s|\s$/)
    }
  })

  // ── go-live-checklist §1.4 copy sign-off pin ────────────────────────────────────────────────
  // These four are the exact strings docs/oa-onboarding-and-move-car-copy.md §二/§三 puts in
  // front of the Copy approver. `toContain` elsewhere in this file is deliberately loose (it only
  // pins behavior); these use `toBe` so any wording edit — here or in the doc — shows up as a
  // failing test instead of a silent drift between what was signed off and what actually sends.
  // If you're changing this on purpose, update the doc section in the same change and re-obtain
  // sign-off; do not just edit the expected string.
  it('move_car_request matches the doc §二 A sign-off text exactly', () => {
    const text = renderTemplate('move_car_request', { license_plate: 'ABC-1234' })
    expect(text).toBe(
      '【教會停車】您好 🙏 您停在地下室的車（車牌 ABC-1234）需要麻煩您移車，請您方便時盡快到地下室移動您的愛車，謝謝您的配合！',
    )
  })

  it('reservation_released matches the doc §三 sign-off text exactly', () => {
    const text = renderTemplate('reservation_released', {
      released_at: '2026-07-19T02:45:00Z',
      sunday_date: '2026-07-19',
    })
    expect(text).toBe(
      '【教會停車】\n您好，7月19日 主日保留的車位已於 10:45 釋出。\n\n若仍需停車，請前往地下室現場洽詢停車同工，將依現場狀況協助，謝謝您。',
    )
  })

  it('reservation_cancelled (cancelled_late) matches the doc §三 A sign-off text exactly', () => {
    const text = renderTemplate('reservation_cancelled', {
      cancel_status: 'cancelled_late',
      sunday_date: '2026-07-19',
    })
    expect(text).toBe(
      '【教會停車】\n您好，7月19日 主日已核准的停車預約已為您取消，車位將釋出給候補的弟兄姊妹。\n\n若需重新申請請至報名系統，謝謝您。',
    )
  })

  it('reservation_cancelled (cancelled_by_user) matches the doc §三 B sign-off text exactly', () => {
    const text = renderTemplate('reservation_cancelled', {
      cancel_status: 'cancelled_by_user',
      sunday_date: '2026-07-19',
    })
    expect(text).toBe(
      '【教會停車】\n您好，7月19日 主日的停車申請／候補已為您取消。\n\n若需重新申請請至報名系統，謝謝您。',
    )
  })
})
