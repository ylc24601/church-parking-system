# Review protocol — 獨立審查怎麼跑

程式：[make-review-pack.sh](../scripts/review/make-review-pack.sh)、[check-review-workspace.sh](../scripts/review/check-review-workspace.sh)、[deny-patterns.txt](../scripts/review/deny-patterns.txt)、[templates/](../scripts/review/templates/)。

這份是**唯一完整規則**。`AGENTS.md`、`CLAUDE.md` 只指過來，不重複內容——兩份會漂移的規則等於沒有規則，同樣的理由寫在 `REVIEW.md` 的產生器標頭裡（"Do not maintain a second template"）。

## 0. 為什麼需要這套

只讀實作者摘要的審查，審的是一段說法，不是一次變更。GitHub 帳號停權期間連 PR 與 CI 這層外部關卡都沒有，所以證據必須由機器產生、由第三方在本機讀。分工固定成：

| 角色 | 是誰 | 邊界 |
|---|---|---|
| implementer | Claude Code | 寫程式、產 packet、寫 RESPONSES |
| independent reviewer | **另一個不是 implementer 的 agent session** | 只讀，唯一可寫 `.review-notes/` |
| CI / merge | GitHub Actions | 帳號恢復後才回到流程 |

**reviewer 這一格刻意不寫死是哪一家。** 這條線的價值來自 independence，不來自特定工具——先前寫「Codex」讓它讀起來像必要條件。實務上換人的時機有兩種：

- **它自己被擋住**。這類工具的安全過濾會在 reviewer 深入寫繞過用的 probe 時觸發（本 repo 實際遇到兩次，都停在寫 fixture 的階段）。**這時要換審查者，不要改成「只讀不寫 probe」**——前幾輪最有價值的發現全部來自它自己寫的 fixture（parent-directory swap、mid-verify rewrite、mutation test），拿掉那個能力等於保住形式、丟掉內容。
- **同一位連續審同一支分支太多輪**。它會開始沿用自己上一輪的框架；換一位是最便宜的重新取樣。

**兩者不共用 session，也不共用 worktree。** 同一個 session 先改再審，是自我背書；同一個工作區審查，會踩到下面第 2 節的機密邊界。

## 1. 完整性與機密性是兩件事

不能互相取代，這份文件所有規則都是這兩條的其中一條：

- **完整性（integrity）**：reviewer 讀的，是不是 packet 所描述的那個 commit 與那份證據？由 SHA、artifact checksum、乾淨工作樹、ancestry 檢查來守。
- **機密性（confidentiality）**：這個工作區能不能讓 reviewer 自由讀？由「專用的無 secret worktree」來守。

## 2. 工作區邊界（機密性）

**在專用的 review worktree 開 reviewer，不要在主工作樹開。**

理由不是整潔。主工作樹有 `parking-system/.env.local`（Supabase service role key、LINE token），review worktree 沒有——`.env*` 是 gitignored，`git worktree add` 不會帶過去。`deny-patterns.txt` 擋的是 packet 內容，讓 reviewer 直接讀主工作樹就整個繞過去了。

**誠實的措辭**：專用的無 secret worktree 是**把暴露面縮到最小的工作區邊界，不是 OS 級 sandbox**。它擋不住 `cat ../../<其他 worktree>/.env.local`、看不到已經 export 到 shell 的環境變數、也管不到 agent 在這個目錄之外的權限。所以以下同時成立，缺一不可：

- reviewer 用 read-only / suggest 權限，不給 Full Access
- 不在主工作樹開 reviewer
- 預設不執行需要 app env 的指令
- 不把 secret export 進 shell environment
- `check-review-workspace.sh` 會檢查工作區內沒有 `.env` / `.env.*`（`*.example` 除外）

## 3. Reviewer 可以做什麼

- 讀 `.review/` 的全部證據，**以及 repository 的實際原始碼**
- `git log` / `git diff` / `rg` / 靜態搜尋
- 針對性的單元測試、ShellCheck、任何無副作用的唯讀指令
- 執行 `scripts/review/check-review-workspace.sh`（只讀，不寫檔）

**不可以**修改任何 tracked 檔案。**唯一允許的寫入是 `.review-notes/`。**

這條要寫死，因為「完全不准寫檔」和「產出 findings artifact」直接衝突。`.review-notes/` 是 gitignored，所以寫 findings 不會讓第 4 節的乾淨工作樹檢查失敗。

## 3.5 一次審查怎麼開始（implementer 這一側）

這一節補的是本文件原本沒寫、只存在某個人記憶裡的三件事：worktree 怎麼建、packet 怎麼進去、reviewer 用什麼啟動。**沒有寫下來的步驟，在交接時就是斷掉的步驟。**

```bash
# ① 先寫敘述，再產 packet —— 順序不能反（理由見第 4.5 節）
cp .github/PULL_REQUEST_TEMPLATE.md .review-narrative.md   # 然後把它填完
scripts/review/make-review-pack.sh --base <base>           # 自動撿 .review-narrative.md

# ② 建 review worktree —— detached 在剛剛那個 HEAD 上，不要帶分支名
git worktree add --detach ../Parking-worktrees/<branch-basename> "$(git rev-parse HEAD)"

# ③ 把 packet 送進去。`.review/` 是 gitignored ⇒ `git worktree add` 不會帶過去
cp -R .review ../Parking-worktrees/<branch-basename>/.review

# ④ 在那個目錄開 reviewer，prompt 用 scripts/review/templates/PROMPT.md
```

**`--detach` 不是風格偏好，是讓這四行真的能照順序跑完。** 一支分支同時只能被一個 worktree checkout；第 ① 步你人就在那個分支上，所以 `git worktree add <path> <branch>` 會直接被 git 拒絕。可以先 `git switch main` 再帶分支名，但那要求 implementer 在審查期間離開自己的分支——而審查回來就是要改那支分支。detached 同時解決兩件事：

- implementer 留在分支上，收到 findings 可以直接改、直接 amend，不必先拆掉 reviewer 的工作區。
- reviewer 的 HEAD **釘在被審的那個 commit**，你在旁邊 amend 也不會把它腳下的地板換掉。`check-review-workspace.sh` 比對的是 `HEAD == manifest head_sha`，detached 一樣成立。

改完要開下一輪時，**第 ③ 步不能照抄**：`cp -R .review <dest>/.review` 在目的地已經存在時，複製出來的是 `<dest>/.review/.review/`，舊 packet 原封不動留在上層——reviewer 會繼續審上一輪的證據，而 precheck 仍然是綠的（它驗的是那份舊 manifest，而舊 manifest 與舊 artifact 彼此自洽）。

```bash
# 下一輪：先刪再複製，舊 artifact 不能有殘留
scripts/review/make-review-pack.sh --base <base>
rm -rf ../Parking-worktrees/<branch-basename>/.review
cp -R .review ../Parking-worktrees/<branch-basename>/.review
git -C ../Parking-worktrees/<branch-basename> checkout "$(git rev-parse HEAD)"
```

`.review-notes/` **不要一起刪**——上一輪的 FINDINGS 與 RESPONSES 正是這一輪的基準（第 7 節）。**只有在真的要丟掉 worktree 時才 `git worktree remove`，而移除前先把 `.review-notes/` 整個帶走**（第 8 節）。

- **reviewer 的 reasoning effort 要調高。** 這類工具的預設常常偏低，而低 effort 審查會退化成複述 diff。
- **packet 由 implementer 在自己的工作樹產**（那裡才有完整 toolchain），reviewer 端只讀。**產完的 `.review/` 不要留在別人會從那裡啟動 reviewer 的地方**——殘留的舊 packet 若剛好與 HEAD 相符，precheck 會安靜地通過。

## 4. 每次審查的固定動作

前置需求：reviewer 的機器要有 `git`、`bash` 與 **`node`**（`check-review-workspace.sh` 用它讀 manifest，不需要 `node_modules`）。

```bash
# 1. 在 review worktree
scripts/review/check-review-workspace.sh --phase pre     # 輸出整段留著

# 2. 讀證據，順序不要反過來
#    .review/manifest.json → STATUS.txt / COMMITS.txt / FILES.txt
#    → DIFF.patch → logs/ → 最後才是 REVIEW.md（那是敘述）
#    → repository 實際 source

# 3. 寫 findings
cp scripts/review/templates/FINDINGS.md .review-notes/FINDINGS-<head12>.md

# 4. 收尾——把 pre 印出的 SNAPSHOT token 原樣傳回
scripts/review/check-review-workspace.sh --phase post --expect '<pre 的 token>'
```

**`--expect` 不是選配，沒帶就是 `VOID`。** 兩個 phase 原本各自描述「跑的那一刻」，所以一場審查即使 HEAD 與 packet 中途**整組**被換掉，pre 與 post 仍會各自回 `RESULT: OK`——這實際發生過一次（pre `10719a5b797f`／`ea5fc97f…`，post `85f4db4646fd`／`d1d956f4…`，兩次都 OK），而當時 usage 還寫著 post 能證明「snapshot 沒有移動」。它證明不了：沒有任何東西把 pre 的值帶到 post。現在 pre 會印一組 `SNAPSHOT token`（`<head12>:<manifest_sha256>`），post 用 `--expect` 收回來比對，不符即 `VOID`。

**沒帶 token 的 post 一度只給 WARN**（理由是「舊流程還在用的人得到警告而不是斷掉」）。**那個理由不成立**：這裡沒有那個族群，而 WARN 的結尾寫的是「review may proceed」——對一個什麼都沒證明的 phase 來說，那正好是相反的指示。token 事後也補不回來：審查結束後再跑一次 pre 只會印出「現在」的值。所以現在直接 `VOID`。

**`--expect` 相符時，證明的是「pre 與 post 兩端看到同一個 `<head12>:<manifest_sha256>`」——不是「中間沒有動過」。** 換掉再換回來，和從未動過完全一樣。這和敘述路徑檢查是同一條界線：**偵測到變化不等於防止變化**。

**驗收條件：沒有 PRECHECK 區塊的 verdict 不採信。** 規則寫在驗收端（implementer 能據以行動的東西），不是執行端——有腳本不等於有人跑，這正是 `app-ci.yml` 存在的同一個理由。

**收到 findings 之後，implementer 自己核對一次 review worktree 的 HEAD 與 `manifest.json` 的 sha256**，不要只讀貼上來的那兩段輸出。`--expect` 綁的是兩次執行之間的值，不是「這段文字來自一次執行」——見第 9 節。

## 4.5 敘述先寫，再產 packet

`REVIEW.md` 和其他 artifact 一樣被算 checksum。這一點和「它是給 implementer 填的表單」曾經直接衝突：packet 產出的是一份**空白 PR 範本**，而填它——它存在的唯一目的——會讓自己的 hash 失效，`check-review-workspace.sh` 判 `VOID`。（實際踩過，2026-08-09。）

所以敘述要**先寫成檔案、再交給 packet**，hash 才蓋得住最終文字：

| | |
|---|---|
| 預設路徑 | `.review-narrative.md`（gitignored；存在就自動採用） |
| 指定路徑 | `--narrative <file>` |
| 寫了但檔案不存在 | **直接失敗**，不會默默退回空白範本 |
| 沒寫 | 照舊產出空白範本，但 `REVIEW.md` 與 manifest 都會明寫「這是空白表單，不是對變更的說明」 |

**敘述必須涵蓋 PR 範本的每一個 `## ` 標題**，否則 packet 拒絕產出。理由：敘述會**取代**範本，若不檢查，自己寫散文就成了跳過 A/B/R 部署相容性那節的辦法——而那正是最不該能被跳過的一節。要求的標題是從範本**當場讀出來的**，不另外維護一份清單。

### 這道閘門擋的是「忘記」，不是「規避」

**先講天花板，因為它決定該用什麼標準審它。** 這道檢查無法判斷一節有沒有**被回答**——想跳過 A/B/R 的人，寫一行 `## Database compatibility` 底下留空就過了。所以「把標題藏進 HTML 註解」和「標題寫了但底下什麼都沒有」效果相同；只堵前者是**表演**，因為那個對手從一開始就沒有被擋住。

因此標準明訂如下，審查請照這個標準評分：

- **它是打錯字與漏一節的檢查。** 對象是正常書寫的文件。
- **「一節存在但沒有內容」由 reviewer 讀 `REVIEW.md` 抓**，不是由這支腳本抓。
- **針對它的缺陷回報，以「一般文件會不會誤判」為準**，不是「刻意構造的文件能不能繞過」。
- 目前的實作模型：fence（縮排 0–3、同字元、不短於開頭、closer 尾隨全空白）＋ CommonMark §4.6 的**七種** HTML block，各自的 start／end 條件照 spec（type 1 的 opener 可在行尾結束、任一種 end tag 都收尾、同列開關只影響該列；type 6 只認 spec 的 tag 清單；type 7 需要完整 tag 獨占一列且不得插進段落中間）。**認不得的標記當成一般文字**——這是有界模型不是 parser。
- **誤判一般文件比放過構造文件嚴重**：`<span>x</span>`、`<https://example.com>`、單列 `<style>…</style>` 都曾讓合法敘述無法提交，那是這道閘門最不該做的事。

> 沿革：這道閘門被連續四輪當成對抗性控制在審，每一輪都生出另一種 markdown 容器。那條路誠實的終點是在 awk 裡實作完整的 CommonMark parser——比它守護的東西還大。2026-08-09 由 repo owner 定案：標準用寫明的方式收斂，不用加碼的方式收斂。

比對規則寫死成三條，每一條都是審查抓出來的漏洞：

- **標題要是真的標題**：整行精確相符，且**不算在 code fence 裡面的**。把範本貼進 ```` ``` ```` 區塊曾經就能過關——那比沒有閘門更糟，因為它讀起來像有。
- **範本沒有任何 `## ` 就拒絕產出**：一份什麼都不問的範本無法守住任何東西，靜靜放行等於閘門失效。
- **空白或全是空白字元的敘述一律拒絕。**

`## Database compatibility 補充說明` **不算** `## Database compatibility`——精確比對是刻意的，錯誤訊息會列出缺哪幾節。

**敘述的機密邊界**（來自審查，五輪才收斂）：敘述是 packet 裡**唯一不是腳本自己產生**的輸入，所以 `make-review-pack.sh` 標頭那句「構造上沒有東西會被誤掃進來」對它不成立。五條限制：

- **檢查綁定到實際讀到的 bytes**：檔案只開一次，後續全部從那個 file descriptor 讀；讀完後重新比對路徑的 inode，並檢查**每一段路徑**都不是 symlink。**路徑檢查如果沒有綁定，它保證的只是「那個路徑曾經合格過」**；而只檢查最後一段，等於把上層目錄留給對方換。

- **路徑必須在 repository 內**，且**不接受 symlink**（只正規化目錄、留著最後一段不解析，等於留了一條 in-repo 路徑讀 repo 外檔案的門）。
- **內容**用與 diff 相同的 deny patterns 掃過。
- **路徑與 argv 本身也要掃**——它們會進 `manifest.json` 與 `REVIEW.md`，所以一個叫 `notes-<某組號碼>.md` 的檔名不必出現在任何一行內容裡，就能把那組號碼送進 packet。
- **發布的就是驗證當下讀進來的那份快照**（讀一次，之後不再回頭讀檔；trailing newline 正規化成一個）。

**對這個輸入而言，regex 就是唯一那道網**——比 packet 其他部分弱，用它之前要知道這件事。

**產完 packet 之後不要再動 `REVIEW.md`。** 要改敘述就改來源檔、重產一次 packet。

`check-review-workspace.sh` 的判定：

| 結果 | 意思 |
|---|---|
| `VOID` | 這次審查不算數：HEAD 不符、工作樹不乾淨、artifact checksum 不符、ancestry 被改寫、工作區有 secret env 檔、pack 不是 complete、**`--phase post` 的 token 對不上，或根本沒帶 token** |
| `WARN` | 可以審，但要把警告帶進 findings：`base_ref` 移動過、artifact 沒有 checksum（舊 pack）、pack 用了 `--allow-pattern-file-change`（部分掃描被放行）、**或無從得知有沒有用**（舊 pack 沒有記 invocation——這時報 `UNKNOWN`，不會報 PASS） |
| `OK` | 沒有明顯問題——不等於沒有問題，見第 2 節 |

## 5. base 一律從 manifest 讀

`base_ref`、`base_sha`、`merge_base_sha` 全部以 `.review/manifest.json` 為準，**不得假設 base 是 main**。這個 repo 的刀常常疊在尚未合併的上一刀上（stacked branch），把 main 當基準會讀出根本不存在的 finding。

`base_ref != main` 時，findings 必須標示 `Stacked review` 與 base SHA。這樣換下一支 stacked 分支時不需要改任何 prompt。

## 6. 預設不重跑 `npm run verify`

packet 的驗證是在 `git archive HEAD` 的乾淨匯出裡跑的（無 app env、`npm ci` 到 `npm run verify`，exit code 與 raw log 都在 `.review/logs/`）。那比 reviewer 在自己的髒工作樹重跑更有證據力。

只有在以下情況重跑，並在 findings 說明原因：log 不完整、SHA 對不上、懷疑測試沒有覆蓋到某個 finding、或需要針對性驗證。

## 7. Delta review（第二輪以後）

```text
reviewer 提 findings  → .review-notes/FINDINGS-<old12>.md
implementer 修 + 回覆  → .review-notes/RESPONSES-<old12>-to-<new12>.md
重產 packet           → make-review-pack.sh --base <base_ref>
新的 reviewer session → 讀上一輪 FINDINGS + 本輪 RESPONSES + 新 packet
```

- 檔名一律 **12 碼 SHA**，7 碼在這個 repo 的壽命裡不夠。
- 每一輪都開**全新 session**。
- reviewer 要逐項確認「真的修好了」，以實際 source 為準，不是讀 RESPONSES 的說法。
- finding ID（`F-001`…）跨輪穩定，RESPONSES 靠它對應。
- implementer 自己發現、reviewer 沒提的問題，寫成 `S-001…` 一起列出。藏起來會讓審查變成儀式。

## 8. `.review-notes/` 的生命週期

gitignored，**不會被 commit**——它是關於某個 commit 的對話，不是那個 commit 的一部分。刪掉 review worktree 之前要先把整個目錄帶走，否則下一輪的基準就沒了。

**不要放進 `.review/`**：發布 packet 會整個換掉那個目錄（見 `make-review-pack.sh` 的 publish 段），放進去的 findings 會在下次重產時消失。

## 9. 已知限制

- **`--allow-pattern-file-change` 會放行部分秘密掃描。** manifest 的 `invocation` 有記，`check-review-workspace.sh` 會給 WARN，`REVIEW.md` 表格也會顯示。用了就要在 findings 講明白。
- **`npm run verify` 不涵蓋 `scripts/review/` 的 shell 測試與 ShellCheck。** 那兩項只在 `app-ci.yml` 的 `review-pack` job 跑，而該 job 在 GitHub 帳號恢復前一次都沒執行過。packet 不含它們的結果，要另外本機跑並寫進 findings。
- **checksum 防的是誤改，不是偽造。** 能改 artifact 的人也能改 manifest。要防後者需要簽章（signing），那是另一個威脅模型，目前刻意不做。
- **`--expect` 證明的是「pre 與 post 兩端相同」，不是「中間沒有移動過」。** 它比的是兩個端點：packet 在 pre 之後被換掉、在 post 之前被換回來，讀起來和從未動過完全一樣（審查用 `probe-phase-endpoints.sh` 在 synthetic repo 實證過：改成同 HEAD 的另一份 packet ⇒ `VOID`，還原回原本那份 ⇒ `OK`）。這不是 provenance 或簽章問題，是端點比較本身的邏輯邊界，和敘述路徑檢查同一句話：**偵測到變化不等於防止變化**。
- **`--expect` 相符還有一個前提：那次 post 真的跑過。** 它綁的是兩次執行之間的值，不是「這段輸出來自一次執行」。貼上來的區塊如果其實是 pre 的複製，token 當然相符，而**產出物本身分辨不出來**。phase 標籤會露餡，但那擋的是筆誤，不是有意的改寫。**這道線本來就假設 reviewer 誠實而獨立，不假設它是對手**——真要防偽造得走簽章，和上一條同一個威脅模型。implementer 這一側能做、也應該做的是：自己去看 review worktree 的 HEAD 與 manifest 雜湊，不要只讀那段貼上來的文字。
  **不要拿 timestamp 當證據**：header 只有秒級解析度，而整支 checker 跑一次約 0.15 秒（審查實測連續六次全落在同一秒，我自己複測也是）。**兩段輸出 timestamp 相同，既可能是複製，也可能是兩次真正的執行——分不出來。** 這條限制不需要那個推論就成立，而我曾經用它去斷定某一輪「比較可能是複製」，那個斷定沒有根據。
- **checksum 只存在於 `status: complete` 的 pack。** 失敗的 pack 不寫——對半寫完的 artifact 算雜湊，會把截斷的內容包裝成「已驗證」。所以欄位缺少不代表解析出錯。失敗的 pack 本來也不是證據（checker 一律 VOID）。
- **`schema_version: 1` 的舊 pack 同時缺兩樣東西**：artifact checksum，以及 `--allow-pattern-file-change` 有沒有被用過的紀錄。checker 對後者報 `UNKNOWN` 而不是 PASS——對無從得知的事情給肯定答案，正是這套流程要抓的錯誤型態。要完整證據就重產一次 pack。
- **`check-review-workspace.sh` 需要 `node`**（只用來讀 manifest，不需要 `node_modules`）。這是 **reviewer 端的前置需求**，不是「反正產 pack 的機器有」——protocol 本來就要求審查在另一個工作區、可能是另一台機器上進行，那台機器上有什麼不能靠推論。找不到 `node` 就 VOID：不退回文字解析，也不加 `jq`／`python` 的備援路徑，因為多條路徑就要有多份同樣嚴格的 schema 驗證，而那必然會分岔。
- **checker 驗的是 manifest 的形狀，不是它的真偽。** 拒絕（VOID）的條件：非 JSON；`schema_version` 不是 `1` 或 `2`（**缺值也拒絕**——沒有任何一版 generator 寫過沒有版號的 manifest，所以「缺值」不等於「舊」）；`artifacts` 不是非空字串陣列、或有重複；任一雜湊不是 64 位 hex；`allow_pattern_file_change` 存在但不是 boolean；**checker 會讀進來的那些值**（`status`、四個 `repo.*`、artifact 名稱、checksum key）含控制字元。
- **版號必須約束形狀，不能只是個落在範圍內的數字。** `schema 1` 不得帶 `artifact_sha256` 或 `invocation`（帶了就 VOID）——否則把一份 schema 2 改標成 1、其餘照舊，反而比真正的舊 pack 更不會被警告，因為舊 pack 該缺的證據它都有。`schema 2` 且 `complete` 時，`artifact_sha256` 的 key 集合必須**恰等於** `artifacts`（多一個或少一個都 VOID）。
- **checker 不驗它不讀的欄位**：`created_at`、`invocation.argv`、`tree`、`toolchain`、`verify` 的內容不做型別或字元檢查。這些是給人讀的證據，不參與判定。上一條的控制字元規則只涵蓋會進入 checker 內部傳遞的值，不是整份 manifest。
- **generator 的 schema 升到 3 時，checker 也要一起改。** 版號白名單是刻意的耦合：checker 不知道新版承諾了什麼，就不該給它通過。
- **秘密掃描認得的是已知形狀，不是 PII。** 沒有任何 regex 認得出一個真實會友的名字。真正的控制是建構式的：packet 只包含腳本自己產生的內容——**敘述是唯一的例外**，見第 4.5 節。
- **敘述的標題閘門擋「忘記」不擋「規避」**，天花板是結構性的（無法判斷一節有沒有被回答）。完整說明與審查標準見第 4.5 節。
- **敘述的路徑檢查已綁定到實際讀到的 bytes。** 檔案只開一次，之後全部從那個 file descriptor 讀；讀完後重新比對路徑的 inode，並檢查**路徑的每一段**都不是 symlink（只檢查最後一段時，上層目錄可以在邊界檢查通過之後被換掉，於是前後兩次識別會彼此一致地都指向 repo 外的檔案——審查的 parent-swap fixture 證明過）。**偵測到就拒絕產出，但這是偵測不是防止**：在該窗口內「換掉再換回來」仍不會被發現，那一點寫在原始碼註解裡，不要在別處把它講成絕對。**這條之所以列在這裡，是因為它一度被寫成「已知限制」而不是缺陷**——審查用一個確定性的 fixture 證明：在檢查與讀取之間把檔案換成 symlink，repo 外的內容會進到完成的 packet 裡。邊界存在的理由正是 deny scan 認不出任意真實姓名，所以那不是可以被記載了事的限制。
