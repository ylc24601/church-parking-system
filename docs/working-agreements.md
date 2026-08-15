# 工作約定

怎麼在這個 repo 上工作。版圖與指令看根目錄的 [`AGENTS.md`](../AGENTS.md)，
審查流程看 [`review-protocol.md`](review-protocol.md)。

## 語言

一律以繁體中文回應，除非明確要求英文。不要用日文或簡體中文。
交付文件（runbook、handbook、操作指南）以繁體中文書寫，技術術語保留英文原文即可。

## Git staging

**不要用 `git add -A`、`git add .` 或含萬用字元的路徑。** 先 `git status --short`
看清楚，再逐檔列出：`git add docs/a.md parking-system/lib/b.ts`。

理由不是潔癖。曾有一次 `git add -A` 把含真實姓名與電話的名冊 CSV 提交進這個**公開**
repo，需要 force-push 清理與金鑰輪替。`docs/import-templates/` 因此改採白名單——
預設整個目錄 ignore，只有交付用的範本被追蹤（見 `.gitignore` 的 import templates 段落）。
哪些資料不得入版控見根目錄 `AGENTS.md`〈資料邊界〉。

被本機 hook 擋下時，正確反應是逐檔列出，不是找路繞過。

### commit 與分支

- 分支：`type/kebab-slug`；type 用 `feat` / `fix` / `docs` / `chore` / `ops`
- commit 訊息：conventional commit 開頭，主體可用中文
- **一刀一 PR、squash merge**，維持線性歷史
- 堆疊分支 rebase 後，用 `git range-diff` 證明內容全等（全 `=`）再沿用原本的 approval
- commit 結尾附 `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
- 未經要求不 commit、不 push

## 文件誠實

`docs/` 底下的東西是要交給別人照著操作的。寫錯比沒寫更糟。

- 不要宣稱某個功能、開關、gate 存在，除非能指出 `檔案:行號`。宣稱前先 grep，不要憑記憶複述。
- 無法驗證的敘述明確標 `（未驗證）`，不要用推測填空。
- checklist 打勾時附上完成它的 PR 或 commit。
- 改行為的 PR 要同時更新對應文件；只改文件的 PR 用 `docs:` 開頭。
- 權威是檔案本身。營運 runbook 這類頻繁變動的文件（維護於私有 repo），
  回答前先讀過再說。

- **不要把精確計數寫進散文**（「共 16 個模組」「149 個測試檔」）。沒有任何東西會在它
  過期時告訴你，而它一定會過期。指向那個會紅的測試或那條指令的輸出，讓數字有人守。
- **不要連結到沒進版控的東西。** 那個連結在你的機器上是活的、在別人 clone 出來的樹上
  是死的。刻意留在本機的產出（`docs/*.html`）一律寫成行內程式碼。

`npm run check:docs` 把上面幾項機器化：驗 `docs/` 裡指向程式碼的相對連結目標存在、
`#L12-L34` 行號沒超出檔案。程式碼搬家後這類引用會安靜失效，而文件看起來仍然言之鑿鑿。

**它只在乾淨的樹上有意義。** 在自己的工作目錄跑，未追蹤的本機檔案會讓死連結看起來是活的
——這正是 `app-ci.yml` 的 `repo-gates` job 存在的理由：在 fresh checkout 上跑一次，
證明的才是 repository 的狀態，而不是某一台筆電的狀態。

## Plan mode（Claude Code）

呼叫 ExitPlanMode 之前，計畫要有一段「自審阻擋項」，逐條交代：

1. **查詢邊界語意** — `.lt` vs `.lte`、含頭不含尾、時區換日
2. **null 與空狀態** — 「查無資料」和「健康、數字剛好是零」必須渲染成不同的東西
3. **列數上限** — 計數與清單查詢有沒有隱含的 row cap
4. **錯誤波及範圍** — 單一 fetch 失敗不該清掉不相關的狀態
5. **CI `permissions:` 最小權限**，以及驗證路徑（workflow_dispatch、RPC 名稱）是否真的存在
6. 每個「已驗證」的宣稱附 `檔案:行號`；沒驗證的直說沒驗證

這六條不是通則，是過去外部審查在這個專案實際抓到的缺陷類型。
