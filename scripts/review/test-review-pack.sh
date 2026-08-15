#!/usr/bin/env bash
#
# Tests for make-review-pack.sh. Every case builds a throwaway git repo under mktemp and
# uses a fake `npm` on PATH, so nothing here touches the real repo, the network, or a real
# install. Same shape as scripts/backup/test-backup-scripts.sh.
#
# What this covers: that every refusal actually refuses — and, just as important, that a
# refused run leaves NO .review/ behind. A pack that looks finished after a failed
# verification is worse than no pack, because a reviewer would read it as evidence.
#
# What this does NOT cover: whether the regex net in deny-patterns.txt catches a real
# secret in the wild, or any real PII. It proves the guard fires on known shapes. The
# actual control is constructive (the pack only ever contains generated artifacts) and no
# test can prove the absence of a member's name from a diff.
#
# Every planted "secret" below is obviously fake by construction.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/make-review-pack.sh"
WORKSPACE_CHECK="$HERE/check-review-workspace.sh"
PATTERNS="$HERE/deny-patterns.txt"
# Kept as a literal, not read out of the script: a test that derives the default from the
# thing it is testing would still pass if the default silently changed.
DEFAULT_NARRATIVE_NAME=".review-narrative.md"
PASS=0; FAIL=0

ok()  { PASS=$((PASS+1)); echo "  PASS  $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL  $1"; }

TMP="$(mktemp -d)"; FAKEBIN="$(mktemp -d)"
trap 'rm -rf "$TMP" "$FAKEBIN"' EXIT

# ── fake npm ────────────────────────────────────────────────────────────────────
cat >"$FAKEBIN/npm" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  # The suffix seam exists so the suite can feed a control character in through a real external
  # command's output — the path that made "nothing else can reach json_escape" untrue.
  --version) echo "0.0.0-fake${FAKE_NPM_VERSION_SUFFIX:-}"; exit 0 ;;
  ci)
    echo "fake npm ci"
    exit "${FAKE_NPM_CI_EXIT:-0}" ;;
  run)
    echo "fake npm run ${2:-}"
    # Simulates a concurrent session committing into the repo mid-verification.
    [[ -n "${FAKE_MOVE_HEAD:-}" ]] && git -C "$FAKE_MOVE_HEAD" commit -q --allow-empty -m "another session"
    # Simulates the narrative being edited between validation and embedding.
    [[ -n "${FAKE_REWRITE_NARRATIVE:-}" ]] && printf '## 這一刀做了什麼\n\n偷改過，相容性那節不見了。\n' > "$FAKE_REWRITE_NARRATIVE"
    exit "${FAKE_VERIFY_EXIT:-0}" ;;
  *) exit 0 ;;
esac
EOF
cat >"$FAKEBIN/stat" <<'EOF'
#!/usr/bin/env bash
# Swaps the narrative for an outside symlink BEFORE the script opens it, then behaves as stat.
if [[ -n "${FAKE_SWAP_BEFORE_OPEN:-}" ]]; then
  rm -f "$FAKE_SWAP_BEFORE_OPEN"; ln -s "$FAKE_SWAP_TARGET" "$FAKE_SWAP_BEFORE_OPEN"
  unset FAKE_SWAP_BEFORE_OPEN
fi
# Same idea one level up: replace the narrative's PARENT directory, once, and leave it.
if [[ -n "${FAKE_SWAP_PARENT:-}" && ! -L "$FAKE_SWAP_PARENT" ]]; then
  mv "$FAKE_SWAP_PARENT" "$FAKE_SWAP_PARENT.inside"
  ln -s "$FAKE_SWAP_PARENT_TARGET" "$FAKE_SWAP_PARENT"
fi
exec /usr/bin/stat "$@"
EOF
cat >"$FAKEBIN/cat" <<'EOF'
#!/usr/bin/env bash
# Swaps the narrative AFTER the descriptor is already open: the bytes must come from the
# descriptor, and the run must still notice the path changed underneath it.
if [[ -n "${FAKE_SWAP_AFTER_OPEN:-}" ]]; then
  rm -f "$FAKE_SWAP_AFTER_OPEN"; ln -s "$FAKE_SWAP_TARGET" "$FAKE_SWAP_AFTER_OPEN"
  unset FAKE_SWAP_AFTER_OPEN
fi
exec /bin/cat "$@"
EOF
chmod +x "$FAKEBIN/npm" "$FAKEBIN/stat" "$FAKEBIN/cat"
export PATH="$FAKEBIN:$PATH"

# ── fixture ─────────────────────────────────────────────────────────────────────
# A minimal repo with the three things make-review-pack.sh requires: an app package.json
# carrying a `verify` script, the PR template, and the deny-pattern file.
# NOTE: this runs in a command substitution, so it must not depend on any variable it
# assigns — a counter would be incremented in the subshell and lost, handing every case the
# same directory and letting one test's .review/ satisfy the next test's assertion.
newrepo() {
  local d
  d="$(mktemp -d "$TMP/repo.XXXXXX")"
  mkdir -p "$d/parking-system" "$d/.github" "$d/scripts/review"
  (
    cd "$d" || exit 1
    git init -q -b main .
    git config user.email "test@example.invalid"
    git config user.name "Test"
    printf '{"name":"x","scripts":{"verify":"true"}}\n' > parking-system/package.json
    cat > .github/PULL_REQUEST_TEMPLATE.md <<'TPL'
## 這一刀做了什麼

## Database compatibility

> 出處：`prod-deploy-runbook.md` §1.5。

- **A — old app + new DB 安全嗎？** SAFE / UNSAFE
- **B — new app + old DB 安全嗎？** SAFE / UNSAFE
- **R — 上一個 production deployment + 新 DB 安全嗎？** SAFE / PARTIAL / UNSAFE
TPL
    cp "$PATTERNS" scripts/review/deny-patterns.txt
    # Mirrors the real repo: review artefacts and the narrative draft are ignored, not
    # untracked. The distinction matters — check-review-workspace.sh refuses a tree with
    # untracked files, so without this a narrative draft would void the pack it feeds.
    printf '.review/\n.review.prev.*/\n.review-FAILED-*/\n.review-notes/\n%s\n' "$DEFAULT_NARRATIVE_NAME" > .gitignore
    git add -A && git commit -qm "base"
    git checkout -qb work
  ) >/dev/null 2>&1
  echo "$d"
}

# commit_file <repo> <path> <content>
commit_file() {
  local d="$1" p="$2" c="$3"
  mkdir -p "$d/$(dirname "$p")"
  printf '%s\n' "$c" > "$d/$p"
  ( cd "$d" && git add -A && git commit -qm "add $p" ) >/dev/null 2>&1
}

# run_pack <repo> [args...] -> prints combined output, returns the script's exit code
run_pack() {
  local d="$1"; shift
  ( cd "$d" && bash "$SCRIPT" --base main "$@" ) 2>&1
}

has_review()  { [[ -d "$1/.review" ]]; }
has_failed()  { compgen -G "$1/.review-FAILED-*" >/dev/null 2>&1; }

# The failed manifest is the one most likely to be malformed: it embeds a free-text reason.
valid_json() { python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$1" 2>/dev/null; }

# assert_fail <desc> <repo> <phrase> [args...]
assert_fail() {
  local desc="$1" d="$2" phrase="$3"; shift 3
  local out rc
  out="$(run_pack "$d" "$@")"; rc=$?
  if [[ $rc -eq 0 ]]; then bad "$desc (expected non-zero, got 0)"; return; fi
  if [[ -n "$phrase" ]] && ! grep -qF -- "$phrase" <<<"$out"; then
    bad "$desc (exited $rc but message lacked '$phrase': $(head -2 <<<"$out" | tr '\n' ' '))"; return
  fi
  if has_review "$d"; then bad "$desc (refused but still published .review/)"; return; fi
  ok "$desc"
}

echo "make-review-pack.sh — happy path"
R="$(newrepo)"
commit_file "$R" "parking-system/lib/thing.ts" "export const thing = 1"
OUT="$(run_pack "$R")"; RC=$?
if [[ $RC -eq 0 ]]; then ok "exits 0"; else bad "exits 0 (got $RC: $(tail -2 <<<"$OUT" | tr '\n' ' '))"; fi
if has_review "$R"; then ok "publishes .review/"; else bad "publishes .review/"; fi
if ! has_failed "$R"; then ok "leaves no .review-FAILED-*"; else bad "leaves no .review-FAILED-*"; fi
if grep -q '"status": "complete"' "$R/.review/manifest.json" 2>/dev/null; then
  ok "manifest status complete"; else bad "manifest status complete"; fi
if valid_json "$R/.review/manifest.json"; then ok "manifest is valid JSON"; else bad "manifest is valid JSON"; fi
if grep -q '"verify_exit": 0' "$R/.review/manifest.json" 2>/dev/null; then
  ok "manifest records verify_exit 0"; else bad "manifest records verify_exit 0"; fi
if [[ -s "$R/.review/DIFF.patch" && -s "$R/.review/COMMITS.txt" && -s "$R/.review/logs/verify.log" ]]; then
  ok "evidence files are non-empty"; else bad "evidence files are non-empty"; fi
# The three SHAs must agree with git, not merely be present.
if [[ "$(grep -o '"head_sha": "[0-9a-f]*"' "$R/.review/manifest.json" | cut -d'"' -f4)" \
      == "$(cd "$R" && git rev-parse HEAD)" ]]; then
  ok "manifest head_sha matches HEAD"; else bad "manifest head_sha matches HEAD"; fi
if [[ "$(grep -o '"merge_base_sha": "[0-9a-f]*"' "$R/.review/manifest.json" | cut -d'"' -f4)" \
      == "$(cd "$R" && git merge-base main HEAD)" ]]; then
  ok "manifest merge_base_sha matches git merge-base"; else bad "manifest merge_base_sha matches git merge-base"; fi
# Temp dirs must not survive a successful run.
if ! compgen -G "$R/.review.tmp.*" >/dev/null 2>&1; then ok "no leftover .review.tmp.*"; else bad "no leftover .review.tmp.*"; fi

echo "make-review-pack.sh — the manifest is checkable after the fact"
# Naming the artifacts proved only that files with those names existed. A reviewer needs to be
# able to show that the DIFF.patch in front of them is the one that was verified.
if grep -q '"schema_version": 2' "$R/.review/manifest.json" 2>/dev/null; then
  ok "manifest is schema_version 2"; else bad "manifest is schema_version 2"; fi
if command -v sha256sum >/dev/null; then D_SHA="$(sha256sum "$R/.review/DIFF.patch" | awk '{print $1}')"
else D_SHA="$(shasum -a 256 "$R/.review/DIFF.patch" | awk '{print $1}')"; fi
if grep -qF "\"DIFF.patch\": \"$D_SHA\"" "$R/.review/manifest.json" 2>/dev/null; then
  ok "artifact_sha256 matches the file on disk"; else bad "artifact_sha256 matches the file on disk"; fi
if [[ "$(grep -c '": "[0-9a-f]\{64\}"' "$R/.review/manifest.json")" -eq 7 ]]; then
  ok "every artifact is checksummed"; else bad "every artifact is checksummed"; fi
# --allow-pattern-file-change waives part of the secret scan. A reviewer who cannot see that in
# the evidence is reading a pack whose guarantees are weaker than the header claims.
if grep -q '"allow_pattern_file_change": false' "$R/.review/manifest.json" 2>/dev/null; then
  ok "manifest records that the scan was not waived"; else bad "manifest records that the scan was not waived"; fi
if grep -qF '"argv": ["--base", "main"]' "$R/.review/manifest.json" 2>/dev/null; then
  ok "manifest records how the pack was asked for"; else bad "manifest records how the pack was asked for"; fi

echo "make-review-pack.sh — REVIEW.md comes from the one canonical template"
if grep -q 'A — old app + new DB' "$R/.review/REVIEW.md" 2>/dev/null; then
  ok "carries the A/B/R section verbatim"; else bad "carries the A/B/R section verbatim"; fi
if grep -q 'R — 上一個 production deployment' "$R/.review/REVIEW.md" 2>/dev/null; then
  ok "carries the R row"; else bad "carries the R row"; fi
if ! grep -q '](\.\./' "$R/.review/REVIEW.md" 2>/dev/null; then
  ok "rewrites ../ links so none dangle"; else bad "rewrites ../ links so none dangle"; fi
if grep -q 'head_sha' "$R/.review/REVIEW.md" 2>/dev/null; then
  ok "prefixes an evidence header"; else bad "prefixes an evidence header"; fi

echo "make-review-pack.sh — STATUS.txt carries no untracked filename"
# A filename is user content. With the tracked tree forced equal to HEAD, a `git status`
# listing here would be nothing BUT untracked names, and the deny-pattern scan does not reach
# STATUS.txt — so a stray working file named after a member would have ridden into the pack.
R="$(newrepo)"
commit_file "$R" "parking-system/lib/m.ts" "export const m = 1"
printf 'x\n' > "$R/should-not-appear-in-status.csv"
run_pack "$R" >/dev/null 2>&1
if ! grep -q 'should-not-appear-in-status' "$R/.review/STATUS.txt" 2>/dev/null; then
  ok "an untracked filename does not reach STATUS.txt"; else bad "an untracked filename does not reach STATUS.txt"; fi
if grep -q 'untracked files: 1' "$R/.review/STATUS.txt" 2>/dev/null; then
  ok "STATUS.txt reports the untracked count instead"; else bad "STATUS.txt reports the untracked count instead"; fi

echo "make-review-pack.sh — the tree that is verified must be the tree that is packed"
R="$(newrepo)"
commit_file "$R" "parking-system/lib/a.ts" "export const a = 1"
printf 'dirty\n' >> "$R/parking-system/lib/a.ts"
assert_fail "dirty tracked tree is refused" "$R" "tracked working tree differs from HEAD"

R="$(newrepo)"
commit_file "$R" "parking-system/lib/b.ts" "export const b = 1"
printf 'untracked\n' > "$R/scratch-note.txt"
OUT="$(run_pack "$R")"; RC=$?
if [[ $RC -eq 0 ]]; then ok "an untracked file alone does not refuse"; else bad "an untracked file alone does not refuse (got $RC)"; fi

R="$(newrepo)"
commit_file "$R" "parking-system/lib/c.ts" "export const c = 1"
OUT="$(cd "$R" && FAKE_MOVE_HEAD="$R" bash "$SCRIPT" --base main 2>&1)"; RC=$?
if [[ $RC -ne 0 ]] && grep -qF -- "HEAD moved during the run" <<<"$OUT" && ! has_review "$R"; then
  ok "HEAD moving mid-run is caught, nothing published"
else
  bad "HEAD moving mid-run is caught (rc=$RC)"
fi

echo "make-review-pack.sh — verification failure never yields a finished-looking pack"
R="$(newrepo)"
commit_file "$R" "parking-system/lib/d.ts" "export const d = 1"
OUT="$(cd "$R" && FAKE_VERIFY_EXIT=3 bash "$SCRIPT" --base main 2>&1)"; RC=$?
if [[ $RC -ne 0 ]]; then ok "verify exit 3 fails the run"; else bad "verify exit 3 fails the run"; fi
if ! has_review "$R"; then ok "verify failure publishes no .review/"; else bad "verify failure publishes no .review/"; fi
if has_failed "$R"; then ok "verify failure keeps .review-FAILED-* evidence"; else bad "verify failure keeps .review-FAILED-* evidence"; fi
FDIR="$(compgen -G "$R/.review-FAILED-*" | head -1)"
if grep -q '"verify_exit": 3' "$FDIR/manifest.json" 2>/dev/null; then
  ok "FAILED manifest records the real exit code"; else bad "FAILED manifest records the real exit code"; fi
if grep -q '"status": "failed"' "$FDIR/manifest.json" 2>/dev/null \
   && ! grep -q '"status": "complete"' "$FDIR/manifest.json" 2>/dev/null; then
  ok "FAILED manifest never claims complete"; else bad "FAILED manifest never claims complete"; fi
if valid_json "$FDIR/manifest.json"; then
  ok "FAILED manifest is valid JSON (it embeds a free-text reason)"; else bad "FAILED manifest is valid JSON"; fi
if grep -q '"failed_stage": "verify"' "$FDIR/manifest.json" 2>/dev/null; then
  ok "FAILED manifest names the stage"; else bad "FAILED manifest names the stage"; fi
if [[ -s "$FDIR/logs/verify.log" ]]; then ok "FAILED pack still carries the verify log"; else bad "FAILED pack still carries the verify log"; fi
# A checksum over a half-written artifact would look like verification and certify the truncation.
if ! grep -q 'artifact_sha256' "$FDIR/manifest.json" 2>/dev/null; then
  ok "FAILED manifest carries no artifact checksums"; else bad "FAILED manifest carries no artifact checksums"; fi

R="$(newrepo)"
commit_file "$R" "parking-system/lib/e.ts" "export const e = 1"
OUT="$(cd "$R" && FAKE_NPM_CI_EXIT=7 bash "$SCRIPT" --base main 2>&1)"; RC=$?
if [[ $RC -ne 0 ]] && grep -qF -- "npm ci failed" <<<"$OUT" && ! has_review "$R"; then
  ok "npm ci failure fails the run before verify"
else
  bad "npm ci failure fails the run (rc=$RC)"
fi

echo "make-review-pack.sh — an existing good pack survives a later failed run"
R="$(newrepo)"
commit_file "$R" "parking-system/lib/f.ts" "export const f = 1"
run_pack "$R" >/dev/null 2>&1
cp "$R/.review/manifest.json" "$TMP/before.json"
commit_file "$R" "parking-system/lib/g.ts" "export const g = 1"
( cd "$R" && FAKE_VERIFY_EXIT=1 bash "$SCRIPT" --base main ) >/dev/null 2>&1
if cmp -s "$TMP/before.json" "$R/.review/manifest.json"; then
  ok ".review/ is left untouched by a failed run"; else bad ".review/ is left untouched by a failed run"; fi

echo "make-review-pack.sh — publishing never destroys the pack it is replacing"
# Publishing a directory cannot be one atomic step, so the question is what survives an
# interrupt between the steps. `rm -rf .review && mv` answers "nothing": the old evidence is
# destroyed to make room for evidence that never arrives. The seam below is the only way to
# exercise the rollback without a misbehaving filesystem.
R="$(newrepo)"
commit_file "$R" "parking-system/lib/n.ts" "export const n = 1"
run_pack "$R" >/dev/null 2>&1
cp "$R/.review/manifest.json" "$TMP/keep.json"
commit_file "$R" "parking-system/lib/o.ts" "export const o = 1"
OUT="$(cd "$R" && REVIEW_PACK_SIMULATE_PUBLISH_FAILURE=simulate-publish-failure bash "$SCRIPT" --base main 2>&1)"; RC=$?
if [[ $RC -ne 0 ]]; then ok "a failed publish fails the run"; else bad "a failed publish fails the run (got 0)"; fi
if cmp -s "$TMP/keep.json" "$R/.review/manifest.json"; then
  ok "the previous pack is restored, not lost"; else bad "the previous pack is restored, not lost"; fi
if ! compgen -G "$R/.review.prev.*" >/dev/null 2>&1; then
  ok "rollback leaves no .review.prev.*"; else bad "rollback leaves no .review.prev.*"; fi
if has_failed "$R"; then ok "the failed attempt is still kept as .review-FAILED-*"; else bad "the failed attempt is still kept as .review-FAILED-*"; fi

R="$(newrepo)"
commit_file "$R" "parking-system/lib/p.ts" "export const p = 1"
run_pack "$R" >/dev/null 2>&1
commit_file "$R" "parking-system/lib/q.ts" "export const q = 1"
run_pack "$R" >/dev/null 2>&1
if grep -q 'lib/q.ts' "$R/.review/FILES.txt" 2>/dev/null; then
  ok "a successful re-publish replaces the old pack"; else bad "a successful re-publish replaces the old pack"; fi
if ! compgen -G "$R/.review.prev.*" >/dev/null 2>&1; then
  ok "a successful re-publish leaves no .review.prev.*"; else bad "a successful re-publish leaves no .review.prev.*"; fi

echo "make-review-pack.sh — secret / PII scan"

# The planted values are assembled at runtime, so no line of THIS file matches
# deny-patterns.txt. Found by dogfooding: with the values written out literally, the pack
# script correctly refused to pack its own test suite. Splitting them keeps the fixtures
# honest (the assembled string is exactly what a real leak looks like) without making the
# scanner's own source unpackable. Every value is transparently fake.
J="eyJ"; FAKE_JWT="${J}fakefakefakefakefakefake.fake.fake"
FAKE_ECHO_PROBE="${J}seCretVALUEmustNOTbeECHOED123"
FAKE_DSN="postgres""ql://user:hunter2@db.example.invalid:5432/x"
FAKE_PHONE="09""12-345-678"
SRK="SUPABASE_SERVICE_ROLE""_KEY"

R="$(newrepo)"
commit_file "$R" "parking-system/lib/h.ts" "const k = '$FAKE_JWT'"
assert_fail "planted JWT-shaped key is refused" "$R" "scan rejected this diff"

R="$(newrepo)"
commit_file "$R" ".env.local" "$SRK=not-a-real-key"
assert_fail "a committed .env.local is refused" "$R" "env file"

R="$(newrepo)"
commit_file "$R" "parking-system/.env.example" "$SRK="
OUT="$(run_pack "$R")"; RC=$?
if [[ $RC -eq 0 ]]; then ok ".env.example with an empty value is allowed"; else bad ".env.example with an empty value is allowed (got $RC: $(tail -2 <<<"$OUT" | tr '\n' ' '))"; fi

R="$(newrepo)"
commit_file "$R" "docs/notes.md" "connect via $FAKE_DSN"
assert_fail "connection string with inline password is refused" "$R" "scan rejected this diff"

R="$(newrepo)"
commit_file "$R" "docs/roster.md" "聯絡電話 $FAKE_PHONE"
assert_fail "a Taiwan mobile number is refused" "$R" "scan rejected this diff"

R="$(newrepo)"
commit_file "$R" "backup/db.age" "not really encrypted"
assert_fail "an .age artifact is refused" "$R" "database dump or encrypted artifact"

echo "make-review-pack.sh — the scan does not print what it found"
R="$(newrepo)"
commit_file "$R" "parking-system/lib/i.ts" "const k = '$FAKE_ECHO_PROBE'"
OUT="$(run_pack "$R")"
if ! grep -qF -- "$FAKE_ECHO_PROBE" <<<"$OUT"; then
  ok "the matched line is never echoed"; else bad "the matched line is never echoed"; fi

# The scan reason is the only multi-line failure reason the script produces (one line per
# matching pattern, plus a leading newline), so it is the one that broke a line-oriented
# escaper. The pack for the most safety-relevant failure was the one with an unparseable
# manifest — and the earlier JSON check only ever ran on a single-line verify failure.
FDIR="$(compgen -G "$R/.review-FAILED-*" | head -1)"
if [[ -n "$FDIR" ]] && valid_json "$FDIR/manifest.json"; then
  ok "a multi-line scan reason still yields valid JSON"; else bad "a multi-line scan reason still yields valid JSON"; fi
if grep -q '"failed_stage": "scan"' "$FDIR/manifest.json" 2>/dev/null; then
  ok "FAILED manifest names the scan stage"; else bad "FAILED manifest names the scan stage"; fi
if ! grep -qF -- "$FAKE_ECHO_PROBE" "$FDIR/manifest.json" 2>/dev/null; then
  ok "the matched value never reaches the manifest either"; else bad "the matched value never reaches the manifest either"; fi

echo "make-review-pack.sh — control characters from external commands cannot break the manifest"
# `node --version`, `npm --version` and `uname -sr` are command OUTPUT, not text this script
# composed, and --base is whatever the caller typed. A wrapper that emits an escape sequence
# would put a raw C0 byte in the manifest; JSON requires everything below U+0020 to be escaped
# whether or not it has a short form. The seam feeds VT, ESC, BS and FF in through npm.
R="$(newrepo)"
commit_file "$R" "parking-system/lib/r.ts" "export const r = 1"
OUT="$(cd "$R" && FAKE_NPM_VERSION_SUFFIX=$'\x0b\x1b\x08\x0c' bash "$SCRIPT" --base main 2>&1)"; RC=$?
if [[ $RC -eq 0 ]]; then ok "a control character in npm --version does not fail the run"
  else bad "a control character in npm --version does not fail the run (got $RC)"; fi
if valid_json "$R/.review/manifest.json"; then
  ok "the manifest is still valid JSON"; else bad "the manifest is still valid JSON"; fi
if grep -qF -- '\u000b' "$R/.review/manifest.json" 2>/dev/null \
   && grep -qF -- '\u001b' "$R/.review/manifest.json" 2>/dev/null; then
  ok "control characters with no short form become \\u00XX"; else bad "control characters with no short form become \\u00XX"; fi
if grep -qF -- '\b\f' "$R/.review/manifest.json" 2>/dev/null; then
  ok "backspace and form feed keep their short forms"; else bad "backspace and form feed keep their short forms"; fi
if ! LC_ALL=C grep -q '[[:cntrl:]]' <(tr -d '\n' < "$R/.review/manifest.json") 2>/dev/null; then
  ok "no raw control byte survives into the manifest"; else bad "no raw control byte survives into the manifest"; fi

echo "make-review-pack.sh — editing the pattern file trips its own scanner"
R="$(newrepo)"
printf '\n# added by test\nTOTALLY_FAKE_TOKEN=[a-z]+\n' >> "$R/scripts/review/deny-patterns.txt"
( cd "$R" && git add -A && git commit -qm "edit patterns" ) >/dev/null 2>&1
assert_fail "pattern-file change needs the explicit flag" "$R" "--allow-pattern-file-change"
OUT="$(run_pack "$R" --allow-pattern-file-change)"; RC=$?
if [[ $RC -eq 0 ]]; then ok "the flag lets a deliberate pattern edit through"; else bad "the flag lets a deliberate pattern edit through (got $RC: $(tail -2 <<<"$OUT" | tr '\n' ' '))"; fi
if grep -q '"allow_pattern_file_change": true' "$R/.review/manifest.json" 2>/dev/null; then
  ok "the waiver is recorded in the manifest"; else bad "the waiver is recorded in the manifest"; fi
if grep -q 'part of the secret scan was skipped' "$R/.review/REVIEW.md" 2>/dev/null; then
  ok "the waiver is visible in REVIEW.md too"; else bad "the waiver is visible in REVIEW.md too"; fi

echo "make-review-pack.sh — the narrative"
# REVIEW.md is checksummed, so an implementer who fills it in after the fact voids their own
# pack. The narrative is therefore handed in BEFORE the build. These cases pin the three ways
# that can go wrong: silently shipping a blank form, dropping the sections the PR template
# requires, and a --narrative path that does not exist.
NARRATIVE_BODY='## 這一刀做了什麼

改了一個常數。

## Database compatibility

- [x] 這一刀沒有 migration'

R="$(newrepo)"
commit_file "$R" "parking-system/lib/n.ts" "export const n = 1"
printf '%s\n' "$NARRATIVE_BODY" > "$R/notes.md"
OUT="$(run_pack "$R" --narrative notes.md)"; RC=$?
if [[ $RC -eq 0 ]]; then ok "--narrative builds a pack"; else bad "--narrative builds a pack (got $RC: $(tail -2 <<<"$OUT" | tr '\n' ' '))"; fi
if grep -qF -- "改了一個常數" "$R/.review/REVIEW.md" 2>/dev/null; then
  ok "the narrative body lands in REVIEW.md"; else bad "the narrative body lands in REVIEW.md"; fi
if grep -q '"narrative": "notes.md"' "$R/.review/manifest.json" 2>/dev/null; then
  ok "the manifest records which file it came from"; else bad "the manifest records which file it came from"; fi

R="$(newrepo)"
commit_file "$R" "parking-system/lib/o.ts" "export const o = 1"
OUT="$(run_pack "$R")"; RC=$?
if [[ $RC -eq 0 ]] && grep -qF -- "blank template" "$R/.review/REVIEW.md" 2>/dev/null; then
  ok "no narrative still builds, but says so in REVIEW.md"; else bad "no narrative still builds, but says so in REVIEW.md"; fi
if grep -q '"narrative": null' "$R/.review/manifest.json" 2>/dev/null; then
  ok "the manifest records the absence too"; else bad "the manifest records the absence too"; fi

R="$(newrepo)"
commit_file "$R" "parking-system/lib/p.ts" "export const p = 1"
printf '%s\n' "$NARRATIVE_BODY" > "$R/$DEFAULT_NARRATIVE_NAME"
OUT="$(run_pack "$R")"; RC=$?
if [[ $RC -eq 0 ]] && grep -qF -- "改了一個常數" "$R/.review/REVIEW.md" 2>/dev/null; then
  ok "$DEFAULT_NARRATIVE_NAME is picked up without a flag"; else bad "$DEFAULT_NARRATIVE_NAME is picked up without a flag"; fi
# The hash has to cover the prose, or the reviewer cannot tell the narrative in front of them
# is the one that was packed — that gap is the entire reason this option exists. Asserted
# through the real workspace check, which is what decides whether a review is admissible.
if ( cd "$R" && bash "$WORKSPACE_CHECK" --phase pre >/dev/null 2>&1 ); then
  ok "the workspace check accepts a pack whose REVIEW.md carries prose"
else bad "the workspace check accepts a pack whose REVIEW.md carries prose"; fi

R="$(newrepo)"
commit_file "$R" "parking-system/lib/q.ts" "export const q = 1"
printf '## 這一刀做了什麼\n\n只有一段，沒有相容性那節。\n' > "$R/notes.md"
assert_fail "a narrative missing a template section is refused" "$R" "missing sections the PR template requires" --narrative notes.md

R="$(newrepo)"
commit_file "$R" "parking-system/lib/r.ts" "export const r = 1"
assert_fail "--narrative pointing at nothing never falls back to the blank form" "$R" "--narrative file not found" --narrative no-such-file.md

echo "make-review-pack.sh — what the narrative must not be able to smuggle in"
# The narrative is the first packet input the script does not generate itself, so the
# constructive safety argument ("nothing can be swept in") no longer covers it on its own.
# These four cases are the ones that turn that from a sentence into a guarantee.

# F-001a: prose is a channel into the pack, so it gets the same deny patterns as the diff.
R="$(newrepo)"
commit_file "$R" "parking-system/lib/s.ts" "export const s = 1"
printf '%s\n\n%s\n\n%s\n' "## 這一刀做了什麼" "聯絡 $FAKE_PHONE" "## Database compatibility" > "$R/notes.md"
assert_fail "a narrative carrying a deny-pattern hit is refused" "$R" "scan rejected the narrative" --narrative notes.md

# F-001b: and it cannot be pulled in from outside the checkout in the first place.
R="$(newrepo)"
commit_file "$R" "parking-system/lib/s2.ts" "export const s2 = 1"
OUTSIDE_DIR="$(mktemp -d)"
printf '%s\n\n%s\n' "## 這一刀做了什麼" "## Database compatibility" > "$OUTSIDE_DIR/outside.md"
assert_fail "a narrative outside the repository is refused" "$R" "inside the repository" --narrative "$OUTSIDE_DIR/outside.md"
rm -rf "$OUTSIDE_DIR"

# F-002: validated bytes and published bytes must be the same bytes.
R="$(newrepo)"
commit_file "$R" "parking-system/lib/t.ts" "export const t = 1"
printf '%s\n' "$NARRATIVE_BODY" > "$R/$DEFAULT_NARRATIVE_NAME"
OUT="$(cd "$R" && FAKE_REWRITE_NARRATIVE="$R/$DEFAULT_NARRATIVE_NAME" bash "$SCRIPT" --base main 2>&1)"; RC=$?
if [[ $RC -ne 0 ]] || grep -qF -- "## Database compatibility" "$R/.review/REVIEW.md" 2>/dev/null; then
  ok "a narrative edited during verify cannot reach REVIEW.md"
else bad "a narrative edited during verify cannot reach REVIEW.md (rc=$RC, published the rewritten text)"; fi

# F-003a: a required heading that exists only inside a fenced block is not a section.
R="$(newrepo)"
commit_file "$R" "parking-system/lib/u.ts" "export const u = 1"
# shellcheck disable=SC2016  # the backticks are a markdown fence in test data, not a subshell
{ printf '示範一下範本長什麼樣：\n\n'; printf '```\n## 這一刀做了什麼\n## Database compatibility\n```\n'; } > "$R/notes.md"
assert_fail "headings only inside a code fence do not satisfy the gate" "$R" "missing sections" --narrative notes.md

# F-003b: an exact heading, not a superstring — otherwise "## X 補充" quietly counts as "## X".
R="$(newrepo)"
commit_file "$R" "parking-system/lib/w.ts" "export const w = 1"
printf '## 這一刀做了什麼\n\n有寫。\n\n## Database compatibility 補充說明\n\n有寫。\n' > "$R/notes.md"
assert_fail "a decorated heading does not satisfy the requirement" "$R" "missing sections" --narrative notes.md

# F-003c: a template with no sections cannot gate anything — refuse rather than wave through.
# Narrative is non-empty here, so this bites on the template rule and not on the empty check.
R="$(newrepo)"
printf '沒有任何 level-2 標題的範本\n' > "$R/.github/PULL_REQUEST_TEMPLATE.md"
( cd "$R" && git add .github/PULL_REQUEST_TEMPLATE.md && git commit -qm "headingless template" ) >/dev/null 2>&1
commit_file "$R" "parking-system/lib/v.ts" "export const v = 1"
printf '寫了一些字，但範本沒有任何一節可以對照。\n' > "$R/notes.md"
assert_fail "a headingless template cannot gate a narrative" "$R" "cannot gate" --narrative notes.md

# An empty narrative is not an account of anything, whatever the template says.
R="$(newrepo)"
commit_file "$R" "parking-system/lib/x.ts" "export const x = 1"
printf '   \n\n\t\n' > "$R/notes.md"
assert_fail "a whitespace-only narrative is refused" "$R" "is empty" --narrative notes.md

echo "make-review-pack.sh — round 2: the channels the first fix left open"

# F-001a: the boundary canonicalised only the directory, so the final component could be a
# symlink pointing anywhere. In-repo path, out-of-repo bytes.
R="$(newrepo)"
commit_file "$R" "parking-system/lib/y.ts" "export const y = 1"
OUTSIDE_DIR="$(mktemp -d)"
printf '%s\n\n%s\n' "## 這一刀做了什麼" "## Database compatibility" > "$OUTSIDE_DIR/target.md"
ln -s "$OUTSIDE_DIR/target.md" "$R/notes.md"
assert_fail "a symlinked narrative is refused" "$R" "symlink" --narrative notes.md
rm -rf "$OUTSIDE_DIR"

# F-001b: the path itself is user content and lands in manifest.json and REVIEW.md. The
# script already refuses a *changed file path* that matches a deny pattern; the narrative
# path was the one that walked straight in.
R="$(newrepo)"
commit_file "$R" "parking-system/lib/z.ts" "export const z = 1"
LEAKY="notes-$FAKE_PHONE.md"
printf '%s\n\n%s\n' "## 這一刀做了什麼" "## Database compatibility" > "$R/$LEAKY"
assert_fail "a narrative filename matching a deny pattern is refused" "$R" "invocation" --narrative "$LEAKY"

# F-003a: markdown closes a fence with the SAME marker character. A tilde line does not
# close a backtick fence, so these headings are still fenced.
R="$(newrepo)"
commit_file "$R" "parking-system/lib/aa.ts" "export const aa = 1"
# shellcheck disable=SC2016  # markdown fences in test data, not command substitution
{ printf '```\n'; printf '~~~\n'; printf '## 這一刀做了什麼\n## Database compatibility\n'; } > "$R/notes.md"
assert_fail "a mixed-marker fence does not end the fence" "$R" "missing sections" --narrative notes.md

# F-003b: a closing run must be at least as long as the opener. Three backticks do not close
# a four-backtick fence.
R="$(newrepo)"
commit_file "$R" "parking-system/lib/ab.ts" "export const ab = 1"
# shellcheck disable=SC2016  # markdown fences in test data, not command substitution
{ printf '````\n'; printf '```\n'; printf '## 這一刀做了什麼\n## Database compatibility\n'; } > "$R/notes.md"
assert_fail "a shorter closing fence does not end the fence" "$R" "missing sections" --narrative notes.md

# ...and the legitimate case still works: a fence that really does close, with the headings
# after it. Without this, "refuse everything" would pass the two cases above.
R="$(newrepo)"
commit_file "$R" "parking-system/lib/ac.ts" "export const ac = 1"
# shellcheck disable=SC2016  # markdown fences in test data, not command substitution
{ printf '````\n'; printf '## 不算數的標題\n'; printf '````\n\n'; printf '## 這一刀做了什麼\n\n有寫。\n\n## Database compatibility\n\n沒有 migration。\n'; } > "$R/notes.md"
OUT="$(run_pack "$R" --narrative notes.md)"; RC=$?
if [[ $RC -eq 0 ]]; then ok "a properly closed fence still ends, headings after it count"
else bad "a properly closed fence still ends, headings after it count (got $RC: $(tail -2 <<<"$OUT" | tr '\n' ' '))"; fi

echo "make-review-pack.sh — round 3: rejected input must not survive in the wreckage"

# A refusal is not containment. The value that got rejected must not come back out through
# stderr or through the .review-FAILED-* manifest the exit trap leaves behind — that
# directory is kept on purpose, so anything written into it is as published as a pack.
NARRATIVE_OK="## 這一刀做了什麼

有寫。

## Database compatibility

- [x] 沒有 migration"

R="$(newrepo)"
commit_file "$R" "parking-system/lib/ad.ts" "export const ad = 1"
LEAKY="notes-$FAKE_PHONE.md"
printf '%s\n' "$NARRATIVE_OK" > "$R/$LEAKY"
OUT="$(run_pack "$R" --narrative "$LEAKY")"; RC=$?
if [[ $RC -ne 0 ]]; then ok "a deny-matching filename is refused"; else bad "a deny-matching filename is refused (got 0)"; fi
if ! grep -qF -- "$FAKE_PHONE" <<<"$OUT"; then ok "the refusal does not echo the matched filename"
else bad "the refusal does not echo the matched filename"; fi
if ! grep -rqF -- "$FAKE_PHONE" "$R"/.review-FAILED-* 2>/dev/null; then
  ok "the matched value is absent from the retained failed artifacts"
else bad "the matched value is absent from the retained failed artifacts"; fi

# Same filename, but with a narrative that would ALSO fail a later check. Ordering is the
# whole fix: the heading gate interpolates the path into its message, so validating first
# would print the value the scan exists to contain.
R="$(newrepo)"
commit_file "$R" "parking-system/lib/ad2.ts" "export const ad2 = 1"
printf '## 這一刀做了什麼\n\n少了相容性那節。\n' > "$R/$LEAKY"
OUT="$(run_pack "$R" --narrative "$LEAKY")"; RC=$?
if [[ $RC -ne 0 ]] && ! grep -qF -- "$FAKE_PHONE" <<<"$OUT"; then
  ok "a later validation failure cannot leak the filename either"
else bad "a later validation failure cannot leak the filename either (rc=$RC)"; fi

# The path is interpolated into an HTML comment and a Markdown table in REVIEW.md. A filename
# is user input; one containing a comment terminator rewrites the machine-generated header,
# which is the part a reviewer is supposed to be able to trust without reading the generator.
R="$(newrepo)"
commit_file "$R" "parking-system/lib/ae.ts" "export const ae = 1"
INJECT="$(printf 'notes\n--> injected.md')"
printf '%s\n' "$NARRATIVE_OK" > "$R/$INJECT"
assert_fail "a filename that can break the evidence header is refused" "$R" "" --narrative "$INJECT"

echo "make-review-pack.sh — round 3: a closing fence cannot carry trailing content"
# Markdown allows only spaces/tabs after a closing fence. A marker with text after it is
# still content inside the open fence, so the headings below it are still fenced.
R="$(newrepo)"
commit_file "$R" "parking-system/lib/af.ts" "export const af = 1"
# shellcheck disable=SC2016  # markdown fences in test data, not command substitution
{ printf '```\n'; printf '``` still-code\n'; printf '## 這一刀做了什麼\n## Database compatibility\n'; } > "$R/notes.md"
assert_fail "a marker with trailing text does not close the fence" "$R" "missing sections" --narrative notes.md

# ...and trailing WHITESPACE is still a valid closer, so the fix is not "refuse everything".
R="$(newrepo)"
commit_file "$R" "parking-system/lib/ag.ts" "export const ag = 1"
# shellcheck disable=SC2016  # markdown fences in test data, not command substitution
{ printf '```\n'; printf '## 不算數的標題\n'; printf '```   \n\n'; printf '%s\n' "$NARRATIVE_OK"; } > "$R/notes.md"
OUT="$(run_pack "$R" --narrative notes.md)"; RC=$?
if [[ $RC -eq 0 ]]; then ok "a closer followed by spaces still closes the fence"
else bad "a closer followed by spaces still closes the fence (got $RC: $(tail -2 <<<"$OUT" | tr '\n' ' '))"; fi

echo "make-review-pack.sh — round 4: the two channels that outrank the scan"

# The parser runs before the invocation scan can run — it has to, the scan needs the repo
# root and the pattern file. So the parser itself must not print what it was given.
R="$(newrepo)"
commit_file "$R" "parking-system/lib/ah.ts" "export const ah = 1"
OUT="$(cd "$R" && bash "$SCRIPT" --base main "--unknown-$FAKE_PHONE" 2>&1)"; RC=$?
if [[ $RC -eq 2 ]]; then ok "an unknown argument still exits 2"; else bad "an unknown argument still exits 2 (got $RC)"; fi
if ! grep -qF -- "$FAKE_PHONE" <<<"$OUT"; then ok "the parser does not echo the argument it rejected"
else bad "the parser does not echo the argument it rejected"; fi

# The narrative body must never be written inside the directory the EXIT trap preserves.
# Behaviour cannot reach every interrupt point, so this is asserted structurally: the value
# that must not be retained is never put where retention happens.
# shellcheck disable=SC2016  # the $PACK here is a literal being searched for in the script
if ! grep -qE '>[[:space:]]*"\$PACK[^"]*scan-narrative' "$SCRIPT"; then
  ok "the narrative snapshot is never written under \$PACK"
else bad "the narrative snapshot is never written under \$PACK"; fi
R="$(newrepo)"
commit_file "$R" "parking-system/lib/ai.ts" "export const ai = 1"
printf '## 這一刀做了什麼\n\n聯絡 %s\n\n## Database compatibility\n' "$FAKE_PHONE" > "$R/notes.md"
OUT="$(run_pack "$R" --narrative notes.md)"; RC=$?
if [[ $RC -ne 0 ]] && ! grep -rqF -- "$FAKE_PHONE" "$R"/.review-FAILED-* 2>/dev/null; then
  ok "a rejected narrative body is absent from the retained failed directory"
else bad "a rejected narrative body is absent from the retained failed directory (rc=$RC)"; fi

echo "make-review-pack.sh — round 4: markdown hides things in more than one way"
# CommonMark allows at most three spaces before a fence marker. Four is content, so the
# fence is still open and the headings below it are still code.
R="$(newrepo)"
commit_file "$R" "parking-system/lib/aj.ts" "export const aj = 1"
# shellcheck disable=SC2016  # markdown fences in test data, not command substitution
{ printf '```\n'; printf '    ```\n'; printf '## 這一刀做了什麼\n## Database compatibility\n'; } > "$R/notes.md"
assert_fail "a four-space-indented closer does not close the fence" "$R" "missing sections" --narrative notes.md

# A leading tab advances to the next tab stop, i.e. four columns — same rule, same answer.
R="$(newrepo)"
commit_file "$R" "parking-system/lib/ak.ts" "export const ak = 1"
# shellcheck disable=SC2016  # markdown fences in test data, not command substitution
{ printf '```\n'; printf '\t```\n'; printf '## 這一刀做了什麼\n## Database compatibility\n'; } > "$R/notes.md"
assert_fail "a tab-indented closer does not close the fence" "$R" "missing sections" --narrative notes.md

# ...but three spaces is a legal closer, so the indent rule is a boundary and not a ban.
R="$(newrepo)"
commit_file "$R" "parking-system/lib/al.ts" "export const al = 1"
# shellcheck disable=SC2016  # markdown fences in test data, not command substitution
{ printf '```\n'; printf '## 不算數的標題\n'; printf '   ```\n\n'; printf '%s\n' "$NARRATIVE_OK"; } > "$R/notes.md"
OUT="$(run_pack "$R" --narrative notes.md)"; RC=$?
if [[ $RC -eq 0 ]]; then ok "a three-space-indented closer still closes the fence"
else bad "a three-space-indented closer still closes the fence (got $RC: $(tail -2 <<<"$OUT" | tr '\n' ' '))"; fi

# A fence is not the only thing that hides a line. Inside an HTML comment those two lines
# render as nothing at all, so a reader sees a narrative with no required sections.
R="$(newrepo)"
commit_file "$R" "parking-system/lib/am.ts" "export const am = 1"
printf '<!--\n## 這一刀做了什麼\n## Database compatibility\n-->\n\n看起來什麼都沒有。\n' > "$R/notes.md"
assert_fail "headings inside an HTML comment do not count" "$R" "missing sections" --narrative notes.md

# Same for a raw HTML block.
R="$(newrepo)"
commit_file "$R" "parking-system/lib/an.ts" "export const an = 1"
printf '<div>\n## 這一刀做了什麼\n## Database compatibility\n</div>\n' > "$R/notes.md"
assert_fail "headings inside an HTML block do not count" "$R" "missing sections" --narrative notes.md

# ...and an HTML comment that ends does not swallow the rest of the document.
R="$(newrepo)"
commit_file "$R" "parking-system/lib/ao.ts" "export const ao = 1"
{ printf '<!-- 給下一個人的說明 -->\n\n'; printf '%s\n' "$NARRATIVE_OK"; } > "$R/notes.md"
OUT="$(run_pack "$R" --narrative notes.md)"; RC=$?
if [[ $RC -eq 0 ]]; then ok "a closed HTML comment does not hide the headings after it"
else bad "a closed HTML comment does not hide the headings after it (got $RC: $(tail -2 <<<"$OUT" | tr '\n' ' '))"; fi

echo "make-review-pack.sh — round 5: all seven CommonMark HTML block types"
# CommonMark §4.6 defines seven kinds of HTML block, each with its own end condition. Three
# of them (<?, <!DECLARATION, <![CDATA[) were not recognised at all, so a heading inside one
# counted as a real heading — and the comment in the source claimed the opposite.

R="$(newrepo)"
commit_file "$R" "parking-system/lib/ap.ts" "export const ap = 1"
printf '<?php\n## 這一刀做了什麼\n## Database compatibility\n?>\n' > "$R/notes.md"
assert_fail "type 3: headings inside <? ... ?> do not count" "$R" "missing sections" --narrative notes.md

R="$(newrepo)"
commit_file "$R" "parking-system/lib/aq.ts" "export const aq = 1"
printf '<!DOCTYPE\n## 這一刀做了什麼\n## Database compatibility\n>\n' > "$R/notes.md"
assert_fail "type 4: headings inside a declaration do not count" "$R" "missing sections" --narrative notes.md

R="$(newrepo)"
commit_file "$R" "parking-system/lib/ar.ts" "export const ar = 1"
printf '<![CDATA[\n## 這一刀做了什麼\n## Database compatibility\n]]>\n' > "$R/notes.md"
assert_fail "type 5: headings inside CDATA do not count" "$R" "missing sections" --narrative notes.md

# type 1 ends on the literal closing tag; a bare substring closed it early.
R="$(newrepo)"
commit_file "$R" "parking-system/lib/as.ts" "export const as_ = 1"
printf '<script>\n</scriptish\n## 這一刀做了什麼\n## Database compatibility\n</script>\n' > "$R/notes.md"
assert_fail "type 1: a near-miss closing tag does not end the block" "$R" "missing sections" --narrative notes.md

# ...and a block that closes on its own line never opened, so what follows is ordinary text.
R="$(newrepo)"
commit_file "$R" "parking-system/lib/at.ts" "export const at = 1"
{ printf '<?php echo 1; ?>\n\n'; printf '%s\n' "$NARRATIVE_OK"; } > "$R/notes.md"
OUT="$(run_pack "$R" --narrative notes.md)"; RC=$?
if [[ $RC -eq 0 ]]; then ok "a single-line HTML block does not hide what follows it"
else bad "a single-line HTML block does not hide what follows it (got $RC: $(tail -2 <<<"$OUT" | tr '\n' ' '))"; fi

echo "make-review-pack.sh — round 5: the checks must bind to the bytes"
# Every path check is worthless if the read re-opens the path afterwards: a review fixture
# swapped the file for a symlink in between and published bytes from OUTSIDE the repository
# into a completed pack. The file is now opened once and read from that descriptor.
OUTSIDE_DIR="$(mktemp -d)"
printf '## 這一刀做了什麼\n\nOUTSIDE-MARKER\n\n## Database compatibility\n' > "$OUTSIDE_DIR/target.md"

R="$(newrepo)"
commit_file "$R" "parking-system/lib/au.ts" "export const au = 1"
printf '## 這一刀做了什麼\n\nINSIDE-MARKER\n\n## Database compatibility\n' > "$R/notes.md"
OUT="$(cd "$R" && FAKE_SWAP_BEFORE_OPEN="$R/notes.md" FAKE_SWAP_TARGET="$OUTSIDE_DIR/target.md" \
        bash "$SCRIPT" --base main --narrative notes.md 2>&1)"; RC=$?
if [[ $RC -ne 0 ]]; then ok "a swap before the open is refused"; else bad "a swap before the open is refused (got 0)"; fi
if ! grep -rqF -- "OUTSIDE-MARKER" "$R"/.review "$R"/.review-FAILED-* 2>/dev/null; then
  ok "outside bytes reach neither a pack nor the failed artifacts"
else bad "outside bytes reach neither a pack nor the failed artifacts"; fi

R="$(newrepo)"
commit_file "$R" "parking-system/lib/av.ts" "export const av = 1"
printf '## 這一刀做了什麼\n\nINSIDE-MARKER\n\n## Database compatibility\n' > "$R/notes.md"
OUT="$(cd "$R" && FAKE_SWAP_AFTER_OPEN="$R/notes.md" FAKE_SWAP_TARGET="$OUTSIDE_DIR/target.md" \
        bash "$SCRIPT" --base main --narrative notes.md 2>&1)"; RC=$?
if [[ $RC -ne 0 ]]; then ok "a swap after the open is refused too"; else bad "a swap after the open is refused too (got 0)"; fi
if ! grep -rqF -- "OUTSIDE-MARKER" "$R"/.review "$R"/.review-FAILED-* 2>/dev/null; then
  ok "the descriptor, not the path, decided what was read"
else bad "the descriptor, not the path, decided what was read"; fi
rm -rf "$OUTSIDE_DIR"

echo "make-review-pack.sh — round 6: ordinary documents must go through"
# The gate had been tightened five times against crafted documents, and had quietly become
# unable to accept legitimate ones: inline HTML, an autolink, and a one-line <style> block all
# started an HTML block that swallowed the headings after them. False rejection is the worse
# failure — a bypass costs a review, this costs the author the ability to submit at all.

narrative_after() {  # <prefix-line> -> a narrative with that line, then the required sections
  printf '%s\n\n%s\n' "$1" "$NARRATIVE_OK"
}

R="$(newrepo)"
commit_file "$R" "parking-system/lib/aw.ts" "export const aw = 1"
narrative_after '<span>Reviewer note</span>' > "$R/notes.md"
OUT="$(run_pack "$R" --narrative notes.md)"; RC=$?
if [[ $RC -eq 0 ]]; then ok "inline HTML in prose is not an HTML block"
else bad "inline HTML in prose is not an HTML block (got $RC)"; fi

R="$(newrepo)"
commit_file "$R" "parking-system/lib/ax.ts" "export const ax = 1"
narrative_after '<https://example.com>' > "$R/notes.md"
OUT="$(run_pack "$R" --narrative notes.md)"; RC=$?
if [[ $RC -eq 0 ]]; then ok "an autolink is not an HTML block"
else bad "an autolink is not an HTML block (got $RC)"; fi

R="$(newrepo)"
commit_file "$R" "parking-system/lib/ay.ts" "export const ay = 1"
narrative_after '<style>.note { color: red; }</style>' > "$R/notes.md"
OUT="$(run_pack "$R" --narrative notes.md)"; RC=$?
if [[ $RC -eq 0 ]]; then ok "a one-line <style> block ends on its own line"
else bad "a one-line <style> block ends on its own line (got $RC)"; fi

echo "make-review-pack.sh — round 6: CommonMark type 1 start and end conditions"
# A mutation test showed the old suite could not tell these apart: deleting the type 1 end
# condition entirely still left every test green. Each case below fails if that rule is wrong
# in one specific way.

# Opener may end at end-of-line, not only at whitespace or ">".
R="$(newrepo)"
commit_file "$R" "parking-system/lib/az.ts" "export const az = 1"
{ printf '<script\n'; printf '%s\n' "$NARRATIVE_OK"; } > "$R/notes.md"
assert_fail "type 1: an opener at end-of-line still opens the block" "$R" "missing sections" --narrative notes.md

# The end tag is literal: "</script   >" is not "</script>".
R="$(newrepo)"
commit_file "$R" "parking-system/lib/ba.ts" "export const ba = 1"
{ printf '<script>\n'; printf '</script   >\n'; printf '%s\n' "$NARRATIVE_OK"; } > "$R/notes.md"
assert_fail "type 1: a spaced near-closer does not end the block" "$R" "missing sections" --narrative notes.md

# ...and ANY of the four end tags closes it, not just the matching one.
R="$(newrepo)"
commit_file "$R" "parking-system/lib/bb.ts" "export const bb = 1"
{ printf '<script>\n'; printf '</style>\n\n'; printf '%s\n' "$NARRATIVE_OK"; } > "$R/notes.md"
OUT="$(run_pack "$R" --narrative notes.md)"; RC=$?
if [[ $RC -eq 0 ]]; then ok "type 1: a different end tag also closes the block"
else bad "type 1: a different end tag also closes the block (got $RC)"; fi

# Type 6 is a fixed tag list; type 7 needs a complete tag alone on a line after a blank one.
R="$(newrepo)"
commit_file "$R" "parking-system/lib/bc.ts" "export const bc = 1"
{ printf '<div>\n'; printf '## 這一刀做了什麼\n## Database compatibility\n'; } > "$R/notes.md"
assert_fail "type 6: a listed block tag still hides what follows" "$R" "missing sections" --narrative notes.md

R="$(newrepo)"
commit_file "$R" "parking-system/lib/bd.ts" "export const bd = 1"
{ printf '<custom-widget>\n'; printf '## 這一刀做了什麼\n## Database compatibility\n'; } > "$R/notes.md"
assert_fail "type 7: a complete tag alone on a line hides what follows" "$R" "missing sections" --narrative notes.md

echo "make-review-pack.sh — round 6: rules a mutation test proved were unpinned"
# Deleting these rules left the whole suite green, which means the suite was not testing them.
# Each case below is red if its rule is removed.

# Type 4 that ends on its own line opens nothing.
R="$(newrepo)"
commit_file "$R" "parking-system/lib/be.ts" "export const be = 1"
{ printf '<!DOCTYPE html>\n\n'; printf '%s\n' "$NARRATIVE_OK"; } > "$R/notes.md"
OUT="$(run_pack "$R" --narrative notes.md)"; RC=$?
if [[ $RC -eq 0 ]]; then ok "type 4: a declaration closed on its own line hides nothing"
else bad "type 4: a declaration closed on its own line hides nothing (got $RC)"; fi

# Type 7 may not interrupt a paragraph: a tag on the line after prose is inline HTML.
R="$(newrepo)"
commit_file "$R" "parking-system/lib/bf.ts" "export const bf = 1"
{ printf '一段散文，下一行是換行標籤。\n'; printf '<br/>\n'; printf '%s\n' "$NARRATIVE_OK"; } > "$R/notes.md"
OUT="$(run_pack "$R" --narrative notes.md)"; RC=$?
if [[ $RC -eq 0 ]]; then ok "type 7: a tag mid-paragraph does not start a block"
else bad "type 7: a tag mid-paragraph does not start a block (got $RC)"; fi

# ...and a tag that is not on the type 6 list does not start one either, mid-paragraph.
R="$(newrepo)"
commit_file "$R" "parking-system/lib/bg.ts" "export const bg = 1"
{ printf '一段散文。\n'; printf '<custom-widget>\n'; printf '%s\n' "$NARRATIVE_OK"; } > "$R/notes.md"
OUT="$(run_pack "$R" --narrative notes.md)"; RC=$?
if [[ $RC -eq 0 ]]; then ok "type 6: an unlisted tag mid-paragraph does not start a block"
else bad "type 6: an unlisted tag mid-paragraph does not start a block (got $RC)"; fi

echo "make-review-pack.sh — round 7: the directories above the file can move too"
# Checking only the final component left the parent free to change after the boundary check
# passed; every stat and open afterwards then resolved through the new parent, so "before" and
# "after" agreed with each other and both described a file outside the repository.
R="$(newrepo)"
commit_file "$R" "parking-system/lib/bh.ts" "export const bh = 1"
mkdir -p "$R/drafts"
printf '## 這一刀做了什麼\n\nINSIDE-MARKER\n\n## Database compatibility\n' > "$R/drafts/notes.md"
OUTSIDE_DIR="$(mktemp -d)"
printf '## 這一刀做了什麼\n\nOUTSIDE-MARKER\n\n## Database compatibility\n' > "$OUTSIDE_DIR/notes.md"
OUT="$(cd "$R" && FAKE_SWAP_PARENT="$R/drafts" FAKE_SWAP_PARENT_TARGET="$OUTSIDE_DIR" \
        bash "$SCRIPT" --base main --narrative drafts/notes.md 2>&1)"; RC=$?
if [[ $RC -ne 0 ]]; then ok "a parent directory swapped for an outside symlink is refused"
else bad "a parent directory swapped for an outside symlink is refused (got 0)"; fi
if ! grep -rqF -- "OUTSIDE-MARKER" "$R"/.review "$R"/.review-FAILED-* 2>/dev/null; then
  ok "the outside parent's bytes reach neither a pack nor the failed artifacts"
else bad "the outside parent's bytes reach neither a pack nor the failed artifacts"; fi
rm -rf "$OUTSIDE_DIR"

# A narrative in a real subdirectory must still work — the check is on symlinks, not on depth.
R="$(newrepo)"
commit_file "$R" "parking-system/lib/bi.ts" "export const bi = 1"
mkdir -p "$R/drafts"
printf '%s\n' "$NARRATIVE_OK" > "$R/drafts/notes.md"
OUT="$(run_pack "$R" --narrative drafts/notes.md)"; RC=$?
if [[ $RC -eq 0 ]]; then ok "a narrative in a real subdirectory is still accepted"
else bad "a narrative in a real subdirectory is still accepted (got $RC: $(tail -2 <<<"$OUT" | tr '\n' ' '))"; fi

echo "make-review-pack.sh — argument and precondition handling"
R="$(newrepo)"
commit_file "$R" "parking-system/lib/j.ts" "export const j = 1"
OUT="$(cd "$R" && bash "$SCRIPT" --nope 2>&1)"; RC=$?
if [[ $RC -eq 2 ]]; then ok "unknown argument exits 2"; else bad "unknown argument exits 2 (got $RC)"; fi
OUT="$(cd "$R" && bash "$SCRIPT" --base no-such-ref 2>&1)"; RC=$?
if [[ $RC -ne 0 ]] && grep -qF -- "does not resolve" <<<"$OUT"; then
  ok "an unresolvable --base is refused"; else bad "an unresolvable --base is refused (rc=$RC)"; fi

R="$(newrepo)"
assert_fail "no commits between base and HEAD is refused" "$R" "nothing to review"

R="$(newrepo)"
commit_file "$R" "parking-system/lib/k.ts" "export const k = 1"
rm "$R/.github/PULL_REQUEST_TEMPLATE.md"
( cd "$R" && git add -A && git commit -qm "drop template" ) >/dev/null 2>&1
assert_fail "a missing PR template is refused (no second copy exists)" "$R" "PULL_REQUEST_TEMPLATE.md not found"

echo
echo "PASS $PASS   FAIL $FAIL"
[[ $FAIL -eq 0 ]]
