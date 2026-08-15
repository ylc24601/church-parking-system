import { describe, expect, it } from 'vitest'
import { parsePage } from '@/app/admin/members/parsePage'

// Wave 1c (#5A) — ?page= is public input. Only a plain positive safe integer is a page; everything
// else falls back to 1 rather than producing a fractional/overflowing offset or a 500.
describe('parsePage', () => {
  it.each([
    ['3', 3],
    ['1', 1],
    ['007', 7],           // leading zeros are still a plain integer
    ['25', 25],
  ])('accepts %s → %i', (raw, expected) => {
    expect(parsePage(raw)).toBe(expected)
  })

  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['zero', '0'],
    ['negative', '-1'],
    ['fractional', '1.5'],
    ['exponent', '1e3'],
    ['Infinity', 'Infinity'],
    ['NaN text', 'abc'],
    ['whitespace', ' 2 '],
    ['injection-ish', '1; drop'],
    // digits, but too large to be a safe integer (and thus to page with)
    ['beyond MAX_SAFE_INTEGER', '9007199254740993'],
    ['absurdly long', '9'.repeat(40)],
  ])('rejects %s → 1', (_label, raw) => {
    expect(parsePage(raw as string | undefined)).toBe(1)
  })

  it('rejects repeated params (?page=1&page=2 arrives as an array)', () => {
    expect(parsePage(['1', '2'])).toBe(1)
  })
})
