#!/usr/bin/env python3
"""docs/ 裡的相對連結與 file:line 引用是否還指得到真東西。

檢查兩件事：
  1. 相對連結的目標檔案存在（`[文字](../parking-system/lib/foo.ts)`）
  2. `#L12` / `#L12-L34` 的行號沒有超出該檔實際行數

「不要宣稱某個功能存在，除非能指出檔案:行號」這條規則的機器化版本。
程式碼搬家後，這類引用會安靜地失效 —— 文件看起來仍然言之鑿鑿。

exit 0 = 全數有效；exit 1 = 有失效引用。
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"

# [文字](target) —— target 不含空白與右括號
LINK = re.compile(r"\[[^\]]*\]\(([^)\s]+)\)")
LINE_ANCHOR = re.compile(r"#L(\d+)(?:-L(\d+))?$")

SKIP_PREFIXES = ("http://", "https://", "mailto:", "#", "tel:")


def line_count(path: Path) -> int:
    with path.open("rb") as fh:
        return sum(1 for _ in fh)


def main() -> int:
    problems = []
    checked = 0

    for md in sorted(DOCS.rglob("*.md")):
        if "archive" in md.relative_to(ROOT).parts:
            continue
        try:
            text = md.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue

        for lineno, line in enumerate(text.splitlines(), 1):
            for target in LINK.findall(line):
                if target.startswith(SKIP_PREFIXES):
                    continue

                anchor = LINE_ANCHOR.search(target)
                path_part = target[: anchor.start()] if anchor else target.split("#", 1)[0]
                if not path_part:
                    continue

                resolved = (md.parent / path_part).resolve()
                where = f"{md.relative_to(ROOT)}:{lineno}"
                checked += 1

                if not resolved.exists():
                    problems.append(f"{where}  目標不存在 → {target}")
                    continue

                if anchor and resolved.is_file():
                    start = int(anchor.group(1))
                    end = int(anchor.group(2) or anchor.group(1))
                    total = line_count(resolved)
                    if end > total:
                        problems.append(
                            f"{where}  行號超出檔案（{path_part} 只有 {total} 行，引用到 L{end}）"
                        )
                    elif start > end:
                        problems.append(f"{where}  行號區間顛倒 → {target}")

    print(f"檢查 {checked} 個相對連結。")
    if problems:
        print(f"\n{len(problems)} 個失效引用：")
        for p in problems:
            print(f"  {p}")
        return 1
    print("全部有效。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
