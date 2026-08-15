'use client'

import { useRef, useState } from 'react'
import Link from 'next/link'
import { GROUP_CONFLICT_FIELD_LABEL, type GroupConflictField } from '@/lib/memberImportSchema'

// Member CSV upload: two-step preview → apply. The raw file lives ONLY in a ref (not
// React state) so its full PII contents don't sit in devtools-inspectable state — only
// the operator-facing report + the (non-PII) confirmation token do. Everything is
// cleared on a new file / success. Nothing is persisted to storage/URL/analytics.

const MAX_CSV_BYTES = 2 * 1024 * 1024

interface ImportReport {
  dryRun: boolean
  rows: number
  members: number
  imported: number
  updated: number
  vehiclesAdded: number
  dependentsAdded: number
  phoneNameConflicts: Array<{ phone: string; names: string[]; existingName?: string }>
  // Tier 0-2 (0038) — the name already belongs to somebody, under a different phone.
  identityConflicts: Array<{
    phone: string
    name: string
    candidates: Array<{ phoneMasked: string; evidence: 'same_name' | 'same_name_and_plate' }>
  }>
  plateConflicts: Array<{ phone: string; plates: string[] }>
  batchPlateConflicts: Array<{ plate: string; phones: string[] }>
  groupConflicts: Array<{ phone: string; field: GroupConflictField; subject?: string; values: string[] }>
  reviewRequired: Array<{ phone: string; reason: string }>
  p2Retained: Array<{ phone: string }>
  revokedRetained: Array<{ phone: string }>
  governedRetained: Array<{ phone: string }>
  validationErrors: Array<{ line: number; errors: string[] }>
  truncated: boolean
  totals: {
    phoneNameConflicts: number
    identityConflicts: number
    plateConflicts: number
    batchPlateConflicts: number
    groupConflicts: number
    reviewRequired: number
    p2Retained: number
    revokedRetained: number
    governedRetained: number
    validationErrors: number
  }
}

const REASON_MESSAGE: Record<string, string> = {
  invalid_csv: '無法解析 CSV，請確認格式（引號、逗號）正確',
  missing_headers: '缺少必要欄位表頭：姓名、手機、車牌，且需含「優先序」（全體名單）或「申請原因」（P2 申請表）其一',
  ambiguous_profile: '同時含「優先序」與「申請原因」，無法判斷格式；請只用其中一種範本',
  duplicate_headers: 'CSV 表頭有重複欄位（含中英對照後撞名，如「姓名」與 applicant_name）',
  too_many_rows: '資料列過多（上限 5000 列）',
  invalid_encoding: '檔案編碼不是 UTF-8，請另存為 UTF-8 後再上傳',
  payload_too_large: '檔案過大（上限 2 MB）',
  unsupported_media_type: '檔案類型不正確',
  empty: '檔案是空的',
  preview_mismatch: '檔案內容與預覽不符，請重新預覽後再匯入',
  preview_expired: '預覽已逾時，請重新預覽',
  bad_confirmation: '確認資訊無效，請重新預覽',
}

type Phase = 'idle' | 'previewed' | 'applied' | 'partial'

export default function MemberImport() {
  const fileRef = useRef<File | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [report, setReport] = useState<ImportReport | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [acknowledged, setAcknowledged] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [processedMembers, setProcessedMembers] = useState<number | null>(null)

  function resetAll() {
    fileRef.current = null
    setFileName(null)
    setReport(null)
    setToken(null)
    setPhase('idle')
    setAcknowledged(false)
    setError(null)
    setProcessedMembers(null)
  }

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    // A new file invalidates any prior preview/token.
    resetAll()
    const file = e.target.files?.[0] ?? null
    if (!file) return
    if (file.size > MAX_CSV_BYTES) {
      setError('檔案過大（上限 2 MB）')
      return
    }
    fileRef.current = file
    setFileName(file.name)
  }

  async function preview() {
    const file = fileRef.current
    if (!file || busy) return
    setBusy(true)
    setError(null)
    try {
      const bytes = await file.arrayBuffer()
      const res = await fetch('/api/admin/members/import/preview', {
        method: 'POST',
        headers: { 'content-type': 'text/csv' },
        body: bytes,
      })
      const data = await res.json().catch(() => null)
      if (res.ok && data?.ok) {
        setReport(data.report as ImportReport)
        setToken(data.confirmationToken as string)
        setPhase('previewed')
        setAcknowledged(false)
      } else {
        setError(REASON_MESSAGE[data?.reason] ?? '預覽失敗，請再試一次')
      }
    } catch {
      setError('連線失敗，請再試一次')
    } finally {
      setBusy(false)
    }
  }

  async function apply() {
    const file = fileRef.current
    if (!file || !token || busy) return
    setBusy(true)
    setError(null)
    try {
      const bytes = await file.arrayBuffer()
      const res = await fetch('/api/admin/members/import/apply', {
        method: 'POST',
        headers: { 'content-type': 'text/csv', 'x-import-confirmation': token },
        body: bytes,
      })
      const data = await res.json().catch(() => null)
      if (res.ok && data?.ok) {
        setReport(data.report as ImportReport)
        setPhase('applied')
        setToken(null)
        fileRef.current = null // written — drop the raw file
      } else if (data?.reason === 'partial_apply') {
        // Some members were written before an error. Keep the file so the operator can
        // re-preview and re-apply (import is idempotent).
        setReport(data.report as ImportReport)
        setProcessedMembers(typeof data.processedMembers === 'number' ? data.processedMembers : null)
        setPhase('partial')
      } else {
        setError(REASON_MESSAGE[data?.reason] ?? '匯入失敗，請再試一次')
        if (data?.reason === 'preview_mismatch' || data?.reason === 'preview_expired') {
          setPhase('idle')
          setToken(null)
        }
      }
    } catch {
      setError('連線失敗，請再試一次')
    } finally {
      setBusy(false)
    }
  }

  const hasSkips =
    !!report &&
    (report.totals.validationErrors > 0 ||
      report.totals.phoneNameConflicts > 0 ||
      report.totals.identityConflicts > 0 ||
      report.totals.plateConflicts > 0 ||
      report.totals.batchPlateConflicts > 0 ||
      report.totals.groupConflicts > 0)

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col gap-6 bg-page px-6 py-10 text-ink">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">名單匯入</h1>
        <p className="mt-1 text-sm text-muted">
          支援兩種格式（依表頭自動辨識）：<strong>P2 申請表</strong>（含「申請原因」）或<strong>全體名單</strong>（含「優先序」）。CSV 用 UTF-8。匯入只寫資料紀錄，不會變動 LINE 綁定。
        </p>
        <p className="mt-1 text-xs text-muted">
          全體名單的「優先序」P1（全職同工）僅建立一般會友與車牌，<strong>不會</strong>建立全職同工／本週 P1 身分（P1 輪值由其他功能管理）。
        </p>
      </header>

      <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-6">
        <p className="text-xs text-warning-fg">
          此檔含會友個資，請勿另存他處或貼到共用日誌。預覽結果依當下資料狀態產生，最終以「確認寫入」後的報告為準。
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={onPick}
            className="text-sm text-ink file:mr-3 file:min-h-11 file:rounded-lg file:border file:border-border file:bg-page file:px-4 file:text-ink hover:file:border-primary"
          />
          <button
            type="button"
            onClick={preview}
            disabled={!fileName || busy}
            className="inline-flex min-h-11 items-center rounded-xl bg-primary px-5 text-sm font-semibold text-white transition-colors hover:bg-primary-strong disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
          >
            {busy && phase === 'idle' ? '處理中…' : '上傳並預覽'}
          </button>
        </div>
        {error && (
          <p className="rounded-lg border border-danger-fg/30 bg-danger-bg px-4 py-2 text-sm text-danger-fg">{error}</p>
        )}
      </section>

      {report && phase === 'partial' && (
        <p className="rounded-xl border border-danger-fg/30 bg-danger-bg px-4 py-3 text-sm text-danger-fg">
          匯入中途發生錯誤，可能已寫入部分資料
          {processedMembers !== null ? `（已處理 ${processedMembers} 位會友）` : ''}
          。請保留此檔、重新預覽後再匯入一次——匯入具冪等性，不會重複建立相同車輛。
        </p>
      )}

      {report && (
        <ReportView report={report} />
      )}

      {report && phase === 'previewed' && (
        <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-6">
          {hasSkips && (
            <label className="flex items-start gap-2 text-sm text-warning-fg">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={e => setAcknowledged(e.target.checked)}
                className="mt-0.5 accent-primary"
              />
              <span>上方標記為錯誤/衝突的列會被略過，其餘合法會友仍會寫入。我已了解並仍要匯入。</span>
            </label>
          )}
          <div>
            <button
              type="button"
              onClick={apply}
              disabled={busy || (hasSkips && !acknowledged)}
              className="inline-flex min-h-11 items-center rounded-xl bg-primary px-5 text-sm font-semibold text-white transition-colors hover:bg-primary-strong disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            >
              {busy ? '寫入中…' : '確認寫入'}
            </button>
          </div>
        </section>
      )}

      {report && phase === 'applied' && (
        <section className="flex flex-col gap-3 rounded-xl border border-success-fg/30 bg-success-bg p-6">
          <p className="text-sm text-success-fg">
            匯入完成：新增 {report.imported} 位、更新 {report.updated} 位、車輛 +{report.vehiclesAdded}。
          </p>
          <div>
            <button
              type="button"
              onClick={resetAll}
              className="inline-flex min-h-11 items-center rounded-xl border border-border bg-surface px-4 text-sm text-ink transition-colors hover:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            >
              匯入下一份
            </button>
          </div>
        </section>
      )}
    </main>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-border bg-surface px-4 py-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="text-lg font-semibold tabular-nums text-ink">{value}</div>
    </div>
  )
}

function ReportView({ report }: { report: ImportReport }) {
  return (
    <section className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="資料列" value={report.rows} />
        <Stat label="會友數" value={report.members} />
        <Stat label={report.dryRun ? '將新增' : '新增'} value={report.imported} />
        <Stat label={report.dryRun ? '將更新' : '更新'} value={report.updated} />
        <Stat label="車輛" value={report.vehiclesAdded} />
        <Stat label="眷屬" value={report.dependentsAdded} />
      </div>

      {report.truncated && (
        <p className="rounded-xl border border-warning-fg/30 bg-warning-bg px-4 py-2 text-sm text-warning-fg">
          問題項目過多，各清單僅顯示前 500 筆（實際數量見各區塊標題）。
        </p>
      )}

      <IssueList
        title="格式錯誤（將略過）" total={report.totals.validationErrors}
        empty={report.validationErrors.length === 0}
      >
        {report.validationErrors.map((v, i) => (
          <li key={i}>第 {v.line} 列：{v.errors.join('；')}</li>
        ))}
      </IssueList>

      <IssueList
        title="同號不同名（將略過）" total={report.totals.phoneNameConflicts}
        empty={report.phoneNameConflicts.length === 0}
      >
        {report.phoneNameConflicts.map((c, i) => (
          <li key={i}>{c.phone}：{c.existingName ? `既有「${c.existingName}」vs 檔案「${c.names.join('／')}」` : c.names.join('／')}</li>
        ))}
      </IssueList>

      {/* Tier 0-2 (0038). Deliberately worded as a QUESTION with a next step, not as an
          error: the usual cause is a member whose phone changed, and importing anyway
          would split them into two records that cannot be merged back. */}
      <IssueList
        title="姓名已存在於名冊、但手機號碼是新的（將略過）" total={report.totals.identityConflicts}
        empty={report.identityConflicts.length === 0}
      >
        {report.identityConflicts.map((c, i) => (
          <li key={i}>
            {c.name}（檔案手機 {c.phone}）：名冊中已有
            {c.candidates.map(k => `${k.phoneMasked}${k.evidence === 'same_name_and_plate' ? '（車牌相同）' : ''}`).join('、')}
            。若是同一人換號碼，請到「會友管理」開啟該會友直接改手機；若確定是不同人，請到「會友管理→新增會友」建立。
          </li>
        ))}
      </IssueList>

      <IssueList
        title="車牌衝突（DB 已有他人此車牌，該車牌略過）" total={report.totals.plateConflicts}
        empty={report.plateConflicts.length === 0}
      >
        {report.plateConflicts.map((c, i) => (
          <li key={i}>{c.phone}：{c.plates.join('、')}</li>
        ))}
      </IssueList>

      <IssueList
        title="檔案內車牌重複（同車牌多人，整位略過）" total={report.totals.batchPlateConflicts}
        empty={report.batchPlateConflicts.length === 0}
      >
        {report.batchPlateConflicts.map((c, i) => (
          <li key={i}>{c.plate}：{c.phones.join('、')}</li>
        ))}
      </IssueList>

      <IssueList
        title="同手機資料不一致（整位略過）" total={report.totals.groupConflicts}
        empty={report.groupConflicts.length === 0}
        note={<span className="text-xs text-muted">每人一次只顯示一項；修正後重新預覽可能顯示下一項</span>}
      >
        {report.groupConflicts.map((c, i) => (
          <li key={i}>
            {c.phone}：{GROUP_CONFLICT_FIELD_LABEL[c.field]}{c.subject ? `（${c.subject}）` : ''} {c.values.join('／')}
          </li>
        ))}
      </IssueList>

      <IssueList
        title="待覆核（已建立、需人工補核）" total={report.totals.reviewRequired}
        empty={report.reviewRequired.length === 0}
        note={<Link href="/admin/eligibility" className="text-primary hover:underline">前往資格審查 →</Link>}
      >
        {report.reviewRequired.map((r, i) => (
          <li key={i}>{r.phone}（{r.reason}）</li>
        ))}
      </IssueList>

      <IssueList
        title="已保留既有 P2 資格（本次標一般會友、未變更）" total={report.totals.p2Retained}
        empty={report.p2Retained.length === 0}
      >
        {report.p2Retained.map((r, i) => (
          <li key={i}>{r.phone}</li>
        ))}
      </IssueList>

      <IssueList
        title="已撤銷資格未被復原（名單標 P2，但曾由同工撤銷）" total={report.totals.revokedRetained}
        empty={report.revokedRetained.length === 0}
        note="匯入不會推翻同工的撤銷決定。若確實要恢復，請到該會友的明細頁重新核准。"
      >
        {report.revokedRetained.map((r, i) => (
          <li key={i}>{r.phone}</li>
        ))}
      </IssueList>

      <IssueList
        title="人工管理的資格未被更新（名單標 P2，但已經同工覆核）" total={report.totals.governedRetained}
        empty={report.governedRetained.length === 0}
        note="此會員的 P2 資格已由幹事人工管理，本次匯入只更新會員與車輛資料，不更新資格、依親或有效期間。若要改資格，請到該會友的明細頁。"
      >
        {report.governedRetained.map((r, i) => (
          <li key={i}>{r.phone}</li>
        ))}
      </IssueList>
    </section>
  )
}

function IssueList({
  title, total, empty, note, children,
}: {
  title: string
  total: number
  empty: boolean
  note?: React.ReactNode
  children: React.ReactNode
}) {
  if (empty) return null
  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink">{title}（{total}）</h3>
        {note}
      </div>
      <ul className="mt-2 space-y-1 text-sm text-muted">{children}</ul>
    </div>
  )
}
