import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifyLineSignature } from '@/server/http/lineSignature'

const SECRET = 'test-channel-secret'
const sign = (body: string, secret = SECRET) =>
  createHmac('sha256', secret).update(body, 'utf8').digest('base64')

describe('verifyLineSignature', () => {
  const body = JSON.stringify({ events: [{ type: 'follow' }] })

  it('accepts a signature computed over the exact raw body with the channel secret', () => {
    expect(verifyLineSignature(body, sign(body), SECRET)).toBe(true)
  })

  it('rejects a signature for a different body (tamper)', () => {
    expect(verifyLineSignature(body + ' ', sign(body), SECRET)).toBe(false)
  })

  it('rejects a signature made with the wrong secret', () => {
    expect(verifyLineSignature(body, sign(body, 'other-secret'), SECRET)).toBe(false)
  })

  it('fails closed on a missing secret or missing header', () => {
    expect(verifyLineSignature(body, sign(body), undefined)).toBe(false)
    expect(verifyLineSignature(body, null, SECRET)).toBe(false)
    expect(verifyLineSignature(body, '', SECRET)).toBe(false)
  })

  it('rejects a malformed (non-base64 length) signature without throwing', () => {
    expect(verifyLineSignature(body, 'not-a-real-signature', SECRET)).toBe(false)
  })
})
