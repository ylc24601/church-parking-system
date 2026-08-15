// Reads LINE_CHANNEL_ACCESS_TOKEN — machine-enforced server boundary (build-time error
// if a Client Component ever pulls this in). See lib/supabase/server.ts.
import 'server-only'

import { createHash } from 'node:crypto'

// Phase 4 Slice A — LINE push transport with EXPLICIT mode selection and TYPED failure
// classification. The dispatcher never silently falls back to a no-op: NOTIFICATION_TRANSPORT
// must be 'mock' or 'line', and 'line' without a channel token is a config error that fails
// fast (so a misconfigured prod run can never mark rows sent without delivering).

export interface PushOptions {
  // Idempotency key sent to LINE as X-Line-Retry-Key; guards the rare expired-lease double
  // send. Derived deterministically from the outbox dedupe_key (see deriveRetryKey).
  retryKey: string
}

export interface LineTransport {
  push(lineUserId: string, text: string, opts: PushOptions): Promise<void>
}

// ── Typed errors ──────────────────────────────────────────────────────────────
// Every error carries a *sanitized* `code` (e.g. 'http_429', 'terminal_403'). The service
// persists ONLY this code in last_error — never a raw LINE body, message text, or line_id.

// Row-level, worth retrying later (network blip, LINE 429/5xx). → row 'retrying'.
export class TransportRetryableError extends Error {
  constructor(public readonly code: string) {
    super(code)
    this.name = 'TransportRetryableError'
  }
}

// Row-level, terminal (bad recipient / blocked — LINE 400/403). → row 'failed', no retry.
export class TransportTerminalError extends Error {
  constructor(public readonly code: string) {
    super(code)
    this.name = 'TransportTerminalError'
  }
}

// System/config fault (missing/invalid token, LINE 401). NOT the row's fault: the service
// aborts the batch and touches no already-claimed row (lease expiry recovers them later).
export class TransportConfigError extends Error {
  constructor(public readonly code: string) {
    super(code)
    this.name = 'TransportConfigError'
  }
}

// ── Retry-key derivation ────────────────────────────────────────────────────────
// LINE's X-Line-Retry-Key must be a UUID-shaped string. Derive one deterministically from
// the dedupe_key (SHA-256 → first 16 bytes → set v4 version/variant bits) so the same row
// always yields the same key and LINE dedupes a double send. Deterministic-by-design.
export function deriveRetryKey(dedupeKey: string): string {
  const h = createHash('sha256').update(dedupeKey).digest()
  const b = Buffer.from(h.subarray(0, 16))
  b[6] = (b[6] & 0x0f) | 0x40 // version 4
  b[8] = (b[8] & 0x3f) | 0x80 // variant 10xx
  const hex = b.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

// ── Mock transport (dev/CI default) ─────────────────────────────────────────────
// No-op success. Tests that need to observe/steer behaviour (slow push, forced failure)
// construct their own LineTransport and inject it into dispatchNotifications directly.
export const mockLineTransport: LineTransport = {
  async push() {
    /* no-op: pretend the message was delivered */
  },
}

// ── Real LINE Messaging API transport ────────────────────────────────────────────
const LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push'
const PUSH_TIMEOUT_MS = 10_000

export function httpLineTransport(token: string): LineTransport {
  return {
    async push(lineUserId, text, opts) {
      let res: Response
      try {
        res = await fetch(LINE_PUSH_URL, {
          method: 'POST',
          cache: 'no-store',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'X-Line-Retry-Key': opts.retryKey,
          },
          body: JSON.stringify({ to: lineUserId, messages: [{ type: 'text', text }] }),
          signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
        })
      } catch {
        // Network error / timeout — transient, retry later. Never surface the raw cause.
        throw new TransportRetryableError('network_error')
      }
      if (res.ok) return
      const s = res.status
      if (s === 401) throw new TransportConfigError('http_401')      // bad channel token → system fault
      if (s === 429 || s >= 500) throw new TransportRetryableError(`http_${s}`)
      // 400 (invalid recipient) / 403 (blocked / not a friend) / other 4xx → terminal.
      throw new TransportTerminalError(`terminal_${s}`)
    },
  }
}

// Production runtime signal (Phase 4 Slice C). VERCEL_ENV is authoritative on Vercel;
// otherwise fall back to NODE_ENV. Preview/dev deploys are NOT production.
export function isProductionRuntime(): boolean {
  const vercelEnv = process.env.VERCEL_ENV
  if (vercelEnv) return vercelEnv === 'production'
  return process.env.NODE_ENV === 'production'
}

// ── Explicit mode selection (no silent fallback) ─────────────────────────────────
export function getLineTransport(): LineTransport {
  const mode = process.env.NOTIFICATION_TRANSPORT
  if (mode === 'mock') {
    // A production deploy must never silently no-op real notifications.
    if (isProductionRuntime()) throw new TransportConfigError('mock_in_production')
    return mockLineTransport
  }
  if (mode === 'line') {
    const token = process.env.LINE_CHANNEL_ACCESS_TOKEN
    if (!token || token.trim() === '') throw new TransportConfigError('missing_line_token')
    return httpLineTransport(token)
  }
  // Unset or unknown: fail fast rather than guess — a prod run must never silently no-op.
  throw new TransportConfigError('invalid_transport_mode')
}
