import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureUpcomingWeeklyEvent } from '@/server/services/ensureWeeklyEventService'
import { asRepo, makeMockRepo, type MockRepo } from './mockRepo'

// Phase 9 Slice 1 — the daily "upcoming Sunday's event exists" job. Target-Sunday
// derivation and explicit-Sunday validation live here; the actual do-nothing-on-conflict
// idempotency is the repository's (DB tests cover it).

// Taipei Monday 2026-07-13 00:00 = 2026-07-12T16:00:00Z; that week's Sunday is 07-19.
const MONDAY_NOW = new Date('2026-07-12T16:00:00Z')

describe('ensureUpcomingWeeklyEvent', () => {
  let repo: MockRepo

  beforeEach(() => {
    vi.clearAllMocks()
    repo = makeMockRepo({
      ensureWeeklyEvent: vi.fn(async (sunday: string) => ({
        created: true,
        event: { id: 'event-9', sunday_date: sunday, status: 'open' },
      })),
    })
  })

  it('targets the upcoming Taipei Sunday when no explicit sunday is given', async () => {
    const summary = await ensureUpcomingWeeklyEvent({ now: MONDAY_NOW }, asRepo(repo))
    expect(repo.ensureWeeklyEvent).toHaveBeenCalledWith('2026-07-19')
    expect(summary).toEqual({ created: true, eventId: 'event-9', sundayDate: '2026-07-19', status: 'open' })
  })

  it('maps created=false (row already existed) through to the summary', async () => {
    repo.ensureWeeklyEvent.mockResolvedValue({
      created: false,
      event: { id: 'event-old', sunday_date: '2026-07-19', status: 'open' },
    })
    const summary = await ensureUpcomingWeeklyEvent({ now: MONDAY_NOW }, asRepo(repo))
    expect(summary.created).toBe(false)
    expect(summary.eventId).toBe('event-old')
  })

  it('accepts an explicit future Sunday (CLI pre-creation)', async () => {
    await ensureUpcomingWeeklyEvent({ now: MONDAY_NOW, sunday: '2026-08-02' }, asRepo(repo))
    expect(repo.ensureWeeklyEvent).toHaveBeenCalledWith('2026-08-02')
  })

  it('accepts today itself when today is that Sunday (Taipei)', async () => {
    // Taipei Sunday 2026-07-19 08:00 = 2026-07-19T00:00:00Z.
    const sundayNow = new Date('2026-07-19T00:00:00Z')
    await ensureUpcomingWeeklyEvent({ now: sundayNow, sunday: '2026-07-19' }, asRepo(repo))
    expect(repo.ensureWeeklyEvent).toHaveBeenCalledWith('2026-07-19')
  })

  it('rejects a malformed or impossible date without touching the repo', async () => {
    for (const sunday of ['2026-7-19', '19-07-2026', 'abc', '2026-07-32', '2026-02-30', '']) {
      await expect(ensureUpcomingWeeklyEvent({ now: MONDAY_NOW, sunday }, asRepo(repo))).rejects.toThrow(
        'invalid_sunday_format',
      )
    }
    expect(repo.ensureWeeklyEvent).not.toHaveBeenCalled()
  })

  it('rejects a valid date that is not a Sunday', async () => {
    await expect(
      ensureUpcomingWeeklyEvent({ now: MONDAY_NOW, sunday: '2026-07-18' }, asRepo(repo)), // Saturday
    ).rejects.toThrow('not_a_sunday')
    expect(repo.ensureWeeklyEvent).not.toHaveBeenCalled()
  })

  it('rejects a past Sunday (Taipei calendar)', async () => {
    await expect(
      ensureUpcomingWeeklyEvent({ now: MONDAY_NOW, sunday: '2026-07-12' }, asRepo(repo)), // yesterday's Sunday
    ).rejects.toThrow('sunday_in_past')
    expect(repo.ensureWeeklyEvent).not.toHaveBeenCalled()
  })
})
