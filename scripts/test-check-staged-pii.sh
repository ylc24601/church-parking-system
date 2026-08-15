#!/usr/bin/env bash
#
# Behaviour tests for scripts/check-staged-pii.py, run against throwaway git repos.
#
# Why these exist: the first version of that checker passed every manual smoke test its author
# ran, and an independent review still found three real false negatives in it (F-002). A leak
# detector is worse than useless when it is quietly wrong — it issues confidence. So every
# format it claims to catch gets a case here, and so does every way it could fail open.
#
# Same arrangement as scripts/review/test-review-pack.sh: no network, no fixtures inside the
# repo, each case in its own temp repo that is deleted afterwards.
#
# THE AWKWARD BIT, EXPLAINED. A test suite for a PII detector has to contain the shapes the
# detector looks for — and this repo has two scanners that reject exactly those shapes: the
# repo gate (scripts/check-staged-pii.py) and, harder, the review pack's deny-patterns scan,
# which refuses to build a pack at all when an added line looks like a phone number. Round 2
# of this branch hit that wall: the tests were written, and the evidence bundle for reviewing
# them could not be produced.
#
# The way out is NOT a path allowlist in either scanner. An exempt file is a place to hide a
# real number, permanently, in a public repo. Instead the ASCII mobile fixtures are assembled
# at runtime by fake_mobile() below, so this file contains no phone-shaped literal — the
# scanners' promise stays literally true, and a real number pasted in here later would still
# be caught, because it would be a literal. The strings the detector actually sees are built
# and written into throwaway repos at run time, so the tests are no weaker for it.
#
# Full-width fixtures stay literal: they are not ASCII digits, no scanner matches them, and
# spelling them out is the only way a reader can see what is being tested.
#
#   bash scripts/test-check-staged-pii.sh

set -uo pipefail

CHECKER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-staged-pii.py"
PASS=0
FAIL=0

if [ -t 1 ]; then C_OK=$'\033[32m'; C_NG=$'\033[31m'; C_0=$'\033[0m'
else C_OK=''; C_NG=''; C_0=''; fi

# new_repo — a repo with one commit, so `git diff HEAD` is always meaningful.
new_repo() {
  local d
  d=$(mktemp -d)
  git -C "$d" init -q
  git -C "$d" config user.email t@t
  git -C "$d" config user.name t
  git -C "$d" commit -q --allow-empty -m base
  printf '%s' "$d"
}

# check <描述> <期望 exit code> <repo>
check() {
  local desc=$1 want=$2 repo=$3 got out
  out=$(cd "$repo" && python3 "$CHECKER" 2>&1)
  got=$?
  if [ "$got" -eq "$want" ]; then
    printf '  %s✓%s %s\n' "$C_OK" "$C_0" "$desc"
    PASS=$((PASS + 1))
  else
    printf '  %s✗%s %s — 期望 exit %s，實際 %s\n' "$C_NG" "$C_0" "$desc" "$want" "$got"
    printf '%s\n' "$out" | sed 's/^/      /'
    FAIL=$((FAIL + 1))
  fi
  rm -rf "$repo"
}

# fake_mobile [分隔符] — 組出假手機號碼，分隔符預設為空（09xx 開頭）。
# fake_intl  [分隔符] — 同上但用國碼 886 開頭（`+` 由呼叫端自己加）。
# 理由見檔頭，不要改回字面值（改回去 review pack 就產不出來了）。
fake_mobile() { local s=${1-}; printf '09%s%s%s%s%s' 12 "$s" 345 "$s" 678; }
fake_intl()   { local s=${1-}; printf '886%s%s%s%s%s' 912 "$s" 345 "$s" 678; }
newline_file() { printf '%s\n' "$1" > "$2"; }

# staged_line <內容> — 一個 repo，內容 staged，回傳 repo 路徑
staged_line() {
  local repo; repo=$(new_repo)
  printf '%s\n' "$1" > "$repo/note.md"
  git -C "$repo" add note.md
  printf '%s' "$repo"
}

echo "偵測得到的格式（期望 exit 1）"
check "無分隔手機"                       1 "$(staged_line "contact $(fake_mobile)")"
check "破折號分隔"                       1 "$(staged_line "contact $(fake_mobile -)")"
check "空白分隔"                         1 "$(staged_line "contact $(fake_mobile ' ')")"
check "點分隔"                           1 "$(staged_line "contact $(fake_mobile .)")"
check "國碼 +886 加空白"                 1 "$(staged_line "contact +$(fake_intl ' ')")"
check "國碼無 + 無分隔"                  1 "$(staged_line "contact $(fake_intl)")"
check "全形 ＋８８６　９１２３４５６７８" 1 "$(staged_line 'contact ＋８８６　９１２３４５６７８')"
check "全形數字 ０９１２３４５６７８"      1 "$(staged_line 'contact ０９１２３４５６７８')"
check "身分證 A123456789"                1 "$(staged_line 'id A123456789')"
check "個人 email"                       1 "$(staged_line 'mail someone@gmail.com')"

echo
echo "資料檔（期望 exit 1）"
csv_repo=$(new_repo);  : > "$csv_repo/members.csv";  git -C "$csv_repo" add members.csv
check "ASCII 檔名 members.csv"           1 "$csv_repo"
zh_repo=$(new_repo);   : > "$zh_repo/會友名冊.csv";  git -C "$zh_repo" add '會友名冊.csv'
check "中文檔名 會友名冊.csv"            1 "$zh_repo"
sp_repo=$(new_repo);   : > "$sp_repo/member list.xlsx"; git -C "$sp_repo" add 'member list.xlsx'
check "含空白檔名 member list.xlsx"      1 "$sp_repo"

echo
echo "不該誤報（期望 exit 0）"
check "沒有任何變更"                     0 "$(new_repo)"
check "一般散文"                         0 "$(staged_line '這一刀改了 3 個檔案，共 286 個連結')"
check "長數字串不從中間切"               0 "$(staged_line "nonce 12$(fake_mobile)901234")"
check "公司 email 不報"                  0 "$(staged_line 'mail ops@example.com')"
untracked=$(new_repo); newline_file "$(fake_mobile)" "$untracked/leak.md"
check "未追蹤檔不掃"                     0 "$untracked"

echo
echo "範圍與失敗模式"
mixed=$(new_repo)
printf 'clean\n' > "$mixed/a.md"; git -C "$mixed" add a.md
newline_file "$(fake_mobile)" "$mixed/b.md"   # 未 staged 且未追蹤 ⇒ 有 staged 時不看它
check "有 staged 時只看 staged"          0 "$mixed"

unstaged=$(new_repo)
printf 'seed\n' > "$unstaged/c.md"; git -C "$unstaged" add c.md
git -C "$unstaged" commit -q -m seed
printf '%s\n' "$(fake_mobile)" >> "$unstaged/c.md"  # 已追蹤、未 staged ⇒ 退回 working tree
check "無 staged 時看 working tree"      1 "$unstaged"

notrepo=$(mktemp -d)
check "不是 git repo ⇒ fail closed(2)"   2 "$notrepo"

echo
if [ "$FAIL" -eq 0 ]; then
  printf '%s%s 個案例全數通過。%s\n' "$C_OK" "$PASS" "$C_0"
  exit 0
fi
printf '%s%s 個案例失敗%s（%s 通過）。\n' "$C_NG" "$FAIL" "$C_0" "$PASS"
exit 1
