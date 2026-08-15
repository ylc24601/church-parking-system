import { createHmac, timingSafeEqual } from 'node:crypto'

// Phase 5A — verify a LINE webhook request's `x-line-signature`. LINE signs the request with
// HMAC-SHA256 over the RAW request body using the channel secret, base64-encoded. The caller MUST
// pass the raw body string (read before any JSON parse) — signing a re-serialized object would not
// match. Fails closed: a missing secret (misconfigured deploy), missing header, or any mismatch is
// never a pass, so nothing is written to the DB on a bad/absent signature.
export function verifyLineSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  channelSecret: string | undefined,
): boolean {
  if (!channelSecret || !signatureHeader) return false

  const expected = createHmac('sha256', channelSecret).update(rawBody, 'utf8').digest()
  let provided: Buffer
  try {
    provided = Buffer.from(signatureHeader, 'base64')
  } catch {
    return false
  }
  if (provided.length !== expected.length) return false
  return timingSafeEqual(provided, expected)
}
