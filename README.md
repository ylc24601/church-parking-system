# 教會停車管理系統 Church Parking Management System

A weekly parking allocation system for a church with more demand than spaces. Members apply
for a slot, a scheduled job allocates the limited bays by priority tier, and staff check cars
in on-site from a phone. Notifications go out over the LINE Messaging API; members
authenticate through LIFF.

Built with Next.js (App Router) and Supabase (Postgres + RLS).

## 版圖 Layout

| 路徑 | 是什麼 |
|---|---|
| `parking-system/` | Next.js 應用程式。Vercel 的 Root Directory 就是這裡。 |
| `scripts/` | 維運腳本：`review/`（審查用具）、`backup/`（DB 備份／還原）。 |
| `docs/` | 產品規格（PRD）、停車政策、開發約定與審查協定。 |

## 開始 Getting started

```bash
cd parking-system
cp .env.example .env.local     # 填入本機 Supabase 連線資訊
npm install
npm run db:start               # 本機 Supabase
npm run dev
```

驗證（tsc / lint / test / build）只有一個正規入口：

```bash
cd parking-system && npm run verify
```

## 這個 repo 沒有什麼 What's not here

這是一套服務真實教會會友的線上系統，因此以下內容**刻意不放在公開 repo**：

- **營運 runbook**——正式環境部署、備份與還原、管理者帳號操作、go-live 檢查表、
  通知派送與綁定營運程序。這些描述的是一套正在運行的系統，屬於攻擊面資訊。
- **內部進度文件**——handoff、backlog、feature triage 等專案內部紀錄。
- **任何真實個資**——名冊、電話、匯出的 CSV、資料庫 dump 一律不進版控。
  repo 內所有 CSV 與測試資料皆為合成資料（`王小明`／`測試甲`／`0912345678` 之類的假值）。

因此部分文件會提到上述 runbook 的名字但沒有連結——它們維護在私有 repo。

## 授權 License

[MIT](LICENSE)
