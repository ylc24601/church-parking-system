import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  deriveRetryKey,
  getLineTransport,
  httpLineTransport,
  mockLineTransport,
  TransportConfigError,
  TransportRetryableError,
  TransportTerminalError,
} from '@/server/services/notification/lineTransport'

const OPTS = { retryKey: 'k' }

describe('getLineTransport — explicit mode, no silent fallback', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
  })

  it('returns the mock transport when NOTIFICATION_TRANSPORT=mock', () => {
    process.env.NOTIFICATION_TRANSPORT = 'mock'
    expect(getLineTransport()).toBe(mockLineTransport)
  })

  it('returns an http transport when =line and a token is present', () => {
    process.env.NOTIFICATION_TRANSPORT = 'line'
    process.env.LINE_CHANNEL_ACCESS_TOKEN = 'tok'
    expect(getLineTransport()).not.toBe(mockLineTransport)
  })

  it('throws TransportConfigError when =line but the token is missing/blank', () => {
    process.env.NOTIFICATION_TRANSPORT = 'line'
    process.env.LINE_CHANNEL_ACCESS_TOKEN = '   '
    expect(() => getLineTransport()).toThrow(TransportConfigError)
  })

  it('throws TransportConfigError when the mode is unset or unknown (never guesses)', () => {
    delete process.env.NOTIFICATION_TRANSPORT
    expect(() => getLineTransport()).toThrow(TransportConfigError)
    process.env.NOTIFICATION_TRANSPORT = 'whatever'
    expect(() => getLineTransport()).toThrow(TransportConfigError)
  })

  it('refuses mock in a production runtime (never silently no-ops in prod)', () => {
    process.env.NOTIFICATION_TRANSPORT = 'mock'
    process.env.VERCEL_ENV = 'production'
    expect(() => getLineTransport()).toThrow(/mock_in_production/)
    // preview/dev deploys are NOT production → mock allowed
    process.env.VERCEL_ENV = 'preview'
    expect(getLineTransport()).toBe(mockLineTransport)
  })

  it('falls back to NODE_ENV when VERCEL_ENV is unset (prod + mock refused)', () => {
    delete process.env.VERCEL_ENV
    ;(process.env as Record<string, string | undefined>).NODE_ENV = 'production'
    process.env.NOTIFICATION_TRANSPORT = 'mock'
    expect(() => getLineTransport()).toThrow(/mock_in_production/)
  })

  it('allows line transport in production when a token is present', () => {
    process.env.VERCEL_ENV = 'production'
    process.env.NOTIFICATION_TRANSPORT = 'line'
    process.env.LINE_CHANNEL_ACCESS_TOKEN = 'tok'
    expect(getLineTransport()).not.toBe(mockLineTransport)
  })
})

describe('deriveRetryKey', () => {
  it('is deterministic and UUID-shaped (v4)', () => {
    const a = deriveRetryKey('offer:rid:2026-06-20T00:00:00Z')
    const b = deriveRetryKey('offer:rid:2026-06-20T00:00:00Z')
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('differs for different dedupe keys', () => {
    expect(deriveRetryKey('a')).not.toBe(deriveRetryKey('b'))
  })
})

describe('httpLineTransport — typed failure classification', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })
  afterEach(() => vi.unstubAllGlobals())

  const tx = () => httpLineTransport('tok')

  it('resolves on a 2xx and sends the retry key + bearer token', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }))
    await expect(tx().push('U1', 'hi', { retryKey: 'rk-1' })).resolves.toBeUndefined()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain('api.line.me')
    expect((init.headers as Record<string, string>)['X-Line-Retry-Key']).toBe('rk-1')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
  })

  it('classifies 429 and 5xx as retryable', async () => {
    for (const status of [429, 500, 503]) {
      fetchMock.mockResolvedValue(new Response(null, { status }))
      await expect(tx().push('U1', 'hi', OPTS)).rejects.toBeInstanceOf(TransportRetryableError)
    }
  })

  it('classifies a network throw as retryable (without leaking the cause)', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET at 10.0.0.1'))
    await expect(tx().push('U1', 'hi', OPTS)).rejects.toMatchObject({ code: 'network_error' })
  })

  it('classifies 400 and 403 as terminal (no retry)', async () => {
    for (const status of [400, 403]) {
      fetchMock.mockResolvedValue(new Response(null, { status }))
      await expect(tx().push('U1', 'hi', OPTS)).rejects.toBeInstanceOf(TransportTerminalError)
    }
  })

  it('classifies 401 (bad channel token) as a config error', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }))
    await expect(tx().push('U1', 'hi', OPTS)).rejects.toBeInstanceOf(TransportConfigError)
  })

  it('never puts a raw response body in the error code', async () => {
    fetchMock.mockResolvedValue(new Response('{"message":"secret internal detail"}', { status: 500 }))
    await expect(tx().push('U1', 'hi', OPTS)).rejects.toMatchObject({ code: 'http_500' })
  })
})
