import { describe, expect, it } from 'vitest'
import { hashPin, verifyPin } from '@/server/http/pinHash'

describe('pinHash (scrypt)', () => {
  it('verifies a correct PIN round-trip', () => {
    const stored = hashPin('246810')
    expect(stored.startsWith('scrypt$')).toBe(true)
    expect(verifyPin('246810', stored)).toBe(true)
  })

  it('rejects a wrong PIN', () => {
    expect(verifyPin('000000', hashPin('246810'))).toBe(false)
  })

  it('uses a random salt — the same PIN hashes differently each time', () => {
    expect(hashPin('246810')).not.toBe(hashPin('246810'))
  })

  it('returns false for malformed stored values (never throws)', () => {
    expect(verifyPin('246810', '')).toBe(false)
    expect(verifyPin('246810', 'bogus')).toBe(false)
    expect(verifyPin('246810', 'bcrypt$aa$bb')).toBe(false)
    expect(verifyPin('246810', 'scrypt$$')).toBe(false)
  })
})
