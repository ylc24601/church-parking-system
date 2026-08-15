// Wave 1c (#12) — the data-minimization boundary, stated on screen.
//
// P2 eligibility is health-adjacent. The system deliberately stores only a reason CATEGORY and a
// validity window — never a diagnosis, certificate or medical record. That restraint has so far
// lived only in code comments, where the operator can't see it: someone reading 「行動不便（長期）」
// may quite reasonably wonder whether to ask the member for proof. Say the boundary out loud, on
// the pages where reasons are visible, so it becomes a rule staff can follow.
//
// Purely presentational: no props, no state.
export default function DataMinimizationNotice() {
  return (
    <div className="rounded-xl border border-info-fg/30 bg-info-bg px-4 py-3">
      <p className="text-sm font-semibold text-info-fg">資料最小化</p>
      <p className="mt-1 text-sm leading-relaxed text-ink">
        本系統<strong>不索取、不儲存、不顯示</strong>診斷證明、病歷或其他醫療文件。P2 資格僅確認
        <strong>符合的事由分類與適用期限</strong>；<strong>請勿詢問或登錄診斷細節</strong>，
        也不要拍攝、上傳或留存會友的醫療文件。
      </p>
      <p className="mt-1 text-xs leading-relaxed text-muted">
        無法判定時，僅確認是否符合現有分類，必要時交由負責同工人工覆核。
      </p>
    </div>
  )
}
