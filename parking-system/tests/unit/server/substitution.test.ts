import { describe, expect, it } from 'vitest'
import { buildReleaseDeadlines, buildSundayMidnight } from '@/lib/allocation/release'
import { triggerSubstitution } from '@/lib/allocation/substitute'
import { buildSubstitutePayloadAndOutbox } from '@/server/services/substitution'
import { makeReservation } from '../allocation/helpers'

const SUNDAY = '2026-06-21'
const midnight = buildSundayMidnight(SUNDAY) // 2026-06-20T16:00:00Z
const deadlines = buildReleaseDeadlines(SUNDAY)

describe('buildSubstitutePayloadAndOutbox', () => {
  it('temp offer: last_offer_at=now, deadline null, dedupe key uses last_offer_at', () => {
    const w = makeReservation({ status: 'waiting', effective_priority: 3 })
    const now = new Date('2026-06-20T13:00:00Z') // +2h = 15:00 < midnight → uncapped
    const sub = triggerSubstitution([w], now, midnight)!
    const { payload, outbox } = buildSubstitutePayloadAndOutbox(sub, now, deadlines)

    expect(payload.status).toBe('temp_approved')
    expect(payload.last_offer_at).toBe(now.toISOString())
    expect(payload.offer_expires_at).toBe(new Date('2026-06-20T15:00:00Z').toISOString())
    expect(payload.release_deadline_at).toBeNull()
    expect(outbox[0].template_key).toBe('offer_2hr_confirm')
    expect(outbox[0].dedupe_key).toBe(`offer:${w.id}:${now.toISOString()}`)
  })

  it('two offers with the SAME capped offer_expires_at but different last_offer_at → distinct keys', () => {
    const w = makeReservation({ status: 'waiting', effective_priority: 3 })
    const now1 = new Date('2026-06-20T15:00:00Z') // +2h ≥ midnight → capped at midnight
    const now2 = new Date('2026-06-20T15:30:00Z')
    const s1 = triggerSubstitution([w], now1, midnight)!
    const s2 = triggerSubstitution([w], now2, midnight)!

    expect(s1.reservation.offer_expires_at!.toISOString()).toBe(midnight.toISOString())
    expect(s2.reservation.offer_expires_at!.toISOString()).toBe(midnight.toISOString())

    const k1 = buildSubstitutePayloadAndOutbox(s1, now1, deadlines).outbox[0].dedupe_key
    const k2 = buildSubstitutePayloadAndOutbox(s2, now2, deadlines).outbox[0].dedupe_key
    expect(k1).not.toBe(k2)
  })

  it('direct approved (after midnight): stamps approved_at + release_deadline_at, key uses approved_at', () => {
    const w = makeReservation({ status: 'waiting', effective_priority: 2 })
    const now = new Date('2026-06-20T16:01:00Z')
    const sub = triggerSubstitution([w], now, midnight)!
    const { payload, outbox } = buildSubstitutePayloadAndOutbox(sub, now, deadlines)

    expect(payload.status).toBe('approved')
    expect(payload.approved_at).toBe(now.toISOString())
    expect(payload.release_deadline_at).toBe(deadlines.p2.toISOString())
    expect(payload.last_offer_at).toBeNull()
    expect(outbox[0].dedupe_key).toBe(`approved:${w.id}:${now.toISOString()}`)
  })
})
