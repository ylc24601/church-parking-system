import { describe, expect, it } from 'vitest'
import { csvUploadPreflight, readCsvBody } from '@/server/http/csvUpload'

const URL = 'http://localhost/api/admin/members/import/preview'

function req(body: BodyInit | null, headers: Record<string, string>, init: RequestInit & { duplex?: 'half' } = {}): Request {
  return new Request(URL, { method: 'POST', headers, body, ...init } as RequestInit & { duplex?: string })
}

function headerReq(headers: Record<string, string>): Request {
  return new Request(URL, { method: 'POST', headers })
}

const bytesN = (n: number) => new Uint8Array(n).fill(0x61) // 'a'

async function statusOf(r: { ok: true } | { ok: false; response: Response }): Promise<number | 'ok'> {
  return r.ok ? 'ok' : r.response.status
}
async function reasonOf(r: { ok: boolean; response?: Response }): Promise<string> {
  if (r.ok) return 'ok'
  return (await (r as { response: Response }).response.json()).reason
}

describe('csvUploadPreflight — header-only (runs before auth, no body access)', () => {
  it('accepts text/csv and text/csv; charset=utf-8', () => {
    expect(csvUploadPreflight(headerReq({ 'content-type': 'text/csv' }), 1024).ok).toBe(true)
    expect(csvUploadPreflight(headerReq({ 'content-type': 'text/csv; charset=utf-8' }), 1024).ok).toBe(true)
  })

  it('rejects a non-csv MIME even when the string contains "csv"', async () => {
    const r = csvUploadPreflight(headerReq({ 'content-type': 'application/not-text/csv-evil' }), 1024)
    expect(await statusOf(r)).toBe(415)
  })

  it('rejects a missing content-type', async () => {
    expect(await statusOf(csvUploadPreflight(headerReq({}), 1024))).toBe(415)
  })

  it('rejects an over-cap declared Content-Length → 413', async () => {
    const r = csvUploadPreflight(headerReq({ 'content-type': 'text/csv', 'content-length': '5000' }), 1024)
    expect(await statusOf(r)).toBe(413)
  })

  it('a foreign Origin → 403 (before any body work)', async () => {
    const r = csvUploadPreflight(headerReq({ 'content-type': 'text/csv', origin: 'https://evil.example' }), 1024)
    expect(await statusOf(r)).toBe(403)
  })
})

describe('readCsvBody — bounded size (real cap, not Content-Length trust)', () => {
  it('exactly maxBytes passes; maxBytes+1 → 413', async () => {
    expect(await statusOf(await readCsvBody(req(bytesN(10), { 'content-type': 'text/csv' }), 10))).toBe('ok')
    expect(await statusOf(await readCsvBody(req(bytesN(11), { 'content-type': 'text/csv' }), 10))).toBe(413)
  })

  // readCsvBody only touches request.body, so a minimal fake lets us observe the reader
  // cancel WITHOUT a real Request wrapping/buffering the stream.
  const fakeReq = (body: ReadableStream<Uint8Array>) => ({ body } as unknown as Request)

  it('an over-cap stream → 413 and cancels the underlying stream (stops the transfer)', async () => {
    let canceled = false
    // Lazily produces 4-byte chunks forever; must be cancelled once the cap is passed.
    const body = new ReadableStream<Uint8Array>({
      pull(c) { c.enqueue(bytesN(4)) },
      cancel() { canceled = true },
    })
    const r = await readCsvBody(fakeReq(body), 10)
    expect(await statusOf(r)).toBe(413)
    expect(canceled).toBe(true)
  })

  it('a read error returns 400 without throwing', async () => {
    const body = new ReadableStream<Uint8Array>({ pull() { throw new Error('boom') } })
    const r = await readCsvBody(fakeReq(body), 1024)
    expect(await statusOf(r)).toBe(400)
  })

  it('an empty body → 400 empty', async () => {
    const body = new ReadableStream<Uint8Array>({ start(c) { c.close() } })
    const r = await readCsvBody(fakeReq(body), 1024)
    expect(await reasonOf(r)).toBe('empty')
  })

  it('invalid UTF-8 → 400 invalid_encoding (no silent replacement)', async () => {
    const bad = new Uint8Array([0x61, 0xff, 0xfe, 0x62])
    const r = await readCsvBody(req(bad, { 'content-type': 'text/csv' }), 1024)
    expect(await reasonOf(r)).toBe('invalid_encoding')
  })

  it('valid UTF-8 (incl. CJK) decodes', async () => {
    const r = await readCsvBody(req('姓名,電話\n王,0912345678', { 'content-type': 'text/csv' }), 1024)
    expect(r.ok && r.text.startsWith('姓名')).toBe(true)
  })
})
