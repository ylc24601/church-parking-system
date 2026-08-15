import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveJobEventId } from '@/server/http/jobEventResolver'
import { asRepo, makeMockRepo, type MockRepo } from './mockRepo'

// Phase 9 Slice 1 — the shared eventId contract for the weekly job routes. Core rule:
// only a truly ABSENT eventId property falls back to server-side resolution; a
// present-but-invalid value is a 400 (a scheduler misconfiguration must stay visible).

const VALID_UUID = '3f2b8c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c'
// Taipei Monday 2026-07-13 (= 2026-07-12T16:00:00Z); taipeiToday = '2026-07-13'.
const NOW = new Date('2026-07-12T16:00:00Z')

describe('resolveJobEventId', () => {
  let repo: MockRepo

  beforeEach(() => {
    vi.clearAllMocks()
    repo = makeMockRepo({
      getUpcomingScheduledEvent: vi.fn(async () => ({
        id: 'resolved-event',
        sunday_date: '2026-07-19',
        status: 'open',
      })),
    })
  })

  it('passes an explicit well-formed eventId through without querying the DB', async () => {
    const resolved = await resolveJobEventId({ eventId: VALID_UUID }, { now: NOW, repo: asRepo(repo) })
    expect(resolved).toEqual({ ok: true, eventId: VALID_UUID })
    expect(repo.getUpcomingScheduledEvent).not.toHaveBeenCalled()
  })

  it('resolves the upcoming Sunday event when the property is truly absent', async () => {
    const resolved = await resolveJobEventId({}, { now: NOW, repo: asRepo(repo) })
    expect(resolved).toEqual({ ok: true, eventId: 'resolved-event' })
    expect(repo.getUpcomingScheduledEvent).toHaveBeenCalledOnce()
    expect(repo.getUpcomingScheduledEvent).toHaveBeenCalledWith('2026-07-13')
  })

  it('treats a missing/non-object body as absent (no body, parse failure, primitives)', async () => {
    for (const body of [null, undefined, 'eventId', 42]) {
      const resolved = await resolveJobEventId(body, { now: NOW, repo: asRepo(repo) })
      expect(resolved).toEqual({ ok: true, eventId: 'resolved-event' })
    }
  })

  it('400s on a present-but-invalid eventId instead of silently falling back', async () => {
    for (const eventId of ['', null, 123, 'not-a-uuid', `${VALID_UUID}x`, undefined]) {
      const resolved = await resolveJobEventId({ eventId }, { now: NOW, repo: asRepo(repo) })
      expect(resolved.ok).toBe(false)
      if (!resolved.ok) {
        expect(resolved.response.status).toBe(400)
        expect(await resolved.response.json()).toEqual({ ok: false, error: 'invalid eventId' })
      }
    }
    expect(repo.getUpcomingScheduledEvent).not.toHaveBeenCalled()
  })

  it('503s with upcoming_event_missing when no upcoming event exists', async () => {
    repo.getUpcomingScheduledEvent.mockResolvedValue(null)
    const resolved = await resolveJobEventId({}, { now: NOW, repo: asRepo(repo) })
    expect(resolved.ok).toBe(false)
    if (!resolved.ok) {
      expect(resolved.response.status).toBe(503)
      expect(await resolved.response.json()).toEqual({ ok: false, error: 'upcoming_event_missing' })
    }
  })
})
