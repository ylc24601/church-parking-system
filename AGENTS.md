# Repository guide

短索引，不是規則書。每一條都指向唯一的權威檔案——這裡寫細節就會和那些檔案漂移。

## 版圖

| 路徑 | 是什麼 |
|---|---|
| `parking-system/` | Next.js 應用程式（Vercel 的 Root Directory 就是這裡）。另有 `parking-system/AGENTS.md`。 |
| `scripts/` | 維運腳本：`review/`（審查用具）、`backup/`（DB 備份／還原）。 |
| `docs/` | 產品規格（PRD）、停車政策、開發約定與審查協定。**營運 runbook 與內部進度文件不在這個 public repo，另於私有 repo 維護。** |
| 根目錄 `package.json` | Notion 同步工具，加上 repo 層的 `check:*`（見〈指令〉）。**應用程式的指令不在這裡跑。** |

## 指令

```bash
cd parking-system && npm run verify    # 唯一正規的驗證入口（tsc / lint / test / build）
```

CI 呼叫的是同一個 script，review pack 也是。不要另外複製一份命令清單。

根目錄另有兩道 repo 層閘門，它們檢查的是 `docs/` 與 staging 內容，不是應用程式：

```bash
npm run check:repo     # 下面兩者 + 委派給上面那支（不重新定義四道閘門）
npm run check:docs     # docs/ 指向程式碼的連結是否還指得到、行號是否超出檔案
npm run check:pii      # 即將進 commit 的**新增行**有無個資樣式
```

## 工作約定

語言、git staging、commit 與分支慣例、文件誠實、plan mode 自檢
——見 [`docs/working-agreements.md`](docs/working-agreements.md)。

## Code review

要對一支完成的分支做獨立審查：

1. 讀 [`docs/review-protocol.md`](docs/review-protocol.md)——完整規則在那裡。
2. 在**專用的 review worktree** 跑 `scripts/review/check-review-workspace.sh --phase pre`，**整段輸出留著，包含 `SNAPSHOT token` 那一行**。
3. 讀 `.review/` 的證據，再交叉檢查 repository 的實際原始碼。
4. 不要修改任何 tracked 檔案；唯一可以寫的是 `.review-notes/`。
5. blocker 優先，附檔案與行號。
6. 收尾跑 `scripts/review/check-review-workspace.sh --phase post --expect '<第 2 步的 token>'`，貼進 findings。**沒帶 token 就是 `VOID`**，而 token 事後補不回來。

base **不一定是 main**——一律從 `.review/manifest.json` 讀。

## 資料邊界

這是公開 repo，處理的是真實教會會友資料。任何名冊、電話、匯出的 CSV、`.env*`、DB dump 都不進版控；`.gitignore` 與 `scripts/review/deny-patterns.txt` 是最後一道防線，不是第一道。
