import { isAdminRole } from '@/lib/adminAccountInput'
import { ADMIN_ROLE_LABEL } from '@/lib/adminRoles'
import { P2_REASON_LABEL } from '@/lib/p2Reason'
import type { P2Reason } from '@/lib/memberImportSchema'

// ── Audit presentation registry (Wave 2A-2 / #15) ────────────────────────────
// What an audit row is allowed to SHOW. This is not UI decoration — it is the
// read-side privacy boundary, and it is deliberately an ALLOWLIST.
//
// The write side is already an allowlist: 0030 assembles metadata inside each
// business RPC from fixed fields, and private.append_audit_log additionally
// refuses a denylist of PII-ish keys. But a denylist cannot know what it was never
// told about. A future RPC writing `eligibility_comment: '因罹患…'` passes that
// denylist untouched — the key simply isn't on it — and a generic "render whatever
// keys are present" viewer would print it to the page.
//
// So each action declares the keys it reads, and EVERYTHING ELSE IS IGNORED. Two
// independent layers (write-side denylist, read-side allowlist) means a gap in
// either one does not leak. #10's metadata is eligibility data — the most
// sensitive in the system — so this has to exist before #10 lands, not after.
//
// Exactly three outcomes, and no fourth:
//   known action + valid metadata  -> the action's own details
//   known action + wrong-typed key -> 'unreadable'   (never throw, never dump)
//   unknown action                 -> no details at all, raw code still shown
//
// An unknown action still renders its row: a gap in the timeline is worse than an
// unlabelled entry, because a missing row reads as "it never happened".

export interface AuditDetail {
  label: string
  value: string
}

export interface AuditActionDefinition {
  label: string
  // The keys this action may read. Anything outside this list is never rendered
  // and is counted as unsupported instead (see renderAuditDetails).
  reads: readonly string[]
  render(metadata: Record<string, unknown>): AuditDetail[] | 'unreadable'
}

const yesNo = (v: unknown): string | null =>
  typeof v === 'boolean' ? (v ? '是' : '否') : null

// Why 'denied' reasons are mapped rather than shown raw: they are RPC-internal
// codes. Unknown code falls back to the code itself (the MAP[x] ?? x idiom) — a
// reason we can't name is still a reason worth showing, and these are our own
// enum-like values, never user input.
//
// Shared by every admin_account.* action (2C-1: disable/enable/password_reset; 2C-2
// adds create/role_change/session_revoke). One map so the same refusal reads the same
// wherever it surfaces — see renderAdminDeniedReason.
const DENIED_REASON_LABEL: Record<string, string> = {
  last_active_superadmin: '不可停用最後一位系統管理員',
  cannot_target_self: '不可對自己執行',
  forbidden_role: '權限不足（需系統管理員）',
  acting_admin_disabled: '操作者帳號已停用',
}

// The shared denied-row renderer for every admin_account.* action. A denied row carries
// only `reason`; extracting this stops each action from reinventing the same branch and
// the same map lookup (and drifting apart when a reason is renamed).
function renderAdminDeniedReason(reason: unknown): AuditDetail[] | 'unreadable' {
  if (typeof reason !== 'string') return 'unreadable'
  return [{ label: '結果原因', value: DENIED_REASON_LABEL[reason] ?? reason }]
}

// A role value → its Chinese label, raw string if unrecognized (see the create/role_change
// action comments). isAdminRole is the same guard the audit viewer uses.
function adminRoleLabel(role: string): string {
  return isAdminRole(role) ? ADMIN_ROLE_LABEL[role] : role
}

function renderAdminAccountToggle(metadata: Record<string, unknown>): AuditDetail[] | 'unreadable' {
  const details: AuditDetail[] = []

  // A refusal row carries only `reason`; a success row carries the two booleans.
  if ('reason' in metadata) {
    return renderAdminDeniedReason(metadata.reason)
  }

  const changed = yesNo(metadata.state_changed)
  if (changed === null) return 'unreadable'
  // state_changed=false is the honest half of a deliberate decision: a repeat
  // disable looks like a no-op but still revokes every session (0026:69 runs the
  // delete unconditionally), so the row is written rather than suppressed as
  // noise. Saying so plainly is the whole point of showing this field.
  details.push({
    label: '帳號狀態',
    value: changed === '是' ? '已變更' : '未變更（原本就是此狀態，但已強制重新登入）',
  })
  return details
}

const CAPACITY_DENIED_REASON: Record<string, string> = {
  capacity_below_promised: '可分配車位會少於已核准的數量',
  event_not_editable: '這一週已不可修改',
  allocation_in_progress: '本週分配正在執行中',
  negative_capacity: '保留·停用數超過總車位',
  version_conflict: '另一位管理員已先行修改',
}

// #10's typed refusals (0033). An unknown code falls through to the raw string — a refusal
// nobody labelled must still be identifiable, never blank.
const P2_DENIED_REASON: Record<string, string> = {
  version_conflict: '另一位管理員已先行修改',
  nothing_to_revoke: '該會友原本就沒有 P2 資格',
  reason_required: '核准時必須指定事由',
  review_date_required: '核准時必須指定下次覆核日',
  review_date_in_past: '下次覆核日早於今天',
  child_birthdate_required: '幼兒同行必須登記最小孩子生日',
  child_birthdate_in_future: '孩子生日為未來日期',
  child_birthdate_not_applicable: '此事由不需要孩子生日',
  expiry_not_settable: '幼兒同行的到期日由系統推算，不可手動指定',
  window_inverted: '生效日晚於到期日',
  eligibility_not_approved: '非已核准的資格不可標記覆核',
}

const P2_STATUS_LABEL: Record<string, string> = {
  unreviewed: '未覆核',
  approved: '已核准',
  revoked: '已撤銷',
}

// A missing date is 「—」, not "null" or an empty gap: an audit row is read by a person
// deciding whether something looks wrong.
function dashIfNull(v: unknown): string {
  return typeof v === 'string' && v.length > 0 ? v : '—'
}

// Tier 0-2 (0038). Shared by the member.* and vehicle.* actions below so one refusal
// reads the same wherever it surfaces — same discipline as DENIED_REASON_LABEL.
const MEMBER_MAINTENANCE_DENIED_REASON: Record<string, string> = {
  acting_admin_disabled: '操作者帳號已停用',
  phone_in_use: '手機號碼已被其他會友使用',
  homonym_confirmation_stale: '確認期間名冊已變動，同名清單與當時不同',
  active_plate_owned_by_other: '此車牌目前屬於其他會友',
  unfinished_reservations: '該車尚有未結束的預約',
}

// The three vehicle actions differ only in their label: 0038 writes '{}' on success
// and a bare reason on refusal for all of them. Written once so a future fourth
// vehicle action cannot quietly get a different refusal vocabulary.
function vehicleAction(label: string): AuditActionDefinition {
  return {
    label,
    reads: ['reason'],
    render: metadata => {
      if (!('reason' in metadata)) return []
      const reason = metadata.reason
      if (typeof reason !== 'string') return 'unreadable'
      return [{ label: '未執行原因', value: MEMBER_MAINTENANCE_DENIED_REASON[reason] ?? reason }]
    },
  }
}

const ACTIONS: Record<string, AuditActionDefinition> = {
  // #14A. effective_capacity_from/to are read straight from the row rather than
  // recomputed here: the formula already lives in two places on purpose (the pure
  // computeCapacity for the read path, the RPC's SQL for the transactional guard) and
  // presentation must not become a third.
  'weekly_event.capacity_update': {
    label: '修改車位容量',
    reads: [
      'total_capacity_from', 'total_capacity_to',
      'blocked_spaces_from', 'blocked_spaces_to',
      'effective_capacity_from', 'effective_capacity_to',
      'promised_count', 'reason', 'requested_effective_capacity',
      'expected_version', 'actual_version',
    ],
    render: metadata => {
      // A refusal row carries a reason instead of a from/to pair.
      if ('reason' in metadata) {
        const reason = metadata.reason
        if (typeof reason !== 'string') return 'unreadable'
        const details: AuditDetail[] = [
          { label: '未執行原因', value: CAPACITY_DENIED_REASON[reason] ?? reason },
        ]
        if (typeof metadata.requested_effective_capacity === 'number' && typeof metadata.promised_count === 'number') {
          details.push({
            label: '當時數字',
            value: `想改成可分配 ${metadata.requested_effective_capacity} 位，但已核准 ${metadata.promised_count} 位`,
          })
        }
        return details
      }

      const { total_capacity_from: tf, total_capacity_to: tt } = metadata
      const { blocked_spaces_from: bf, blocked_spaces_to: bt } = metadata
      const { effective_capacity_from: ef, effective_capacity_to: et } = metadata
      if ([tf, tt, bf, bt, ef, et].some(v => typeof v !== 'number')) return 'unreadable'

      return [
        { label: '總車位', value: `${tf} → ${tt}` },
        { label: '保留·停用', value: `${bf} → ${bt}` },
        { label: '可分配', value: `${ef} → ${et}` },
      ]
    },
  },

  // One aggregate marker written by migration 0031, so the timeline can explain why
  // 外賓保留 stopped being tracked separately from that instant.
  'weekly_event.admin_reserved_fold': {
    label: '外賓保留位併入「保留·停用」',
    reads: ['rows_affected', 'arithmetic_preserved'],
    render: metadata => {
      const rows = metadata.rows_affected
      if (typeof rows !== 'number') return 'unreadable'
      return [
        { label: '調整週次', value: `${rows} 週` },
        { label: '可分配車位', value: '不變（僅合併顯示方式）' },
      ]
    },
  },

  // The audited eligibility writes (Wave 2B-2b / #10). These rows are ABOUT a named member,
  // so what they may say is tightly bounded: enum states, dates, and booleans for whether a
  // birthdate/note exists. The birthdate value itself cannot even be written (0032's
  // sanitizer), and note/review_note are exact-key denied by 0030.
  'p2_eligibility.review_update': {
    label: '修改 P2 資格',
    reads: [
      'review_status_from', 'review_status_to', 'reason_from', 'reason_to',
      'p2_valid_from_from', 'p2_valid_from_to', 'p2_valid_until_from', 'p2_valid_until_to',
      'p2_review_date_from', 'p2_review_date_to',
      'child_birthdate_present', 'note_present', 'created',
      'reason', 'expected_version', 'actual_version',
    ],
    render: metadata => {
      if ('reason' in metadata && !('review_status_to' in metadata)) {
        const reason = metadata.reason
        if (typeof reason !== 'string') return 'unreadable'
        return [{ label: '未執行原因', value: P2_DENIED_REASON[reason] ?? reason }]
      }
      const to = metadata.review_status_to
      if (typeof to !== 'string') return 'unreadable'
      const details: AuditDetail[] = [
        {
          label: '資格狀態',
          value: metadata.created === true
            ? `新建立：${P2_STATUS_LABEL[to] ?? to}`
            : `${P2_STATUS_LABEL[String(metadata.review_status_from)] ?? '—'} → ${P2_STATUS_LABEL[to] ?? to}`,
        },
      ]
      if (typeof metadata.reason_to === 'string') {
        details.push({ label: '事由', value: P2_REASON_LABEL[metadata.reason_to as P2Reason] ?? metadata.reason_to })
      }
      details.push({ label: '有效至', value: `${dashIfNull(metadata.p2_valid_until_from)} → ${dashIfNull(metadata.p2_valid_until_to)}` })
      details.push({ label: '下次覆核', value: `${dashIfNull(metadata.p2_review_date_from)} → ${dashIfNull(metadata.p2_review_date_to)}` })
      // Presence only, never the value: a child's date of birth is the reason 0032's
      // sanitizer exists, and 「有」/「無」 answers the operator's question without it.
      if (typeof metadata.child_birthdate_present === 'boolean') {
        details.push({ label: '孩子生日', value: metadata.child_birthdate_present ? '已登記（不顯示）' : '未登記' })
      }
      if (typeof metadata.note_present === 'boolean') {
        details.push({ label: '覆核備註', value: metadata.note_present ? '有（內容不進稽核）' : '無' })
      }
      return details
    },
  },
  'p2_eligibility.marked_reviewed': {
    label: '標記 P2 資格已覆核',
    reads: ['p2_review_date_from', 'p2_review_date_to', 'reason', 'expected_version', 'actual_version'],
    render: metadata => {
      if ('reason' in metadata) {
        const reason = metadata.reason
        if (typeof reason !== 'string') return 'unreadable'
        return [{ label: '未執行原因', value: P2_DENIED_REASON[reason] ?? reason }]
      }
      const to = metadata.p2_review_date_to
      if (typeof to !== 'string') return 'unreadable'
      // Deliberately says a review HAPPENED even when the date is unchanged: this action is
      // never inert (0033), and rendering it as "nothing changed" would erase the fact that
      // a human looked on this day.
      return [
        { label: '覆核紀錄', value: '已確認資料無誤' },
        { label: '下次覆核', value: `${dashIfNull(metadata.p2_review_date_from)} → ${to}` },
      ]
    },
  },

  // Two aggregate markers written by migration 0032 (#10). Counts only — a member's
  // eligibility is health-adjacent, so not one ID reaches these rows.
  'p2_eligibility.review_status_backfill': {
    label: 'P2 資格改為覆核制',
    reads: ['rows_backfilled', 'approved_count', 'unreviewed_count', 'derived_from'],
    render: metadata => {
      const rows = metadata.rows_backfilled
      const approved = metadata.approved_count
      const unreviewed = metadata.unreviewed_count
      if ([rows, approved, unreviewed].some(v => typeof v !== 'number')) return 'unreadable'
      return [
        { label: '轉換筆數', value: `${rows} 筆` },
        // Says "未覆核" and NOT "已撤銷" on purpose: the old boolean model could not
        // record who revoked anything, so calling these revoked would invent a decision
        // nobody made — and this row is append-only.
        { label: '轉換結果', value: `已核准 ${approved} 筆、未覆核 ${unreviewed} 筆` },
        { label: '資格權限', value: '不變（依原有 P2 狀態對應）' },
      ]
    },
  },
  'p2_eligibility.child_expiry_recompute': {
    label: '幼兒陪同資格到期日改依學年度',
    reads: ['rows_recomputed', 'rows_extended', 'rows_shortened', 'rule'],
    render: metadata => {
      const rows = metadata.rows_recomputed
      const extended = metadata.rows_extended
      const shortened = metadata.rows_shortened
      if ([rows, extended, shortened].some(v => typeof v !== 'number')) return 'unreadable'
      return [
        { label: '重算筆數', value: `${rows} 筆` },
        { label: '新規則', value: '算到孩子入學前的 8/31（原為滿 5 歲當天）' },
        { label: '影響', value: `延長 ${extended} 筆、縮短 ${shortened} 筆` },
      ]
    },
  },

  'admin_account.disable': {
    label: '停用管理員帳號',
    reads: ['disabled_to', 'state_changed', 'reason'],
    render: renderAdminAccountToggle,
  },
  'admin_account.enable': {
    label: '啟用管理員帳號',
    reads: ['disabled_to', 'state_changed', 'reason'],
    render: renderAdminAccountToggle,
  },
  // Audited on BOTH paths since 0035 (2C-1): a refusal carries `reason`, a success
  // carries the two booleans. No credential is ever in this metadata — the writer's
  // denylist would reject it anyway.
  'admin_account.password_reset': {
    label: '重設管理員密碼',
    reads: ['sessions_revoked', 'target_disabled', 'reason'],
    render: metadata => {
      if ('reason' in metadata) {
        return renderAdminDeniedReason(metadata.reason)
      }
      const revoked = yesNo(metadata.sessions_revoked)
      if (revoked === null) return 'unreadable'
      const details: AuditDetail[] = [{ label: '登入狀態', value: '已強制登出所有裝置' }]
      // Reset never re-enables a disabled account (0026/0035), so say so — otherwise a
      // reader might assume a password reset brought the account back.
      if (metadata.target_disabled === true) {
        details.push({ label: '帳號狀態', value: '此帳號目前為停用狀態' })
      }
      return details
    },
  },
  // Wave 2C-2 (#19) role management. A role value is shown through ADMIN_ROLE_LABEL;
  // an unrecognized value falls through to the raw string (like an unknown action code)
  // so a future role that forgets a label cannot vanish. A denied row reads through the
  // same shared reason map as the other admin_account.* actions.
  'admin_account.create': {
    label: '新增管理員帳號',
    reads: ['role', 'reason'],
    render: metadata => {
      if ('reason' in metadata) return renderAdminDeniedReason(metadata.reason)
      const role = metadata.role
      if (typeof role !== 'string') return 'unreadable'
      return [{ label: '角色', value: adminRoleLabel(role) }]
    },
  },
  'admin_account.role_change': {
    label: '變更管理員角色',
    reads: ['from_role', 'to_role', 'reason'],
    render: metadata => {
      if ('reason' in metadata) return renderAdminDeniedReason(metadata.reason)
      const { from_role: from, to_role: to } = metadata
      if (typeof from !== 'string' || typeof to !== 'string') return 'unreadable'
      return [{ label: '角色', value: `${adminRoleLabel(from)} → ${adminRoleLabel(to)}` }]
    },
  },
  'admin_account.session_revoke': {
    label: '撤銷管理員登入',
    reads: ['sessions_revoked', 'reason'],
    render: metadata => {
      if ('reason' in metadata) return renderAdminDeniedReason(metadata.reason)
      const n = metadata.sessions_revoked
      if (typeof n !== 'number') return 'unreadable'
      // 0 is a real outcome (the target was not logged in), and the row is written
      // anyway (0036) — say so rather than implying nothing happened.
      return [{ label: '登出裝置數', value: String(n) }]
    },
  },
  'audit.substrate_enabled': {
    label: '稽核記錄啟用',
    reads: ['schema_version', 'historical_events_backfilled'],
    render: metadata => {
      const backfilled = yesNo(metadata.historical_events_backfilled)
      if (backfilled === null) return 'unreadable'
      // The marker exists to say the trail starts HERE and that nothing before it
      // was invented. Spell that out rather than printing schema_version=2.
      return [{ label: '歷史紀錄', value: backfilled === '是' ? '已回填' : '未回填（紀錄自此開始）' }]
    },
  },
  // Wave 2A-3. The purge records itself, but only when it deleted something (0034),
  // so this row means "the retention sweep actually removed rows". It carries no IDs
  // and nothing from the deleted rows — only the count and the strict `<` boundary.
  'audit.retention_purge': {
    label: '稽核記錄清理',
    reads: ['deleted_before', 'deleted_count', 'retention_months'],
    render: metadata => {
      const count = metadata.deleted_count
      const before = metadata.deleted_before
      if (typeof count !== 'number' || typeof before !== 'string') return 'unreadable'
      // 「清除建立時間早於」mirrors the RPC's strict `<`: rows created before this
      // instant were removed; this instant itself was kept.
      return [
        { label: '清除筆數', value: String(count) },
        { label: '清除建立時間早於', value: before },
      ]
    },
  },
  // Wave 3 3d (#5B-a). A superadmin exported the member roster (bulk-PII egress). The metadata
  // is a count only — 0037 never writes a member id, name, or any exported value — so the row
  // records HOW MANY were in the export, never whom.
  'member_roster.export': {
    label: '匯出會友名冊',
    reads: ['row_count'],
    render: metadata => {
      const n = metadata.row_count
      if (typeof n !== 'number') return 'unreadable'
      return [{ label: '匯出筆數', value: String(n) }]
    },
  },

  // ── Tier 0-2 (0038) member maintenance ─────────────────────────────────────
  // None of these carry a name, a phone or a plate: 0038 writes counts and booleans
  // only, and the entity_id is the id of the thing acted on. So the reader learns
  // WHAT was done to WHICH record, never what the values were — which is the point.
  // To see the current values you open that member's page, where the ordinary
  // permission checks apply.
  'member.create': {
    label: '新增會友',
    reads: ['homonym_confirmed', 'candidate_count', 'reason'],
    render: metadata => {
      if ('reason' in metadata) {
        const reason = metadata.reason
        if (typeof reason !== 'string') return 'unreadable'
        return [{ label: '未執行原因', value: MEMBER_MAINTENANCE_DENIED_REASON[reason] ?? reason }]
      }
      const confirmed = yesNo(metadata.homonym_confirmed)
      const count = metadata.candidate_count
      if (confirmed === null || typeof count !== 'number') return 'unreadable'
      // The interesting row is the confirmed one: it means the operator was shown
      // existing members with the same name and decided this is a different person.
      // Saying how many they were shown is what makes that decision reviewable.
      return confirmed === '是'
        ? [{ label: '同名確認', value: `已確認與名冊中 ${count} 位同名會友不同人` }]
        : [{ label: '同名確認', value: '名冊中無同名會友' }]
    },
  },
  'member.identity_change': {
    label: '修改會友姓名／手機',
    reads: ['name_changed', 'phone_changed', 'bindings_invalidated', 'reason'],
    render: metadata => {
      if ('reason' in metadata) {
        const reason = metadata.reason
        if (typeof reason !== 'string') return 'unreadable'
        return [{ label: '未執行原因', value: MEMBER_MAINTENANCE_DENIED_REASON[reason] ?? reason }]
      }
      const name = yesNo(metadata.name_changed)
      const phone = yesNo(metadata.phone_changed)
      const invalidated = metadata.bindings_invalidated
      if (name === null || phone === null || typeof invalidated !== 'number') return 'unreadable'

      const changed = [name === '是' ? '姓名' : null, phone === '是' ? '手機' : null].filter(Boolean)
      const details: AuditDetail[] = [
        { label: '異動欄位', value: changed.length > 0 ? changed.join('、') : '無' },
      ]
      // Only when it happened. A permanent「0 筆」line would train the reader to skip
      // this row, and this is the consequence the operator most needs to have noticed:
      // somebody has to tell that member to submit their LINE binding again.
      if (invalidated > 0) {
        details.push({ label: '連帶作廢', value: `待審 LINE 綁定申請 ${invalidated} 筆` })
      }
      return details
    },
  },
  // 0038 writes '{}' on success for all three: the action label plus the vehicle
  // entity id already say everything, and the plate itself is deliberately absent.
  // The refusals are where the substance is — especially unfinished_reservations,
  // which is the guard that stops a car being retired out from under a live booking.
  'vehicle.add': vehicleAction('新增車牌'),
  'vehicle.deactivate': vehicleAction('停用車牌'),
  'vehicle.reactivate': vehicleAction('恢復使用車牌'),
}

export const UNKNOWN_ACTION_DETAIL = '詳細資料目前無法顯示'
export const UNREADABLE_DETAIL = '詳細資料格式無法辨識'

// What this page is, and — more importantly — what it is NOT. Every clause is
// load-bearing:
//  · 「不是完整的操作紀錄」— the substrate raises the cost of FORGING a row, not of
//    skipping one. A reader must not treat「查不到」as「沒發生」.
//  · the staff clause — the on-site PIN is a shared per-event credential, so a
//    staff row names a session, never a person.
//  · retention — 2A-3 shipped: the monthly purge_audit_logs sweep (0034) deletes rows
//    past 24 months, so the copy now states that plainly. It was deliberately qualified
//    ("將於後續啟用") until the mechanism existed, because a deletion claim without a
//    running control is a false PRIVACY claim. The pinned test below flipped with it.
//    ⚠️ The prod cron must actually be configured before this copy reaches a live
//    /admin/audit (prod-deploy-runbook.md §8/§13), or the claim is premature again.
//
// Lives here rather than in the page because a page file can't export a const for
// tests to import, and this copy is pinned by a test on purpose (see below).
export const AUDIT_BOUNDARY_NOTE =
  '此頁顯示重要異動紀錄（帳號、資格、車位設定等），不是完整的操作紀錄。' +
  '現場同工使用共用 PIN，只能追溯到當週的登入 session，無法辨識個人。' +
  '紀錄保留 24 個月，逾期後由定期維運作業清除。'

export function auditActionLabel(action: string): string {
  return ACTIONS[action]?.label ?? action
}

export interface RenderedDetails {
  details: AuditDetail[]
  fallback: string | null
  // Extra keys present on a KNOWN action that no renderer claims. Surfaced as a
  // bare count so a developer who adds metadata without extending this registry
  // sees that something is missing — instead of it vanishing silently.
  //
  // A count, never the key names: `eligibility_comment` sitting beside a member
  // entity is itself mildly revealing, even with the value withheld.
  unsupportedCount: number
}

export function renderAuditDetails(action: string, metadata: unknown): RenderedDetails {
  const def = ACTIONS[action]

  // Unknown action: show nothing from metadata, and no count either. A count here
  // would read as「內容因權限不足而被隱藏」— false, and the opposite of what this
  // page is for.
  if (!def) return { details: [], fallback: UNKNOWN_ACTION_DETAIL, unsupportedCount: 0 }

  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return { details: [], fallback: UNREADABLE_DETAIL, unsupportedCount: 0 }
  }
  const bag = metadata as Record<string, unknown>

  const rendered = def.render(bag)
  // A wrong-typed known key reports ONE fault, not two: no count alongside the
  // fallback, or the same broken field would show as「格式無法辨識」and
  // 「另有 1 項未顯示」at once.
  if (rendered === 'unreadable') {
    return { details: [], fallback: UNREADABLE_DETAIL, unsupportedCount: 0 }
  }

  const unsupportedCount = Object.keys(bag).filter(k => !def.reads.includes(k)).length
  return { details: rendered, fallback: null, unsupportedCount }
}
