#!/usr/bin/env python3
"""掃描「即將進 commit 的新增內容」有沒有個資或機密樣式。

只看 diff 的**新增行**，不看整個檔案 —— 否則每次碰到一個歷史上含測試門號的
檔案都會重新告警一次，噪音會把訊號淹掉。

範圍：優先 staged（`git diff --cached`）；沒有 staged 就看 working tree vs HEAD。
未追蹤檔不掃，它們還沒要進版控。

**這支的失敗模式是致命的**：一個漏掉真實個資的偵測器比沒有偵測器更糟，因為它會
發放信心。所以兩條規則寫死在這裡：

  1. **fail closed** —— 任何 git 指令非零退出就 exit 2，絕不把「讀不到」當成「乾淨」。
  2. **比對前先 NFKC 正規化** —— 全形數字、全形 `＋`、ideographic space 在螢幕上跟
     半形長得幾乎一樣，正規化之後才用同一組 pattern 比對。

exit 0 = 乾淨；exit 1 = 有疑慮，需要人看過；exit 2 = 檢查本身失敗（不是通過）。
"""

import re
import subprocess
import sys
import unicodedata

# 電話：涵蓋 09xx / +886 9xx / 886 9xx，分隔符允許 `-`、`.`、空白，或完全沒有。
# 前後的 (?<!\d)/(?!\d) 是為了不讓一長串數字（timestamp、hash）從中間被切出一個假陽性。
PHONE = r"(?<!\d)(?:\+?886[-. ]?|0)9\d{2}[-. ]?\d{3}[-. ]?\d{3}(?!\d)"

PATTERNS = [
    ("疑似手機號碼", re.compile(PHONE)),
    ("疑似身分證字號", re.compile(r"(?<![A-Za-z0-9])[A-Z][12]\d{8}(?![A-Za-z0-9])")),
    ("疑似個人 Email", re.compile(r"[\w.%+-]+@(?:gmail|yahoo|hotmail|outlook|icloud)\.[a-z.]{2,}", re.I)),
]

# 「這個副檔名的檔案本質上是一份名冊」。不求窮盡，求的是常見匯出格式都在裡面。
DATA_SUFFIXES = (".csv", ".tsv", ".xls", ".xlsx", ".ods", ".numbers", ".vcf")


class GitError(RuntimeError):
    pass


def git(*args: str) -> str:
    """跑 git 並回傳 stdout；非零退出一律拋例外。

    舊版把 non-zero 直接吞掉、回傳空字串——那會讓「git 壞了」和「沒有任何變更」
    產生一模一樣的結果，於是一個壞掉的檢查器會安靜地 exit 0。

    `core.quotePath=false` 讓含中文的路徑原樣輸出。預設的 quote 會把
    `docs/名冊.csv` 印成 `"docs/\\345\\220\\215..."`，尾端多一個引號 ⇒ 副檔名比對失效。
    """
    proc = subprocess.run(
        ["git", "-c", "core.quotePath=false", *args],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        detail = proc.stderr.strip().splitlines()
        raise GitError(f"git {' '.join(args)} 退出碼 {proc.returncode}" + (f"：{detail[0]}" if detail else ""))
    return proc.stdout


def changed_names(base: list[str]) -> list[str]:
    """`-z` 拿 NUL 分隔的路徑——不靠 git 的 quoting 規則去反解檔名。"""
    out = git(*base, "--name-only", "-z", "--diff-filter=ACM")
    return [n for n in out.split("\0") if n]


def normalize(s: str) -> str:
    return unicodedata.normalize("NFKC", s)


def main() -> int:
    scope = "staged"
    base = ["diff", "--cached"]
    names = changed_names(base)
    if not names:
        scope = "working tree vs HEAD"
        base = ["diff", "HEAD"]
        names = changed_names(base)
    print(f"掃描範圍：{scope}（{len(names)} 個檔案的新增行）")
    if not names:
        print("沒有變更，略過。")
        return 0

    findings = []

    for n in names:
        if n.lower().endswith(DATA_SUFFIXES):
            findings.append((n, "資料檔", "確認已去識別化，或它本來就該入版控"))

    current = None
    for line in git(*base, "-U0", "--diff-filter=ACM").splitlines():
        if line.startswith("+++ b/"):
            current = line[6:]
            continue
        if not line.startswith("+") or line.startswith("+++"):
            continue
        added = normalize(line[1:])
        for label, pat in PATTERNS:
            m = pat.search(added)
            if m:
                snippet = added.strip()
                if len(snippet) > 90:
                    snippet = snippet[:90] + "…"
                findings.append((current or "?", label, f"{m.group(0)}  ←  {snippet}"))

    if not findings:
        print("新增行中未發現個資樣式。")
        return 0

    print(f"\n{len(findings)} 項需要人看過：")
    for path, label, detail in findings:
        print(f"  [{label}] {path}")
        print(f"      {detail}")
    print("\n若確認是測試用假資料，這次可以放行；若是真實個資，這個 repo 是公開的。")
    return 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except GitError as e:
        print(f"檢查失敗（不是通過）：{e}", file=sys.stderr)
        sys.exit(2)
