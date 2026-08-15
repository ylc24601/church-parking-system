import { RELEASE_TIMES } from '@/lib/allocation/rules'
import { memberSundayLabel, releaseTimeLabel } from '@/lib/memberLabels'
import type { NotificationTemplate } from '@/lib/types'

// Phase 4 Slice A — render an outbox row's stored template_key + payload_json into the LINE
// message text. Reads ONLY the payload already persisted on the row; never re-reads member /
// penalty / pastoral tables. Church-tone, short, phone-readable (LINE push).
//
// Covers the keys actually enqueued today (allocate / substitute / release / p2 reminder).
// An unknown key throws → the dispatcher marks that one row failed (render_error), it does
// not crash the batch. Settlement deliberately enqueues nothing (pastoral notify deferred).
//
// COPY RULE (triage #25): member-facing templates must NOT ask the member to "回覆" (reply) to
// act — the LINE webhook is capture-only (§6.19) and silently drops replies, so any reply
// instruction is a dead command. Route every member action to the member page instead
// (offer confirm / on-the-way live in app/member/MemberStatus.tsx). A live tappable deep-link
// back to that page is the proper fix (#26); this file only carries the interim text pointer.
//
// LAYOUT (triage #27): sections separated by blank lines, deadline on its own ⏰ line. triage
// asked for a BOLD deadline — LINE text messages have no bold/markdown (lineTransport sends
// { type: 'text' }), so emphasis comes from position and whitespace instead. Real bold would
// mean Flex messages: a different transport contract and a rewrite of every renderer here.
//
// The week and the car arrive in the payload, stamped at enqueue time by
// ./context (withNotificationContext) — see there for which templates get which.

type Payload = Record<string, unknown>

function taipeiTime(iso: unknown): string {
  if (typeof iso !== 'string') return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d)
}

// Join the sections a message actually has. Templates differ — an approval carries no deadline —
// so building each one from a fixed skeleton would leave blank gaps where a section is missing.
function joinSections(...parts: Array<string | null>): string {
  return parts.filter((p): p is string => !!p).join('\n\n')
}

// 'YYYY-MM-DD' → '7月19日 主日'. Falls back to 「本週」 when the payload has no usable date —
// vaguer, but never wrong, and the same wording these templates used before the date existed.
function sundayText(p: Payload): string {
  return memberSundayLabel(p.sunday_date) ?? '本週'
}

// The plate line, or nothing at all. Here the plate is supplementary: when it's missing, saying
// so ("（車牌未提供）") would be noise. move_car_request is the exception below — that message
// exists to identify a car, so it keeps its explicit fallback.
function plateLine(p: Payload): string | null {
  const plate = typeof p.license_plate === 'string' && p.license_plate ? p.license_plate : null
  return plate ? `車牌：${plate}` : null
}

// 【教會停車】 is a SENDER label, in the Taiwanese SMS/LINE convention (【中華電信】您的帳單…) —
// not a person being addressed. It gets its own line: on a shared line,「【教會停車】您好」reads
// as greeting the parking system rather than the member, and on a phone we don't control where a
// long first line wraps, so the label can never be trusted to share one.
function head(subject: string): string {
  return `【教會停車】\n您好，${subject}`
}

const RENDERERS: Record<NotificationTemplate, (p: Payload) => string> = {
  // 「主日見！」 closes the message rather than sitting mid-way: once the copy is sectioned, a
  // sign-off followed by further instructions reads as if the message had ended.
  reservation_approved: p =>
    joinSections(
      head(`${sundayText(p)}的停車申請已核准。`),
      plateLine(p),
      '請於各車位釋出時間前抵達地下室，謝謝您。主日見！',
    ),

  reservation_waiting: p => {
    const rank = typeof p.rank === 'number' ? p.rank : null
    const lead = rank
      ? `${sundayText(p)}車位已額滿，您目前候補第 ${rank} 位。`
      : `${sundayText(p)}車位已額滿，您已進入候補名單。`
    return joinSections(
      head(lead),
      plateLine(p),
      '若有名額釋出我們會再通知您，謝謝您的耐心。',
    )
  },

  offer_2hr_confirm: p => {
    const at = taipeiTime(p.expires_at)
    const deadline = at ? `⏰ 請於 ${at} 前確認` : '⏰ 請於 2 小時內確認'
    return joinSections(
      head(`${sundayText(p)}有一個停車名額釋出給您！`),
      plateLine(p),
      deadline,
      '請開啟會員頁面（LINE 選單）點選『確認保留車位』。逾時未確認將順延給下一位，謝謝您。',
    )
  },

  offer_auto_approved: p =>
    joinSections(
      head(`有名額釋出，已為您自動保留${sundayText(p)}的車位。`),
      plateLine(p),
      '主日見！',
    ),

  // Goes to everyone still waiting, about capacity someone else freed — so no plate: it isn't
  // about their car.
  broadcast_release: p =>
    head(`${sundayText(p)}現在有停車名額釋出，歡迎候補的弟兄姊妹前往地下室停車（現場先到先停、不保證保留），謝謝您。`),

  // Sunday release sweep: tell the member whose reserved seat was released (missed check-in) —
  // informational, no penalty/reprimand. `released_at` is the RELEASE time (not the deadline);
  // it must not promise on-site spots exist. Provisional copy; final wording is church sign-off.
  //
  // No plate: Phase 4 Slice D fixed this payload as aggregate-safe (no per-member field) because
  // the release sweep fans out to many members in one batch. See ./context.
  reservation_released: p => {
    const at = taipeiTime(p.released_at)
    const when = at ? `已於 ${at} 釋出` : '已釋出'
    return joinSections(
      head(`${sundayText(p)}保留的車位${when}。`),
      '若仍需停車，請前往地下室現場洽詢停車同工，將依現場狀況協助，謝謝您。',
    )
  },

  // Member SELF-cancellation confirmation only — the「已為您取消」wording assumes the member acted.
  // Do NOT reuse for an admin/staff-initiated cancellation (different actor → different wording);
  // that would need its own template. Reads only the row's `cancel_status` (authoritative from the
  // apply_cancellation RPC state); any value other than `cancelled_late` uses the neutral line.
  //
  // No plate, by design: the member just pressed cancel and knows what they cancelled. The test
  // forbidding 「車牌」 here is the guard for that decision, not an accident.
  reservation_cancelled: p => {
    if (p.cancel_status === 'cancelled_late') {
      return joinSections(
        head(`${sundayText(p)}已核准的停車預約已為您取消，車位將釋出給候補的弟兄姊妹。`),
        '若需重新申請請至報名系統，謝謝您。',
      )
    }
    return joinSections(
      head(`${sundayText(p)}的停車申請／候補已為您取消。`),
      '若需重新申請請至報名系統，謝謝您。',
    )
  },

  // Only p2ReminderService enqueues this, and it targets effective_priority=2 exclusively — so
  // the P2 deadlines are always the right ones for this audience. They come from RELEASE_TIMES
  // rather than being typed into the copy: hard-coded times rot the moment the rule changes.
  p2_arrival_reminder: p =>
    joinSections(
      head(`提醒您${sundayText(p)}的停車保留時間。`),
      plateLine(p),
      `⏰ 車位保留至 ${releaseTimeLabel(RELEASE_TIMES.p2)}`,
      `若您正在路上，請開啟會員頁面點選『我正在路上』，我們會為您保留至 ${releaseTimeLabel(RELEASE_TIMES.p2Grace)}，謝謝您。`,
    ),

  // Staff-initiated: ask a specific car's owner to move it (OA push, no personal contact shown).
  // Reads only the plate persisted on the row (which may be a walk-in's, so it resolves its own).
  //
  // THE ONE TEMPLATE Wave 1d (#27) LEFT ALONE. Intentionally keeps the separately approved OA
  // move-car copy (docs/oa-onboarding-and-move-car-copy.md §二 A) byte-for-byte: no sender-label
  // line, no sectioning, no date — this is a live on-site request, not a scheduled notice.
  // Do NOT normalize it with the scheduled member templates without updating that document and
  // obtaining copy sign-off again.
  // (2026-07-20: re-synced to the doc's wording — this had drifted to "到地下室處理，現場有停車
  // 同工協助" instead of the doc's "到地下室移動您的愛車", caught while prepping the copy for
  // go-live-checklist §1.4 sign-off.)
  move_car_request: p => {
    const plate = typeof p.license_plate === 'string' && p.license_plate ? p.license_plate : '（車牌未提供）'
    return `【教會停車】您好 🙏 您停在地下室的車（車牌 ${plate}）需要麻煩您移車，請您方便時盡快到地下室移動您的愛車，謝謝您的配合！`
  },

  // Reserved template keys not currently enqueued; render a safe generic line rather than throw.
  staff_reminder: () => '【教會停車】同工提醒：請確認本週現場點名與車位狀況，謝謝您的服事。',
  admin_finalize_reminder: () => '【教會停車】提醒：本週點名尚未結束，請記得於系統執行「結束當週點名」，謝謝。',
}

export function renderTemplate(key: string, payload: Payload): string {
  const render = RENDERERS[key as NotificationTemplate]
  if (!render) throw new Error(`unknown template_key: ${key}`)
  return render(payload ?? {})
}
