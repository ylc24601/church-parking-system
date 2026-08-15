#!/usr/bin/env bash
#
# Repo 層的交付前檢查。
#
#   bash scripts/check-repo.sh              # repo 檢查 + 應用四道閘門
#   bash scripts/check-repo.sh --skip-app   # 只跑 repo 層（秒級，開發中用）
#   bash scripts/check-repo.sh --db         # 額外跑 DB 測試與 schema 斷言
#
# 應用程式的 tsc / lint / test / build **不在這裡定義**。`cd parking-system && npm run verify`
# 是唯一正規入口（根目錄 AGENTS.md〈指令〉），CI 與 review pack 呼叫的都是它；這支只是在
# 它之前加兩道 repo 層的閘門，然後委派過去。不要在這裡複製一份命令清單。
#
# 所有階段都跑完再一次回報，不會第一個失敗就中斷。任一階段失敗則 exit 1。

set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 2
ROOT=$(pwd)
APP="$ROOT/parking-system"
LOGDIR=$(mktemp -d)
trap 'rm -rf "$LOGDIR"' EXIT

RUN_APP=1
RUN_DB=0
for a in "$@"; do
  case "$a" in
    --skip-app) RUN_APP=0 ;;
    --db)       RUN_DB=1 ;;
    -h|--help)  sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知參數：$a（用 --help 看用法）" >&2; exit 2 ;;
  esac
done

if [ -t 1 ]; then C_OK=$'\033[32m'; C_NG=$'\033[31m'; C_DIM=$'\033[2m'; C_0=$'\033[0m'
else C_OK=''; C_NG=''; C_DIM=''; C_0=''; fi

NAMES=(); STATUS=(); NOTES=()
record() { NAMES+=("$1"); STATUS+=("$2"); NOTES+=("$3"); }

stage() { # stage <名稱> <log 檔名> <工作目錄> <指令...>
  local name=$1 log=$2 dir=$3; shift 3
  printf '%s▶ %s%s\n' "$C_DIM" "$name" "$C_0"
  if (cd "$dir" && "$@") > "$LOGDIR/$log" 2>&1; then
    record "$name" ok ""
  else
    record "$name" ng "$LOGDIR/$log"
  fi
}

# ── repo 層 ────────────────────────────────────────────────────────────────
# docs/ 裡指向程式碼的相對連結：目標存在、#L 行號沒超出檔案。
# 「不要宣稱某功能存在，除非能指出檔案:行號」的機器化版本。
stage "docs 引用" docrefs.log "$ROOT" python3 scripts/check-doc-refs.py

# 只看 diff 的新增行。這是公開 repo，處理的是真實會友資料。
stage "個資掃描" pii.log "$ROOT" python3 scripts/check-staged-pii.py

# ── 應用程式（委派） ───────────────────────────────────────────────────────
[ "$RUN_APP" -eq 1 ] && stage "app（parking-system 的 npm run verify）" app.log "$APP" npm run verify

if [ "$RUN_DB" -eq 1 ]; then
  stage "db 測試"   dbtest.log   "$APP" env RUN_DB_TESTS=1 npm test
  stage "db schema" dbverify.log "$APP" npm run db:verify
fi

# ── 總結 ───────────────────────────────────────────────────────────────────
echo
echo "──────────────────────────────────────────"
fail=0
for i in "${!NAMES[@]}"; do
  if [ "${STATUS[$i]}" = ok ]; then
    printf '  %s✓%s  %s\n' "$C_OK" "$C_0" "${NAMES[$i]}"
  else
    fail=1
    printf '  %s✗%s  %s\n' "$C_NG" "$C_0" "${NAMES[$i]}"
  fi
done
echo "──────────────────────────────────────────"

if [ "$fail" -eq 1 ]; then
  for i in "${!NAMES[@]}"; do
    [ "${STATUS[$i]}" = ok ] && continue
    echo
    echo "═══ ${NAMES[$i]} 失敗 ═══"
    tail -30 "${NOTES[$i]}"
  done
  echo
  echo "${C_NG}檢查未通過。${C_0}"
  exit 1
fi

[ "$RUN_APP" -eq 0 ] && echo "${C_DIM}（--skip-app：未跑應用程式閘門）${C_0}"
[ "$RUN_DB" -eq 0 ]  && echo "${C_DIM}（未跑 DB 測試，需要時加 --db）${C_0}"
echo "${C_OK}全部通過。${C_0}"
