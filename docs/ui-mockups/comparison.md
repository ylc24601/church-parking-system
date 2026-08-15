> **狀態（2026-07-14）**：已選定 **Member A ＋ Staff C ＋ Admin B**（見文末建議）。
> **`design-spec.md` 為唯一 normative source（實作依據）**；本檔與三份 `option-*.html` 屬
> **historical design exploration（設計探索紀錄），非 implementation contract**——請勿日後從未選方案擷取樣式。

# Phase 9 Slice 3.5 — UI 重畫方向比較（mockup-first）

> 三個視覺方向，皆以**現有架構為準**（真實畫面／狀態／資料形狀），套淺色綠色語言。
> mockup 僅視覺參考、非產品規格；**不新增**車牌 CRUD、候補序號、P2 排序、通知範例頁等後端未支援項目。
> 畫面資料為示意，實作一律接真實資料。可**分端**挑選（Member／Staff／Admin 可混搭）。

| 方向 | Artifact | 原始檔 |
|---|---|---|
| A · 溫暖圓潤 Warm rounded | https://claude.ai/code/artifact/63c32993-7d9d-4708-9386-886791f2b10f | `option-a-warm.html` |
| B · 清爽極簡 Quiet minimal | https://claude.ai/code/artifact/94bb780d-de6e-4fcd-a07a-2866148bf4b1 | `option-b-quiet.html` |
| C · 營運分區 Operational | https://claude.ai/code/artifact/18a5dcb5-1c35-4234-8f9d-8dc102f3f081 | `option-c-operational.html` |

三份皆單一淺色主題；品牌圖示 `⛪` 標為暫時 fallback（正式定案為教會 logo／SVG／文字標誌）。

---

## 逐項比較

### 視覺特色
- **A 溫暖圓潤**：LINE 綠實色頂條＋綠色漸層「本週主日」banner；大圓角（20px）白卡、柔和陰影、寬鬆留白；pill badge 飽和度較高。最貼近教會參考圖、最親切。
- **B 清爽極簡**：近白底、**髮絲線**取代陰影、小圓角（12px）；綠色只用於主要操作與成功，其餘走中性墨色；outline/tinted 的安靜 badge；強字重對比與數字對齊（tabular-nums）。最冷靜現代。
- **C 營運分區**：卡片與名單列**左側 4px 嚴重度色條**、密度較高、頂部計數列；以 P1 紫／P2 藍／警示琥珀／危險紅做結構化分區。最「儀表板」、昏暗停車場一眼可讀。

### Member 適合度（LIFF，會友、每週一次、情感取向）
- **A ✔ 最佳**：親切溫暖，綠 banner 有牧養感，最符合會友期待。
- **B ○ 佳**：乾淨好讀，但偏冷、少一點溫度。
- **C △ 可**：色條分區對單純的會友狀態稍顯「工程感」，非必要複雜。

### Staff 適合度（現場點名、手機/iPad、昏暗、快速）
- **A ○ 佳**：大鈕好按，但陰影/圓角在強光下對比略弱。
- **B ○ 佳**：乾淨，但狀態全靠 badge、缺快速掃描的色塊。
- **C ✔ 最佳**：左色條讓「未到／已釋出／現場／優先」一眼分辨，計數列直接、密度高看得多。

### Admin 適合度（後台、桌面、資料密集、8 子頁）
- **A ○ 佳**：卡片好看，但表格密集頁的柔和陰影稍鬆散。
- **B ✔ 最佳**：髮絲線＋數字對齊最適合表格與 ops 數據，專業克制。
- **C ✔ 佳**：KPI 色條分區讓營運狀態最快讀出；資訊密度高。

### 無障礙風險
- **A**：綠底白字（LINE 綠 `#06C755` 上白字）對比需注意——已把白字保留在深綠 banner、LINE 綠頂條只放深色字/logo。pill badge 皆文字＋圖示，非純色。
- **B**：中性墨色對比佳；風險在**過度低對比**的 muted 文字，需守 WCAG AA；badge 為 outline＋文字。
- **C**：色彩最多，風險是**只靠顏色分區**——已規定色條**恆搭配文字 badge**（如「已釋出」「現場散客」），不單靠顏色。
- 三者共同：badge 一律「顏色＋文字/圖示」雙編碼；觸控目標 ≥44px；保留鍵盤 focus。

### 實作複雜度（改真實元件的成本）
- **A 低–中**：與現有 `rounded-2xl` 結構最接近，主要是換色＋加 banner/badge 元件。
- **B 低**：移除陰影、統一髮絲線與 token 即可，結構動最少。
- **C 中**：需新增左色條與狀態→色條對映、計數列，Staff/Admin 版型調整較多。

### 與現有元件差異（現況：深色 slate/sky）
- 三者都需要：`globals.css` 淺色化、語意 token、`Badge` 元件、`layout.tsx` metadata 修正（低風險 a11y 修復）。
- A 對 Member `hero` 結構改動最多（新增 banner）；C 對 Staff 列與 Admin KPI 改動最多（色條/計數列）；B 改動面最小（多為 class 替換）。

---

## 建議選擇

- **想最貼近教會參考圖、最親切** → 全端 **A**。
- **想最專業克制、後台最清爽** → 全端 **B**，或 Member 稍嫌冷可 Member 用 A。
- **重視現場點名效率＋後台營運可讀** → **混搭**：Member **A**（溫暖）＋ Staff **C**（分區）＋ Admin **B 或 C**（數據）。

> 個人建議（供參考，非定案）：**Member A ＋ Staff C ＋ Admin B**——各取所長：會友端溫暖、同工端現場高效、後台專業。若偏好整體一致、少決策，則全端 **A**（最安全、最貼近參考圖）。

下一步：於 `screen-state-map.md` 對照每個 mockup 畫面 → 現有實作；選定後收斂成 `design-spec.md`（tokens／typography／spacing／component patterns／state-tone mapping／responsive rules），再進 Slice A/B/C 改真實元件。
