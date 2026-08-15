# Phase 9 Slice 3.5 — Design Spec（選定：Member A ＋ Staff C ＋ Admin B）

> 這是 mockup-first 選定後的**實作規格**，Slice A/B/C 改真實元件時以此為準。
> 定案：**Member = 方向 A（溫暖圓潤）／Staff = 方向 C（營運分區）／Admin = 方向 B（清爽極簡）**。
> 三端**共用同一組 tokens／type／spacing／badge 語意／a11y／responsive**（讓三端像同一產品），
> 只在 **radius／elevation／density／signature** 做各端差異化。
> **presentation-only**：不動 route/API/auth/RLS/schema/service/業務規則；資料一律接真實、不硬編 mockup 樣本；`⛪` 為暫時 fallback。
> 對照畫面↔狀態見 [screen-state-map.md](screen-state-map.md)；方向比較見 [comparison.md](comparison.md)。

---

## 1. 共用基礎（三端一致）

### 1.1 Color tokens（`@theme`，語意化；非只 `--color-line`）
```css
/* 品牌 vs 操作 vs 狀態 分開，避免色彩漂移 / 對比不足 */
--color-brand:    #06C755; /* LINE 品牌綠：僅 Member header 填色 + logo 情境；不可當白底小字 */
--color-primary:  #15803D; /* 系統主操作綠（按鈕/連結/選中） */
--color-primary-deep: #14532D; /* 深綠：Staff appbar / Admin 標題底線 / press */
--color-primary-strong:#166534;/* hover/press 中間態 */

/* 綠味中性家族（三端一致；page 值容許各端微調，見 §2） */
--color-ink:     #1C241F;  --color-muted:  #63736A;
--color-border:  #E1E6DD;  --color-border-subtle:#EDF0EA;  --color-surface:#FFFFFF;

/* 狀態語意（三端一致；與 accent 分離，只用於狀態不當裝飾） */
--color-success-fg:#15803D; --color-success-bg:#DCFCE7;
--color-warning-fg:#92400E; --color-warning-bg:#FEF3C7; /* icon 可用 #B45309 */
--color-info-fg:   #1D4ED8; --color-info-bg:   #DBEAFE;
--color-priority-fg:#6D28D9;--color-priority-bg:#F3E8FF; /* P1/⭐ 優先 */
--color-danger-fg: #B91C1C; --color-danger-bg: #FEE2E2;
--color-neutral-fg:#57605A; --color-neutral-bg:#EEF1EE;
```
- **淺色單一主題**：移除 `globals.css` 的 `@media (prefers-color-scheme:dark)` 強制深色 block。
- **對比守則（AA）**：LINE 綠 `#06C755` 對白對比不足 → **只**用於 header 填色（配深色 logo/字）或大面積實色鈕（配深色字），**不得**當白底小字。操作綠 `#15803D` 對白 AA 通過，作按鈕/連結/小字綠。

### 1.2 Typography
- **Faces**（系統堆疊，不引 webfont——CJK data-URI 不切實際，且與 production 一致，personality 靠字重/間距/顏色）：
  - sans：`-apple-system, BlinkMacSystemFont, "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", sans-serif`
  - mono（車牌/代碼）：`"SF Mono", ui-monospace, "Roboto Mono", Menlo, monospace`
- **Scale**（px / weight）：display 24–26/800・h1 20–22/800・h2 15–16/700–800・body 14–15/400–500・micro-label 10–11/700 `text-transform:uppercase; letter-spacing:.1em`・caption 12/400・plate 20–26/700。
- 車牌、計數、KPI、表格數字一律 `font-variant-numeric:tabular-nums`。標題 `text-wrap:balance`；長段落 line-height ~1.5、限寬 ~40 中文字。

### 1.3 Spacing
- 4px base scale（4/8/11/12/14/16/20/24…）。卡片 padding：Member/Admin 16、Staff 12–14（密度高）。stack gap 11–14。
- **觸控目標 ≥44px**（現有 `h-12`=48px 已符合）；相鄰群組用 flex/grid `gap`，不用會塌陷/加倍的 per-element margin。

### 1.4 Badge — state → tone（語意三端一致；**恆「顏色＋文字/圖示」雙編碼，不單靠顏色**）

| 狀態類型 | tone | token | 文字示例 |
|---|---|---|---|
| 成功／已核准／已到場／佇列正常 | success | green | ✓ 已核准・✓ 已到 10:05 |
| 等待／待處理／逾時釋出 | warning | amber | 候補中・已釋出 |
| 暫時核准／資訊／現場散客 | info | blue | 待確認・現場散客 |
| 優先資格（P1/⭐，不揭露原因） | priority | purple | ⭐ 優先 |
| 不可用／未申請／已結束 | neutral | gray | 尚未申請・僅供檢視 |
| 錯誤／危險操作／已取消 | danger | red | 已取消・連線失敗 |

- 形狀隨端別 treatment（§2）：Member/Staff 填色 pill、Admin outline——但**tone→顏色對映與雙編碼規則固定**。

### 1.5 Buttons
- primary＝實色 `--color-primary` 白字（主要動作，含遞補確認/點名）；warn＝amber（補點名）；danger＝red 或 red-outline（取消/結束點名/移車警示）；ghost＝surface＋border。**info 藍只用於狀態 Badge，不再作為任何端別的動作色**（2026-08-04 修訂，#39——原規則讓同一色同時代表狀態與動作，兩義不分）。
- 高度 ≥44px、weight 700–800、圓角依端別；**focus 可見**（2px `--color-primary` outline offset 2px）；`prefers-reduced-motion` 尊重。

### 1.6 Accessibility（quality floor，三端同守）
- 對比 AA（見 §1.1 綠色守則）；badge 雙編碼；鍵盤 focus 可見；觸控 ≥44px；動畫尊重 reduced-motion；圖示 emoji 為暫時 fallback、需 `aria-label`（如 ⭐→「優先車位」）。

### 1.7 Responsive（mobile-first；三端）
- **Member / Staff**：單欄，`max-w` ~400（LIFF/手機），平板置中留白；Staff 亦支援 iPad（名單留白、底部動作列）。
- **Admin**：手機 sidebar 收合為頂部導覽/抽屜、內容單欄堆疊；桌面 ≥1280 sidebar＋content；**表格/寬內容包 `overflow-x:auto`**，body 永不水平捲動。
- 斷點驗收：375 / 768 / 1280。

### 1.8 Metadata 修正（Slice A，**低風險 a11y／product-metadata correction，非色彩 polish**）
- `app/layout.tsx`：`lang="zh-TW"`；`metadata.title/description` 改實際名稱（如「內湖信友堂 停車管理」）。PR 描述據實標記。

---

## 2. 各端 treatment（差異化，套用 §1 共用基礎）

### 2.1 Member = 方向 A（溫暖圓潤）
- page `#F4F6F1`；卡片 radius **20**、btn radius 16；柔和陰影（card `0 1px 2px`、hero `0 8px 20px`）。
- **Signature**：LINE 綠（`--color-brand`）頂條（⛪＋「內湖信友堂 停車服務」）＋綠色漸層「本週主日」hero banner（`linear-gradient(135deg,#15803D,#166534)` 白字——深綠對白 AA 通過，日期放大）。
  - **品牌綠 a11y（必修）**：`#06C755` 為品牌識別，白字對其約 1.9:1 不足 AA。頂條若用 `#06C755` 實色，**文字/logo 改深色 ink**（`--color-ink`，對 `#06C755` ≈AA 通過），不用白字；或改用 `--color-primary`/`--color-primary-deep` 實色配白字。gradient 需驗證起點/中段/終點三處對比。`themeColor` 可用 `#06C755`（瀏覽器 chrome，非正文背景）。一般文字 ≥4.5:1、大型 ≥3:1、focus ring 與背景明顯對比。
- 狀態白卡＋填色 pill badge；車牌放大（22–26px）；主鈕綠、取消紅框、次要灰框。
- 元件：`MemberStatus`（含 `OfferActions`/`OnTheWayButton`/`CancelButton`/`ApplyBlock` 只換樣式、保留邏輯）、`MemberLiffGate`（gate 狀態）、`BindingClaimForm`。

### 2.2 Staff = 方向 C（營運分區）
- page `#EAEEE8`；卡片/列 radius **14**、btn 12；**列左側 4px 嚴重度色條**（minimal 陰影）。
- **Signature**：深綠 appbar（`--color-primary-deep`）＋計數列（已到/未到/已釋出/現場，tabular-nums，真實計數）；名單列左色條 keyed by status：
  - done（attended*）→ success 綠、已到列 opacity 降低
  - released_late → warning 琥珀
  - walk-in → info 藍
  - priority（⭐）→ priority 紫
  - approved/未到 → neutral 灰
- 大鈕（2026-08-04 修訂，#37/#39/38a——見 `staff-action-color-and-settle.html`／`staff-move-car-entry.html`）：點名 primary 綠、＋現場散客 primary 綠、補點名維持 warning 琥珀、結束點名維持 danger（appbar 文字按鈕，非 overflow menu）、通知移車維持 priority 紫框（**已移至 footer 統一入口**，逐列按鈕已移除）。bottom-sheet（walk-in/settle/move-car/通知移車搜尋）淺色化；PIN pad 淺色＋綠 accent。
- 保留：offline banner／undo toast／finalized 唯讀／cache／所有 fetch 邏輯。
- 元件：`StaffCheckIn`、`StaffLogin`、`staff/print/*`。
- **排除**：靜態「10:30/10:45 釋出」時間提示條（操作規則文案、無服務端來源）。

### 2.3 Admin = 方向 B（清爽極簡）
- page `#FBFBFA`（近白，利資料密度）；卡片 radius **12**、btn 10；**髮絲線邊框、無陰影**。
- **Signature**：標題底部 2px 綠線；sidebar 選中 `inset 2px 0 primary`；表格 gray-uppercase 表頭、`tabular-nums`；badge 走 outline（tinted 邊＋文字）。
- KPI／表格為主；主鈕綠、其餘 ghost；數據對齊優先。
- 元件：`AdminHome`（導覽卡改綠系）、`AdminLogin`/`LogoutButton`，＋8 子頁（`bindings/BindingReview`、`members/MemberSearch`＋`[id]/page`＋`IssueBindingCode`、`accounts/AdminAccounts`、`eligibility/page`（唯讀）、`import/MemberImport`、`ops/OpsDashboard`、`pastoral/PastoralAlerts`、`staff-pin/StaffPinManager`）。
- **保留現有路由結構**（每頁獨立 route＋首頁導覽 grid），**不**改單頁 SPA。

---

## 3. 共用元件產出（Slice A 地基）
- `app/globals.css`：§1.1 tokens 全組（`@theme`）、移除強制深色、body 底/前景/CJK font stack（車牌 `font-mono`）。
- `app/ui/Badge.tsx`：`tone` prop（success/warning/info/priority/neutral/danger）＋ text/icon slot；預設 pill（Member/Staff），`variant="outline"`（Admin）。（`app/ui/` 無 page.tsx，不產生 route。）
- 可選 `app/ui/theme.ts`：共用 class 常數（卡片/主次按鈕/欄位），精簡不過度抽象。
- `app/layout.tsx`：§1.8 metadata。

## 4. 跨端一致性驗收（收尾）
三端完成後做 cross-surface consistency review：同一 tone 的 badge 顏色一致、primary 綠一致、type scale 一致、spacing 節奏一致、focus 樣式一致；差異只落在刻意的 radius/elevation/density/signature。

## 5. 出範圍（重申）
Member 車牌 CRUD／候補序號／申請排序；Admin 統計/車位設定/稽核/分析/P2 approve/P1 標記；notif 範例頁；靜態時間規則提示條——皆不做。不引入 UI 套件、不維護雙主題。
