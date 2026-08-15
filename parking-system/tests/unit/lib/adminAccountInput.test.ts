import { describe, expect, it } from 'vitest'
import {
  isAdminRole,
  normalizeAdminDisplayName,
  normalizeAdminUsername,
  validateAdminPassword,
} from '@/lib/adminAccountInput'

// Wave 2C-2 (#19). These are the edge rules that turn a bad value into a typed 400
// instead of a raised 500 from the DB. The DB check + unique index remain authoritative;
// these must agree with them (admin_accounts_username_ck, 0025).

describe('normalizeAdminUsername', () => {
  it('trims and lowercases a legal username', () => {
    expect(normalizeAdminUsername('  Alice.01  ')).toBe('alice.01')
  })
  it.each([
    ['too short', 'ab'],
    ['too long', 'a'.repeat(33)],
    ['illegal char', 'alice!'],
    ['space inside', 'al ice'],
    ['non-string', 42],
    ['empty', '   '],
  ])('rejects %s → null', (_n, value) => {
    expect(normalizeAdminUsername(value)).toBeNull()
  })
})

describe('normalizeAdminDisplayName', () => {
  it('trims a name', () => {
    expect(normalizeAdminDisplayName('  王姐妹 ')).toEqual({ ok: true, value: '王姐妹' })
  })
  it('empty / whitespace / null / undefined → null value (the column is nullable)', () => {
    expect(normalizeAdminDisplayName('   ')).toEqual({ ok: true, value: null })
    expect(normalizeAdminDisplayName(null)).toEqual({ ok: true, value: null })
    expect(normalizeAdminDisplayName(undefined)).toEqual({ ok: true, value: null })
  })
  it('over 80 code points → not ok (rejects, never truncates)', () => {
    expect(normalizeAdminDisplayName('あ'.repeat(81))).toEqual({ ok: false })
  })
  it('exactly 80 is fine', () => {
    expect(normalizeAdminDisplayName('あ'.repeat(80))).toEqual({ ok: true, value: 'あ'.repeat(80) })
  })
  it('non-string → not ok', () => {
    expect(normalizeAdminDisplayName(42)).toEqual({ ok: false })
  })
})

describe('validateAdminPassword', () => {
  it('accepts ≥12 chars (returns null)', () => {
    expect(validateAdminPassword('a-long-enough-pw')).toBeNull()
  })
  it('rejects short or non-string', () => {
    expect(validateAdminPassword('short')).not.toBeNull()
    expect(validateAdminPassword(12345678901234)).not.toBeNull()
  })
})

describe('isAdminRole', () => {
  it('accepts the two implemented roles only', () => {
    expect(isAdminRole('superadmin')).toBe(true)
    expect(isAdminRole('clerk')).toBe(true)
  })
  it.each(['root', 'admin', 'viewer', '', 42, null, undefined])('rejects %s', value => {
    expect(isAdminRole(value)).toBe(false)
  })
})
