import { describe, expect, it } from 'vitest'
import {
  BINDING_CODE_FORMAT,
  generateBindingCode,
  maskCode,
  maskLineUserId,
  maskPhone,
  normalizeBindingCode,
} from '@/lib/binding'

describe('generateBindingCode', () => {
  it('produces XXXX-XXXX in the accepted format, from the unambiguous alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateBindingCode()
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/) // no 0 O 1 I L
      expect(code).toMatch(BINDING_CODE_FORMAT)
    }
  })

  it('is random (not constant)', () => {
    const set = new Set(Array.from({ length: 50 }, () => generateBindingCode()))
    expect(set.size).toBeGreaterThan(1)
  })
})

describe('normalizeBindingCode', () => {
  it('trims and uppercases', () => {
    expect(normalizeBindingCode('  abcd-2345 ')).toBe('ABCD-2345')
  })
})

describe('maskLineUserId', () => {
  it('reveals only left6…right4 for a real-length userId and never the full value', () => {
    const id = 'Udeadbeefdeadbeefdeadbeefdeadbeef'
    const masked = maskLineUserId(id)
    expect(masked).toBe('Udeadb…beef')
    expect(masked).not.toBe(id)
    expect(id).not.toContain(masked) // the … breaks the original string
  })

  it('collapses too-short values instead of revealing them whole', () => {
    expect(maskLineUserId('U12345')).toBe('U1****')
  })
})

describe('maskCode', () => {
  it('shows first 4 then masks the rest', () => {
    expect(maskCode('ABCD-2345')).toBe('ABCD-****')
    expect(maskCode('WXYZ-2345')).toBe('WXYZ-****')
  })
  it('fully masks very short codes', () => {
    expect(maskCode('AB')).toBe('****')
  })
})

describe('maskPhone', () => {
  it('shows prefix 4 + last 3 of a canonical TW mobile', () => {
    const masked = maskPhone('0912345678')
    expect(masked).toBe('0912***678')
    expect(masked).not.toContain('45')
  })
  it('fully masks non-canonical input instead of partially revealing it', () => {
    expect(maskPhone('0912-345-678')).toBe('**********')
    expect(maskPhone('12345')).toBe('**********')
    expect(maskPhone('')).toBe('**********')
  })
})
