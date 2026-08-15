import { guardAdminOrigin } from '@/server/http/adminRequestGuard'

// ── Admin CSV upload reader (Phase 8 Slice 5) ────────────────────────────────
// The member-import upload can't use guardAdminPost (JSON-only, 4KB). It is split into
// two stages so an UNAUTHENTICATED request never makes us read/buffer/decode the body:
//   1. csvUploadPreflight — cheap header-only checks (Origin / Content-Type / declared
//      Content-Length). No body access. Safe to run before authentication.
//   2. readCsvBody — the actual bounded stream read + strict UTF-8 decode. The caller
//      MUST authenticate between the two, so only a logged-in admin ever reaches here.
// readCsvBody drains request.body through a reader and aborts the moment the accumulated
// size exceeds maxBytes (Content-Length is not trusted as the limit), then strictly
// UTF-8 decodes (fatal) so invalid encoding is a clean 400, not silent U+FFFD.

const NO_STORE = { 'cache-control': 'no-store' }

export type PreflightResult = { ok: true } | { ok: false; response: Response }
export type CsvBodyResult =
  | { ok: true; bytes: Uint8Array; text: string }
  | { ok: false; response: Response }

function refuse(reason: string, status: number): { ok: false; response: Response } {
  return { ok: false, response: Response.json({ ok: false, reason }, { status, headers: NO_STORE }) }
}

// Exact MIME match (ignore parameters like "; charset=utf-8"); never a substring test.
function isCsvContentType(header: string | null): boolean {
  if (!header) return false
  const mime = header.split(';')[0].trim().toLowerCase()
  return mime === 'text/csv'
}

// Header-only checks — no body access, cheap enough to run before authentication.
export function csvUploadPreflight(request: Request, maxBytes: number): PreflightResult {
  const originRefusal = guardAdminOrigin(request)
  if (originRefusal) return { ok: false, response: originRefusal }

  if (!isCsvContentType(request.headers.get('content-type'))) {
    return refuse('unsupported_media_type', 415)
  }
  // Early exit when the declared length is already over the cap (cheap; the real guard
  // is the streaming cap below, since Content-Length may be missing or dishonest).
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) {
    return refuse('payload_too_large', 413)
  }
  return { ok: true }
}

// Reads and decodes the body with a hard byte cap. MUST be called only AFTER the caller
// has authenticated (see the module note) — this is the expensive step.
export async function readCsvBody(request: Request, maxBytes: number): Promise<CsvBodyResult> {
  if (!request.body) return refuse('empty', 400)

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {}) // stop the transfer; don't buffer the rest
        return refuse('payload_too_large', 413)
      }
      chunks.push(value)
    }
  } catch {
    await reader.cancel().catch(() => {})
    return refuse('invalid_request', 400)
  }

  if (total === 0) return refuse('empty', 400)

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    bytes.set(c, offset)
    offset += c.byteLength
  }

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return refuse('invalid_encoding', 400)
  }

  return { ok: true, bytes, text }
}
