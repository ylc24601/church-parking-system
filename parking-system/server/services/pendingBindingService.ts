import { createParkingRepository, type ParkingRepository } from '@/server/repositories/parkingRepository'

// Phase 5A — turn a verified LINE webhook payload into pending binding claims. Capture-only:
// it never replies, pushes, broadcasts, or writes users.line_id. Only an explicit binding
// command from a text message creates a claim:
//   `綁定 <code>` / `bind <code>` / `BIND <code>`
// The code is normalized (trim + uppercase) and must match the bounded format below. Follow
// events are counted for auditing but never create a claim. Everything else is ignored. The
// returned summary is counts-only; no userId / code / message text is ever logged or returned.

export interface WebhookSummary {
  captured: number    // pending claims written (insert or upsert)
  superseded: number  // subset of `captured` that updated an existing active claim
  ignored: number     // text messages that were not a valid binding command
  follows: number     // follow events (audited only, no claim)
  unsupported: number // other event types we do not handle
}

const BIND_COMMAND = /^(?:綁定|bind)\s+(.+)$/i
const CODE_FORMAT = /^[A-Z0-9-]{4,16}$/

// Returns the normalized code iff `text` is a well-formed binding command, else null. Exported
// for unit testing — no I/O, no side effects.
export function parseBindCode(text: string): string | null {
  const m = BIND_COMMAND.exec(text.trim())
  if (!m) return null
  const code = m[1].trim().toUpperCase()
  return CODE_FORMAT.test(code) ? code : null
}

interface LineEventLike {
  type?: unknown
  message?: { type?: unknown; text?: unknown } | null
  source?: { type?: unknown; userId?: unknown } | null
}

function extractUserId(source: LineEventLike['source']): string | null {
  if (source && source.type === 'user' && typeof source.userId === 'string' && source.userId.length > 0) {
    return source.userId
  }
  return null
}

export async function processWebhookEvents(
  body: unknown,
  nowIso: string,
  repo: ParkingRepository = createParkingRepository(),
): Promise<WebhookSummary> {
  const summary: WebhookSummary = { captured: 0, superseded: 0, ignored: 0, follows: 0, unsupported: 0 }
  const events = (body as { events?: unknown } | null)?.events
  if (!Array.isArray(events)) return summary

  for (const raw of events) {
    const ev = raw as LineEventLike
    if (ev?.type === 'follow') {
      summary.follows++
      continue
    }
    if (
      ev?.type === 'message' &&
      ev.message &&
      ev.message.type === 'text' &&
      typeof ev.message.text === 'string'
    ) {
      const code = parseBindCode(ev.message.text)
      const userId = extractUserId(ev.source)
      if (code && userId) {
        const res = await repo.capturePendingBinding({ lineUserId: userId, code, eventType: 'message', nowIso })
        summary.captured += res.captured
        if (res.superseded) summary.superseded++
      } else {
        summary.ignored++
      }
      continue
    }
    summary.unsupported++
  }
  return summary
}
