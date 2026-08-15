import { describe, expect, it } from 'vitest'
import {
  AUDIT_BOUNDARY_NOTE,
  auditActionLabel,
  renderAuditDetails,
  UNKNOWN_ACTION_DETAIL,
  UNREADABLE_DETAIL,
} from '@/server/services/auditPresentation'

// Wave 2A-2 (#15). This registry is the read-side privacy boundary, not a label
// map: it decides which metadata may be displayed AT ALL. The tests that matter
// here are the ones proving it never renders something it wasn't told to.

describe('auditActionLabel', () => {
  it('labels known actions and falls back to the raw code for unknown ones', () => {
    expect(auditActionLabel('admin_account.disable')).toBe('停用管理員帳號')
    // An unlabelled row must still be identifiable — hiding it, or blanking the
    // action, would read as "nothing happened".
    expect(auditActionLabel('future.action')).toBe('future.action')
  })
})

describe('renderAuditDetails — known action, valid metadata', () => {
  it('renders only what the action declares it reads', () => {
    const r = renderAuditDetails('admin_account.disable', {
      disabled_to: true,
      state_changed: true,
    })
    expect(r.fallback).toBeNull()
    expect(r.unsupportedCount).toBe(0)
    expect(r.details).toEqual([{ label: '帳號狀態', value: '已變更' }])
  })

  it('spells out the repeat-disable case rather than hiding it', () => {
    // state_changed=false is deliberate: 0026:69 revokes sessions unconditionally,
    // so a "no-op" repeat disable is still a real security action. The copy has to
    // say the account did not change AND that sessions were forced out, or the row
    // looks like pointless noise.
    const r = renderAuditDetails('admin_account.disable', {
      disabled_to: true,
      state_changed: false,
    })
    expect(r.details[0].value).toContain('未變更')
    expect(r.details[0].value).toContain('重新登入')
  })

  it('maps a denied reason to operator language, unknown reason falls back to the code', () => {
    expect(renderAuditDetails('admin_account.disable', { reason: 'last_active_superadmin' }).details)
      .toEqual([{ label: '結果原因', value: '不可停用最後一位系統管理員' }])
    expect(renderAuditDetails('admin_account.disable', { reason: 'future_guard' }).details)
      .toEqual([{ label: '結果原因', value: 'future_guard' }])
  })

  it('names the 2C-1 role guards in operator language', () => {
    // These reasons are shared across every admin_account.* action via one map, so a
    // rename that misses a call site would surface here.
    expect(renderAuditDetails('admin_account.disable', { reason: 'forbidden_role' }).details)
      .toEqual([{ label: '結果原因', value: '權限不足（需系統管理員）' }])
    expect(renderAuditDetails('admin_account.disable', { reason: 'acting_admin_disabled' }).details)
      .toEqual([{ label: '結果原因', value: '操作者帳號已停用' }])
  })

  it('renders a password reset as a session-revoke, never a credential', () => {
    const ok = renderAuditDetails('admin_account.password_reset', {
      sessions_revoked: true, target_disabled: false,
    })
    expect(ok.fallback).toBeNull()
    expect(ok.details).toEqual([{ label: '登入狀態', value: '已強制登出所有裝置' }])

    // A disabled target says so — a reset does not re-enable an account.
    const disabled = renderAuditDetails('admin_account.password_reset', {
      sessions_revoked: true, target_disabled: true,
    })
    expect(disabled.details).toContainEqual({ label: '帳號狀態', value: '此帳號目前為停用狀態' })

    // A refusal reads through the shared reason map.
    expect(renderAuditDetails('admin_account.password_reset', { reason: 'forbidden_role' }).details)
      .toEqual([{ label: '結果原因', value: '權限不足（需系統管理員）' }])
  })

  it('renders the 2C-2 role-management actions with role labels and denied branches', () => {
    // create: role shown in Chinese, unknown role shows raw (a future role must not vanish)
    expect(renderAuditDetails('admin_account.create', { role: 'clerk' }).details)
      .toEqual([{ label: '角色', value: '幹事' }])
    expect(renderAuditDetails('admin_account.create', { role: 'future_role' }).details)
      .toEqual([{ label: '角色', value: 'future_role' }])
    expect(renderAuditDetails('admin_account.create', { reason: 'forbidden_role' }).details)
      .toEqual([{ label: '結果原因', value: '權限不足（需系統管理員）' }])

    // role_change: from → to
    expect(renderAuditDetails('admin_account.role_change', { from_role: 'clerk', to_role: 'superadmin' }).details)
      .toEqual([{ label: '角色', value: '幹事 → 系統管理員' }])
    expect(renderAuditDetails('admin_account.role_change', { reason: 'cannot_target_self' }).details)
      .toEqual([{ label: '結果原因', value: '不可對自己執行' }])

    // session_revoke: count, including zero (the row is still written)
    expect(renderAuditDetails('admin_account.session_revoke', { sessions_revoked: 0 }).details)
      .toEqual([{ label: '登出裝置數', value: '0' }])
    expect(renderAuditDetails('admin_account.session_revoke', { sessions_revoked: 3 }).details)
      .toEqual([{ label: '登出裝置數', value: '3' }])
  })

  it('none of the new actions renders as 未知動作', () => {
    for (const action of ['admin_account.create', 'admin_account.role_change', 'admin_account.session_revoke']) {
      expect(auditActionLabel(action)).not.toBe(action)
    }
  })

  it('renders the bootstrap marker as "the trail starts here"', () => {
    const r = renderAuditDetails('audit.substrate_enabled', {
      schema_version: 2,
      historical_events_backfilled: false,
    })
    expect(r.fallback).toBeNull()
    expect(r.details).toEqual([{ label: '歷史紀錄', value: '未回填（紀錄自此開始）' }])
  })

  it('renders a retention purge as count + the strict `<` boundary (2A-3), never 未知動作', () => {
    const r = renderAuditDetails('audit.retention_purge', {
      deleted_before: '2024-07-17T15:00:00+00:00',
      deleted_count: 42,
      retention_months: 24,
    })
    expect(r.fallback).toBeNull()
    expect(r.details).toEqual([
      { label: '清除筆數', value: '42' },
      { label: '清除建立時間早於', value: '2024-07-17T15:00:00+00:00' },
    ])
  })

  it('a malformed retention-purge row fails safe (unreadable), never throws', () => {
    const r = renderAuditDetails('audit.retention_purge', { deleted_count: 'lots', deleted_before: 1 })
    expect(r.details).toEqual([])
    expect(r.fallback).toBe(UNREADABLE_DETAIL)
  })
})

describe('renderAuditDetails — #14A capacity actions', () => {
  it('renders a capacity change as from→to, reading effective capacity rather than recomputing it', () => {
    // The formula already lives in two places on purpose (the pure computeCapacity for
    // reads, the RPC's SQL for the transactional guard). The viewer must NOT become a
    // third — so it reads effective_capacity_from/to off the row.
    const r = renderAuditDetails('weekly_event.capacity_update', {
      total_capacity_from: 23, total_capacity_to: 23,
      blocked_spaces_from: 3, blocked_spaces_to: 5,
      effective_capacity_from: 19, effective_capacity_to: 17,
      promised_count: 4,
    })
    expect(r.fallback).toBeNull()
    expect(r.details).toEqual([
      { label: '總車位', value: '23 → 23' },
      { label: '保留·停用', value: '3 → 5' },
      { label: '可分配', value: '19 → 17' },
    ])
  })

  it('explains a refusal in operator language, and falls back to the raw code for an unknown one', () => {
    expect(renderAuditDetails('weekly_event.capacity_update', {
      reason: 'capacity_below_promised', requested_effective_capacity: 1, promised_count: 2,
    }).details).toEqual([
      { label: '未執行原因', value: '可分配車位會少於已核准的數量' },
      { label: '當時數字', value: '想改成可分配 1 位，但已核准 2 位' },
    ])
    expect(renderAuditDetails('weekly_event.capacity_update', { reason: 'future_guard' }).details)
      .toEqual([{ label: '未執行原因', value: 'future_guard' }])
  })

  it('a wrong-typed capacity field falls back rather than rendering nonsense', () => {
    const r = renderAuditDetails('weekly_event.capacity_update', {
      total_capacity_from: '23', total_capacity_to: 23,
      blocked_spaces_from: 3, blocked_spaces_to: 5,
      effective_capacity_from: 19, effective_capacity_to: 17,
    })
    expect(r.fallback).toBe(UNREADABLE_DETAIL)
    expect(r.details).toEqual([])
  })

  it('renders the one-off fold marker, and says the capacity did not move', () => {
    // The fold rewrote a column's meaning across every row but changed no effective
    // capacity; the timeline should say exactly that.
    const r = renderAuditDetails('weekly_event.admin_reserved_fold', {
      rows_affected: 12, arithmetic_preserved: true,
    })
    expect(r.details).toEqual([
      { label: '調整週次', value: '12 週' },
      { label: '可分配車位', value: '不變（僅合併顯示方式）' },
    ])
  })
})

describe('renderAuditDetails — #10 eligibility writes (2B-2b)', () => {
  it('renders a create as a create, not as a transition from nothing', () => {
    const r = renderAuditDetails('p2_eligibility.review_update', {
      review_status_from: null, review_status_to: 'approved', created: true,
      reason_to: 'pregnancy', p2_valid_until_from: null, p2_valid_until_to: '2027-01-01',
      p2_review_date_from: null, p2_review_date_to: '2026-12-01',
      child_birthdate_present: false, note_present: false,
    })
    expect(r.fallback).toBeNull()
    expect(r.details[0]).toEqual({ label: '資格狀態', value: '新建立：已核准' })
    expect(r.details).toContainEqual({ label: '有效至', value: '— → 2027-01-01' })
  })

  it('renders a revoke as a state transition', () => {
    const r = renderAuditDetails('p2_eligibility.review_update', {
      review_status_from: 'approved', review_status_to: 'revoked', created: false,
      p2_valid_until_from: '2027-01-01', p2_valid_until_to: '2027-01-01',
      p2_review_date_from: '2026-12-01', p2_review_date_to: null,
    })
    expect(r.details[0]).toEqual({ label: '資格狀態', value: '已核准 → 已撤銷' })
    expect(r.details).toContainEqual({ label: '下次覆核', value: '2026-12-01 → —' })
  })

  it('says a birthdate EXISTS without ever saying what it is', () => {
    // The single most sensitive field in the system. 0032's sanitizer makes the value
    // unwritable; this makes sure the presentation never invents a way to show one either.
    const r = renderAuditDetails('p2_eligibility.review_update', {
      review_status_to: 'approved', created: false, reason_to: 'child_companion',
      p2_valid_until_from: null, p2_valid_until_to: '2026-08-31',
      p2_review_date_from: null, p2_review_date_to: '2026-06-01',
      child_birthdate_present: true, note_present: true,
    })
    expect(r.details).toContainEqual({ label: '孩子生日', value: '已登記（不顯示）' })
    expect(r.details).toContainEqual({ label: '覆核備註', value: '有（內容不進稽核）' })
  })

  it('maps every typed denial to operator language, unknown falls back to the code', () => {
    expect(renderAuditDetails('p2_eligibility.review_update', { reason: 'expiry_not_settable' }).details)
      .toEqual([{ label: '未執行原因', value: '幼兒同行的到期日由系統推算，不可手動指定' }])
    expect(renderAuditDetails('p2_eligibility.review_update', { reason: 'future_guard' }).details)
      .toEqual([{ label: '未執行原因', value: 'future_guard' }])
  })

  it('marked_reviewed says a review HAPPENED even when the date did not move', () => {
    // This action is never inert (0033). Rendering an unchanged date as "nothing changed"
    // would erase the fact that a human looked on this day — which is the entire point.
    const r = renderAuditDetails('p2_eligibility.marked_reviewed', {
      p2_review_date_from: '2027-06-30', p2_review_date_to: '2027-06-30',
    })
    expect(r.details).toEqual([
      { label: '覆核紀錄', value: '已確認資料無誤' },
      { label: '下次覆核', value: '2027-06-30 → 2027-06-30' },
    ])
  })

  it('a wrong-typed status falls back rather than rendering nonsense', () => {
    expect(renderAuditDetails('p2_eligibility.review_update', { review_status_to: 42 }).fallback)
      .toBe(UNREADABLE_DETAIL)
  })

  it('drops a birthdate a future writer smuggles in under an unclaimed key', () => {
    const r = renderAuditDetails('p2_eligibility.review_update', {
      review_status_to: 'approved', created: false,
      p2_valid_until_from: null, p2_valid_until_to: null,
      p2_review_date_from: null, p2_review_date_to: null,
      child_dob: '2020-09-01',
    })
    expect(JSON.stringify(r)).not.toContain('2020-09-01')
    expect(r.unsupportedCount).toBe(1)
  })
})

describe('renderAuditDetails — #10 eligibility markers', () => {
  it('says "未覆核", never "已撤銷", for the backfilled rows', () => {
    // The whole reason 0032's enum has three states. The old boolean model could not record
    // WHO revoked anything, so labelling these rows revoked would assert a human decision
    // that never happened — into a row that can never be edited or deleted.
    const r = renderAuditDetails('p2_eligibility.review_status_backfill', {
      rows_backfilled: 12, approved_count: 9, unreviewed_count: 3, derived_from: 'p2_eligible',
    })
    expect(r.fallback).toBeNull()
    expect(r.details).toEqual([
      { label: '轉換筆數', value: '12 筆' },
      { label: '轉換結果', value: '已核准 9 筆、未覆核 3 筆' },
      { label: '資格權限', value: '不變（依原有 P2 狀態對應）' },
    ])
    expect(JSON.stringify(r)).not.toContain('撤銷')
  })

  it('renders the child-expiry recompute as extend-only', () => {
    const r = renderAuditDetails('p2_eligibility.child_expiry_recompute', {
      rows_recomputed: 4, rows_extended: 4, rows_shortened: 0, rule: 'tw_school_cohort_v1',
    })
    expect(r.details).toEqual([
      { label: '重算筆數', value: '4 筆' },
      { label: '新規則', value: '算到孩子入學前的 8/31（原為滿 5 歲當天）' },
      { label: '影響', value: '延長 4 筆、縮短 0 筆' },
    ])
  })

  it('a wrong-typed count falls back rather than rendering nonsense', () => {
    expect(renderAuditDetails('p2_eligibility.review_status_backfill', {
      rows_backfilled: '12', approved_count: 9, unreviewed_count: 3,
    }).fallback).toBe(UNREADABLE_DETAIL)
  })

  it('never renders a member id even if a future writer smuggles one in', () => {
    // These markers are aggregate by design: P2 eligibility is health-adjacent, so a single
    // user id beside 「已核准」 would leak a medical fact about a named person.
    const r = renderAuditDetails('p2_eligibility.review_status_backfill', {
      rows_backfilled: 1, approved_count: 1, unreviewed_count: 0,
      user_id: 'a0000000-0000-0000-0000-000000000002',
    })
    expect(JSON.stringify(r)).not.toContain('a0000000')
    expect(r.unsupportedCount).toBe(1)
  })
})

describe('renderAuditDetails — the allowlist holds', () => {
  it('never renders an extra key a future writer added, and counts it instead', () => {
    // The exact hazard this registry exists for: 0030's write-side denylist would
    // pass `eligibility_comment` (that key simply isn't on it), so a generic
    // "render every key" viewer would print a medical note to the page.
    const r = renderAuditDetails('admin_account.disable', {
      disabled_to: true,
      state_changed: true,
      eligibility_comment: '因罹患重大疾病',
      vehicle_identifier: 'ABC-1234',
    })
    const serialized = JSON.stringify(r)
    expect(serialized).not.toContain('因罹患重大疾病')
    expect(serialized).not.toContain('ABC-1234')
    // The key NAMES leak too — 'eligibility_comment' beside a member entity is
    // itself revealing — so only a count escapes.
    expect(serialized).not.toContain('eligibility_comment')
    expect(r.unsupportedCount).toBe(2)
  })

  it('unknown action renders no metadata at all, and no count', () => {
    const r = renderAuditDetails('future.action', {
      review_note_text: '不可外洩',
      whatever: 'secret',
    })
    expect(r.details).toEqual([])
    expect(r.fallback).toBe(UNKNOWN_ACTION_DETAIL)
    expect(JSON.stringify(r)).not.toContain('不可外洩')
    expect(JSON.stringify(r)).not.toContain('secret')
    // A count here would read as「內容因權限不足而被隱藏」— false, and the opposite
    // of what this page is for.
    expect(r.unsupportedCount).toBe(0)
  })
})

describe('AUDIT_BOUNDARY_NOTE must not claim a control that is not running', () => {
  // 2A-3 (retention purge) has shipped: purge_audit_logs (0034) runs monthly, so the
  // copy states retention plainly. This is the flipped form of the assertion that used
  // to pin「自動清理將於後續維運功能啟用」. ⚠️ The claim is only honest in prod once the
  // cron is actually configured (prod-deploy-runbook.md §8/§13) — enforced there.
  it('states retention plainly now that the purge runs, with no future-tense qualifier', () => {
    // A flat「紀錄保留 24 個月」is now TRUE: rows past 24 months are deleted by the sweep.
    expect(AUDIT_BOUNDARY_NOTE).toContain('紀錄保留 24 個月')
    // The old「將於後續」qualifier claimed a not-yet-running control; it must be gone,
    // or the copy would understate a mechanism that now exists.
    expect(AUDIT_BOUNDARY_NOTE).not.toContain('後續')
  })

  it('tells the reader what the log does NOT cover', () => {
    // Absence of a row is not proof of absence of an action: the substrate makes
    // forging expensive, not omission impossible.
    expect(AUDIT_BOUNDARY_NOTE).toContain('不是完整的操作紀錄')
    // And a staff row is a shared PIN session, never a named person.
    expect(AUDIT_BOUNDARY_NOTE).toContain('無法辨識個人')
  })
})

describe('renderAuditDetails — malformed shapes fail safe, never throw', () => {
  it('a known key of the wrong type reports ONE fault, not two', () => {
    const r = renderAuditDetails('admin_account.disable', { state_changed: { nested: true } })
    expect(r.fallback).toBe(UNREADABLE_DETAIL)
    expect(r.details).toEqual([])
    // No count alongside the fallback: the same single broken field would otherwise
    // show as「格式無法辨識」and「另有 1 項未顯示」at once.
    expect(r.unsupportedCount).toBe(0)
  })

  it.each([
    ['null', null],
    ['a string', 'not-an-object'],
    ['an array', [1, 2]],
    ['a number', 42],
    ['undefined', undefined],
  ])('metadata that is %s falls back instead of throwing', (_label, metadata) => {
    const r = renderAuditDetails('admin_account.disable', metadata)
    expect(r.fallback).toBe(UNREADABLE_DETAIL)
    expect(r.details).toEqual([])
  })

  it('never dumps raw JSON into a fallback', () => {
    const r = renderAuditDetails('admin_account.disable', { state_changed: 'yes-ish', secret: 'x' })
    expect(JSON.stringify(r)).not.toContain('yes-ish')
    expect(JSON.stringify(r)).not.toContain('secret')
  })
})

// ── Tier 0-2 (0038) member maintenance ───────────────────────────────────────
// These exist because the slice shipped WITHOUT them and prod showed
// 「vehicle.reactivate（未知動作）／詳細資料目前無法顯示」on a real staged smoke.
// The plan called for this registry entry explicitly and the implementation missed
// it; nothing failed, because no test connected the two sides. So the first test
// below is not a label check — it is the drift guard that was absent: every action
// 0038 writes must be registered HERE, or the audit trail for the only write path
// the church has to member data is unreadable.
describe('renderAuditDetails — 0038 member maintenance actions are registered', () => {
  // Mirrors the `v_action` literals in 0038_member_maintenance.sql. A new audited
  // action in a later migration must be added here AND to the registry.
  const ACTIONS_0038 = [
    'member.create',
    'member.identity_change',
    'vehicle.add',
    'vehicle.deactivate',
    'vehicle.reactivate',
  ] as const

  it.each(ACTIONS_0038)('%s has a human label, not the raw code', action => {
    expect(auditActionLabel(action)).not.toBe(action)
  })

  it.each(ACTIONS_0038)('%s never falls back to「未知動作」', action => {
    // '{}' is what the vehicle actions actually write on success, so this is the
    // real shape, not a placeholder.
    expect(renderAuditDetails(action, {}).fallback).not.toBe(UNKNOWN_ACTION_DETAIL)
  })

  it.each(ACTIONS_0038)('%s reads every key 0038 writes on refusal', action => {
    // Every refusal path in 0038 writes exactly {reason}. An unsupportedCount above
    // zero here would mean the registry is silently dropping the only thing a denied
    // row has to say.
    const r = renderAuditDetails(action, { reason: 'acting_admin_disabled' })
    expect(r.unsupportedCount).toBe(0)
    expect(r.fallback).toBeNull()
    expect(r.details).toEqual([{ label: '未執行原因', value: '操作者帳號已停用' }])
  })
})

describe('renderAuditDetails — 0038 success rows say what was decided', () => {
  it('a confirmed homonym create records that a human made that call', () => {
    const r = renderAuditDetails('member.create', { homonym_confirmed: true, candidate_count: 2 })
    expect(r.unsupportedCount).toBe(0)
    expect(r.details).toEqual([
      { label: '同名確認', value: '已確認與名冊中 2 位同名會友不同人' },
    ])
  })

  it('an ordinary create says there was nobody to confirm', () => {
    const r = renderAuditDetails('member.create', { homonym_confirmed: false, candidate_count: 0 })
    expect(r.details).toEqual([{ label: '同名確認', value: '名冊中無同名會友' }])
  })

  it('a phone change surfaces the binding claims it invalidated', () => {
    // The consequence the operator most needs to have noticed: somebody has to tell
    // that member to submit their LINE binding again.
    const r = renderAuditDetails('member.identity_change', {
      name_changed: false, phone_changed: true, bindings_invalidated: 1,
    })
    expect(r.details).toEqual([
      { label: '異動欄位', value: '手機' },
      { label: '連帶作廢', value: '待審 LINE 綁定申請 1 筆' },
    ])
  })

  it('omits the invalidation line when there was none, rather than printing 0 筆', () => {
    const r = renderAuditDetails('member.identity_change', {
      name_changed: true, phone_changed: true, bindings_invalidated: 0,
    })
    expect(r.details).toEqual([{ label: '異動欄位', value: '姓名、手機' }])
  })

  it('a vehicle success row carries no details — and no fallback either', () => {
    const r = renderAuditDetails('vehicle.deactivate', {})
    expect(r.details).toEqual([])
    expect(r.fallback).toBeNull()
    expect(r.unsupportedCount).toBe(0)
  })

  it('the refusal that matters most reads as a sentence', () => {
    const r = renderAuditDetails('vehicle.deactivate', { reason: 'unfinished_reservations' })
    expect(r.details).toEqual([{ label: '未執行原因', value: '該車尚有未結束的預約' }])
  })
})

describe('0038 rows still leak nothing', () => {
  it.each([
    ['member.create', { homonym_confirmed: true, candidate_count: 1, display_name: '王小明', phone_number: '0912345678' }],
    ['member.identity_change', { name_changed: true, phone_changed: true, bindings_invalidated: 0, phone_to: '0987654321' }],
    ['vehicle.add', { license_plate: 'ABC-1234' }],
  ])('%s renders none of the identifying keys a future writer might add', (action, metadata) => {
    const serialized = JSON.stringify(renderAuditDetails(action, metadata))
    expect(serialized).not.toContain('王小明')
    expect(serialized).not.toContain('0912345678')
    expect(serialized).not.toContain('0987654321')
    expect(serialized).not.toContain('ABC-1234')
  })
})
