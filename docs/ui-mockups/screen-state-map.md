# Screen ↔ State ↔ Component map（mockup 對照現有實作）

> 每個 mockup 畫面都對應到**現有** component／state／action，確保沒有畫出「看似合理、實際無對應狀態」的內容。
> 三個方向（A/B/C）畫面組相同，僅視覺語言不同。此表為所有方向共用。
> 來源檔：`parking-system/app/**`。

## 會友端 · LINE LIFF

| Mockup 畫面 | 現有 component | state / 資料來源 | action → API |
|---|---|---|---|
| 已核准車位（車牌＋10:30 抵達） | `member/MemberStatus.tsx` | `reservation.status = 'approved'`；`statusView()` tone `ok`；`releaseDeadlineAt` | 取消 → `CancelButton` → `POST /api/member/reservation/cancel` |
| 遞補確認（確認保留／放棄） | `member/MemberStatus.tsx` → `OfferActions` | `status = 'temp_approved'`；`canRespondOffer`；`offerExpiresAt` | `POST /api/member/reservation/offer` `{action:'confirm'\|'decline'}` |
| 候補中 | `member/MemberStatus.tsx` | `status = 'waiting'`；tone `wait`（**無**候補序號欄位——不顯示 `#N`） | — |
| 登記本週停車（選車＋P2 同行宣告） | `member/MemberStatus.tsx` → `ApplyBlock` | `apply.vehicles`、`apply.companionKind`（`'elderly'\|'child'\|null`）、`apply.closed` | `POST /api/member/reservation/apply` `{vehicleId, requestedP2}` |
| 正在路上（保留至 10:55） | `member/MemberStatus.tsx` → `OnTheWayButton` | `canReportOnTheWay`（approved P2、未到、10:45 前） | `POST /api/member/reservation/on-the-way` |
| 綁定申請（姓名＋手機） | `member/BindingClaimForm.tsx` | gate `state='not_bound'`（來自 `MemberLiffGate`） | `POST /api/member/binding-claim` |
| 登入中 / 已過期 / 連線失敗 | `member/MemberLiffGate.tsx` → `GateMessage` | `connecting` / `invalid_token` / `unreachable` / `error` | `POST /api/member/login`；重試 = reload |
| 本週登記尚未開放 | `member/MemberStatus.tsx` | `sundayDate === null` | — |

**不畫（後端無對應）**：我的車牌管理頁（無會友端車輛 CRUD）、候補序號 `#N`、申請成功排序 `P2 第2位`、獨立申請成功頁（現況 `router.refresh()` 回狀態卡）。

## 同工端 · 主日現場點名

| Mockup 畫面/元素 | 現有 component | state / 資料來源 | action → API |
|---|---|---|---|
| 名單 · 已到場 | `staff/StaffCheckIn.tsx` | `DONE_STATUSES`（`attended` / `attended_after_release`）；`attended_at` | — |
| 名單 · 未到（點名鈕） | `staff/StaffCheckIn.tsx` | `status = 'approved'`；undo 視窗（`pendingRef` + `UNDO_MS`） | `POST /api/staff/checkin` |
| 名單 · 已釋出（補點名鈕） | `staff/StaffCheckIn.tsx` | `status = 'released_late'` → 補點名 `attended_after_release` | `POST /api/staff/checkin` |
| 名單 · 現場散客 | `staff/StaffCheckIn.tsx` | `isWalkIn(r)`（`walk_in_*`） | 由 walk-in 建立 |
| ⭐ 優先標示 | `staff/StaffCheckIn.tsx` | `is_priority`（**不揭露 P2 原因**） | — |
| 請移車 | `staff/StaffCheckIn.tsx` → `moveCarRow` sheet | `owner_notifiable`（bound line_id 才可按） | `POST /api/staff/move-car` |
| 計數（已到/未到） | `staff/StaffCheckIn.tsx` | `attendedCount` / `rows.length`（**真實計數**，非硬編） | — |
| 搜尋（車牌後四碼） | `staff/StaffCheckIn.tsx` | `query` + `normalizePlate` filter | 本地 filter |
| 篩選 chips（全部/未到/已到/已釋出） | `staff/StaffCheckIn.tsx` | `filter: 'all'\|'pending'\|'done'\|'released'` | 本地 |
| 登記現場車輛 sheet | `staff/StaffCheckIn.tsx` → `walkInOpen` | `walkInPlate` / `walkInName` | `POST /api/staff/walkins` |
| 結束當週點名 sheet（不可復原） | `staff/StaffCheckIn.tsx` → `settleOpen` | `releasedLateCount`；`finalized` 後唯讀 | `POST /api/staff/settle` |
| 離線中 banner | `staff/StaffCheckIn.tsx` | `offline` / `lastUpdated`；`loadStaffCache` fallback | 復網 → reload |
| 本週已結束（唯讀） | `staff/StaffCheckIn.tsx` | `event.status === 'finalized'` | 寫入全禁 |
| 已點名…尚未送出（復原 toast） | `staff/StaffCheckIn.tsx` | `pendingName` + `undo()` | — |
| PIN 登入 | `staff/StaffLogin.tsx` | 6 碼 pad；423 鎖定 | `POST /api/staff/login` |

## 管理員後台

| Mockup 畫面 | 現有 component / route | state / 資料來源 | 備註 |
|---|---|---|---|
| 首頁導覽（8 卡） | `admin/AdminHome.tsx` | 8 個 `Link` 到子頁 | 保留現有導覽，**非**單頁 SPA |
| 登入 | `admin/AdminLogin.tsx` | 帳密；401 合併文案 | `POST /api/admin/login` |
| 營運狀態（KPI＋死信重送） | `admin/ops/OpsDashboard.tsx` | `OutboxHealth`（due/pending/retrying/processing/stale/failed）、`OutboxAlert.healthy`、`failed_by_error` | requeue 走 preview→apply：`POST /api/admin/ops/requeue` |
| 綁定審核（遮罩列→預覽→核准/退回） | `admin/bindings/BindingReview.tsx` | pending list（masked）；版本防偷換 | `POST /api/admin/bindings/{preview,approve,reject}` |
| 會友管理（搜尋） | `admin/members/MemberSearch.tsx` | search 結果 | `POST /api/admin/members/search` |
| 會友明細（P2 資格／綁定碼） | `admin/members/[id]/page.tsx` + `IssueBindingCode.tsx` | detail；發碼一次性顯示 | `POST /api/admin/members/binding-code` |
| P2 資格審查 | `admin/eligibility/page.tsx` | **唯讀** sections（`title (count)`） | 不加 approve/reject（後端未支援） |
| 名單匯入（CSV upload→preview→apply） | `admin/import/MemberImport.tsx` | totals；preview/apply | `POST /api/admin/members/import/{preview,apply}` |
| 牧養關懷（待處理列→結案 dialog→已處理） | `admin/pastoral/PastoralAlerts.tsx` | `OpenAlertItem` / `ResolvedAlertItem`；resetCounter；備註 200 字 | `POST /api/admin/pastoral/resolve` |
| 現場 PIN 管理（發 PIN／解鎖） | `admin/staff-pin/StaffPinManager.tsx` | 當週 event；PIN 發行/解鎖 | `POST /api/admin/staff-pin/{issue,unlock}` |
| 列印點名表（紙本備援） | `admin/print/page.tsx` + `PrintButton.tsx` | `getAdminPrintSheet`：台北日曆當週主日；Staff-safe 列 | `/admin/print`（Wave 1a 由 `/staff/print` 搬入，不再用現場 PIN） |
| 帳號管理（停用／重設／撤銷） | `admin/accounts/AdminAccounts.tsx` | admin 帳號列 | `POST /api/admin/accounts/{disable,reset-password,revoke-sessions}` |

**不畫（mockup 有、後端無）**：本週概覽統計、本週車位設定、稽核記錄頁、停車樣態分析、P2 approve/reject 動作、P1 全職同工管理／標記本週不停。

## Functional states（每一端都須涵蓋）
`loading`（連線中）、`empty`（本週尚無核准車輛）、`success`（已送出）、`warning`（期限已過）、`error`（連線失敗）、`disabled`（送出中）、`submitting`（spinner）、`long-content`（長姓名／長車牌／Admin 大量資料表格／bottom sheet 小螢幕高度）。三份 mockup 底部皆有 states strip 示意。
