import { describe, expect, it } from 'vitest'
import { deriveWeekStage, WEEK_STAGE_LABEL, type WeekStage } from '@/lib/weekStage'

describe('deriveWeekStage', () => {
  it('null status → no_event (no weekly_events row yet)', () => {
    expect(deriveWeekStage(null, false)).toBe('no_event')
    expect(deriveWeekStage(null, true)).toBe('no_event')
  })

  it('open + allocation not run → application_open', () => {
    expect(deriveWeekStage('open', false)).toBe('application_open')
  })

  it('open + allocation run → allocated (status stays open, the flag carries the boundary)', () => {
    expect(deriveWeekStage('open', true)).toBe('allocated')
  })

  it('finalized / closed ignore the allocation flag', () => {
    expect(deriveWeekStage('finalized', false)).toBe('finalized')
    expect(deriveWeekStage('finalized', true)).toBe('finalized')
    expect(deriveWeekStage('closed', false)).toBe('closed')
    expect(deriveWeekStage('closed', true)).toBe('closed')
  })

  it('every stage has a label', () => {
    const stages: WeekStage[] = ['no_event', 'application_open', 'allocated', 'finalized', 'closed']
    for (const s of stages) expect(WEEK_STAGE_LABEL[s]).toBeTruthy()
  })
})
