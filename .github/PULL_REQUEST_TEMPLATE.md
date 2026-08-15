## 這一刀做了什麼

<!-- 一段話：範圍、triage 編號、為什麼是這個切法 -->

## 驗證

<!-- tsc / eslint / npm test / RUN_DB_TESTS=1 / db:reset + db:verify / 走查 -->

## Database compatibility

> 出處：`prod-deploy-runbook.md` §1.5。
> **這一段決定部署順序，不是形式**——A/B 沒有先答，順序就只能靠記性，而記性已經失手過
> （`current_handoff.md` §6.48）。

- [ ] **這一刀沒有 migration**（勾了就跳過以下）

否則逐項填寫：

- **A — old app + new DB 安全嗎？** SAFE / UNSAFE
  - 理由：
- **B — new app + old DB 安全嗎？** SAFE / UNSAFE
  - 理由：
- **部署順序**：DB-first / app-first / 任一皆可 / **expand-contract（A❌B❌ ⇒ 不可單次 release）**
- **R — 上一個 production deployment + 新 DB 安全嗎？** SAFE / PARTIAL / UNSAFE
  - 理由（PARTIAL 要寫明哪個功能會壞）：
- **Smoke 項目**（promote 後要實際點的東西，寫具體路徑與預期）：
