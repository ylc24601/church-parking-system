import { randomInt } from 'node:crypto'

// Phase 5B — pure helpers for the binding CLI (code generation + masking for operator output).
// No I/O; unit-tested.

// Unambiguous alphabet — excludes 0/O, 1/I/L to avoid transcription errors when an operator
// reads a code to a member.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export const BINDING_CODE_FORMAT = /^[A-Z0-9-]{4,16}$/

// Random `XXXX-XXXX` (two 4-char groups, 9 chars) from the unambiguous alphabet — matches
// BINDING_CODE_FORMAT. Not a cryptographic secret: it is short-lived, single-use, and gated by
// admin approval; randomInt gives a non-biased pick over the alphabet.
export function generateBindingCode(): string {
  const group = () => Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('')
  return `${group()}-${group()}`
}

// Normalize an operator-supplied code the same way 5A capture does: trim + uppercase.
export function normalizeBindingCode(raw: string): string {
  return raw.trim().toUpperCase()
}

// left6…right4 — matches the masked display used in the runbooks. Never returns the full input:
// values too short to partially reveal safely collapse to a first-2 + mask form.
export function maskLineUserId(s: string): string {
  if (s.length <= 10) return `${s.slice(0, 2)}****`
  return `${s.slice(0, 6)}…${s.slice(-4)}`
}

// `ABCD-****` — show only the first group / first 4 characters, mask the rest.
export function maskCode(s: string): string {
  if (s.length <= 4) return '****'
  return `${s.slice(0, 4)}-****`
}

// `0912345678` → `0912***678` — enough for an operator to cross-check against member records
// without exposing the full number. Never returns the full input; non-canonical values collapse
// to a fully masked form.
export function maskPhone(s: string): string {
  if (!/^09\d{8}$/.test(s)) return '**********'
  return `${s.slice(0, 4)}***${s.slice(-3)}`
}
