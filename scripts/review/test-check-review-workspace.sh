#!/usr/bin/env bash
#
# Tests for check-review-workspace.sh. Same shape as test-review-pack.sh: throwaway git repos
# under mktemp and a fake `npm` on PATH, so nothing here touches the real repo or the network.
#
# What this covers: that every VOID actually voids, that the things which are NOT grounds to
# void (a rebased base branch, an old pack) come out as WARN with exit 0, and that the script
# leaves the workspace exactly as it found it.
#
# Why that last one is a test and not a comment: the script is meant to be run by a reviewer
# operating under read-only permissions. If it ever created so much as a temp file, it would
# both violate that and trip its own clean-tree check on the next run.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK="$HERE/check-review-workspace.sh"
PACK_SCRIPT="$HERE/make-review-pack.sh"
PATTERNS="$HERE/deny-patterns.txt"
PASS=0; FAIL=0

ok()  { PASS=$((PASS+1)); echo "  PASS  $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL  $1"; }

TMP="$(mktemp -d)"; FAKEBIN="$(mktemp -d)"
trap 'rm -rf "$TMP" "$FAKEBIN"' EXIT

cat >"$FAKEBIN/npm" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  --version) echo "0.0.0-fake"; exit 0 ;;
  *) echo "fake npm ${1:-}"; exit 0 ;;
esac
EOF
chmod +x "$FAKEBIN/npm"
export PATH="$FAKEBIN:$PATH"

# A repo with a published .review/ pack, ready to be checked.
newpacked() {
  local d
  d="$(mktemp -d "$TMP/repo.XXXXXX")"
  mkdir -p "$d/parking-system" "$d/.github" "$d/scripts/review"
  (
    cd "$d" || exit 1
    git init -q -b main .
    git config user.email "test@example.invalid"
    git config user.name "Test"
    printf '{"name":"x","scripts":{"verify":"true"}}\n' > parking-system/package.json
    printf '## slice\n\n- **A — old app + new DB** SAFE / UNSAFE\n' > .github/PULL_REQUEST_TEMPLATE.md
    # `.env*` is ignored here for the same reason the real repo ignores it. It also keeps the
    # secret-env case honest: an unignored .env.local trips the dirty-tree gate as well, and a
    # case that voids for two reasons cannot show which one did the work. The checker finds
    # these with `find`, not git, so ignoring them hides nothing from it — a gitignored secret
    # is still a secret sitting in the workspace.
    printf '.review/\n.review-notes/\n.review-narrative.md\n.env\n.env.*\n' > .gitignore
    cp "$PATTERNS" scripts/review/deny-patterns.txt
    git add -A && git commit -qm "base"
    git checkout -qb work
    printf 'export const a = 1\n' > parking-system/a.ts
    git add -A && git commit -qm "add a"
    bash "$PACK_SCRIPT" --base main
  ) >/dev/null 2>&1
  echo "$d"
}

# run_check <repo> [args...] -> prints output, returns exit code
run_check() { local d="$1"; shift; ( cd "$d" && bash "$CHECK" "$@" ) 2>&1; }

# edit_manifest <repo> <js statements over `m`>
# Rewrites through JSON.parse/stringify, so the result is pretty-printed with the artifacts array
# spread over several lines. That is deliberate: it is also valid JSON, and every case below now
# runs against a manifest whose formatting differs from the generator's.
edit_manifest() {
  node -e '
    const fs = require("fs"), p = process.argv[1];
    const m = JSON.parse(fs.readFileSync(p, "utf8"));
    (new Function("m", process.argv[2]))(m);
    fs.writeFileSync(p, JSON.stringify(m, null, 2));
  ' "$1/.review/manifest.json" "$2"
}

# assert_void <desc> <repo> <line-fragment>
assert_void() {
  local desc="$1" d="$2" frag="$3"
  local out rc
  out="$(run_check "$d")"; rc=$?
  if [[ $rc -ne 1 ]]; then bad "$desc (expected exit 1, got $rc)"; return; fi
  if ! grep -q 'RESULT: VOID' <<<"$out"; then bad "$desc (no VOID result)"; return; fi
  if ! grep -q "$frag" <<<"$out" || ! grep -E "$frag.*VOID" <<<"$out" >/dev/null; then
    bad "$desc (VOID was not attributed to '$frag')"; return
  fi
  ok "$desc"
}

echo "check-review-workspace.sh — a clean workspace with a fresh pack"
R="$(newpacked)"
OUT="$(run_check "$R")"; RC=$?
if [[ $RC -eq 0 ]]; then ok "exits 0"; else bad "exits 0 (got $RC: $(tail -3 <<<"$OUT" | tr '\n' ' '))"; fi
if grep -q 'RESULT: OK' <<<"$OUT"; then ok "reports OK"; else bad "reports OK ($(tail -1 <<<"$OUT"))"; fi
if grep -q 'artifact checksums verified .*PASS.*7/7' <<<"$OUT" \
   || grep -qE 'artifact checksums verified +PASS +7/7' <<<"$OUT"; then
  ok "verifies every artifact checksum"; else bad "verifies every artifact checksum"; fi
if grep -q 'packet_manifest_sha256' <<<"$OUT"; then
  ok "prints the manifest sha256 for the findings header"; else bad "prints the manifest sha256"; fi
if grep -q 'phase: pre' <<<"$OUT"; then ok "labels the phase"; else bad "labels the phase"; fi
OUT2="$(run_check "$R" --phase post)"
if grep -q 'phase: post' <<<"$OUT2"; then ok "--phase post is labelled too"; else bad "--phase post is labelled"; fi

echo "check-review-workspace.sh — the check itself changes nothing"
BEFORE="$(cd "$R" && git status --porcelain --untracked-files=all)"
AFTER="$(run_check "$R" >/dev/null 2>&1; cd "$R" && git status --porcelain --untracked-files=all)"
if [[ "$BEFORE" == "$AFTER" ]]; then ok "leaves the working tree untouched"; else bad "leaves the working tree untouched"; fi

echo "check-review-workspace.sh — integrity failures void the review"
R="$(newpacked)"
( cd "$R" && git commit -q --allow-empty -m "moved on" ) >/dev/null 2>&1
assert_void "HEAD moved away from the packed commit" "$R" "HEAD == manifest head_sha"

R="$(newpacked)"
printf 'left behind\n' > "$R/parking-system/stray.ts"
assert_void "an untracked file in the workspace" "$R" "tree clean"

R="$(newpacked)"
printf 'x' >> "$R/.review/DIFF.patch"
assert_void "a tampered artifact" "$R" "artifact checksums verified"

R="$(newpacked)"
edit_manifest "$R" 'm.status = "failed";'
assert_void "a pack that is not complete" "$R" "pack status is complete"

# An orphan commit is a base that cannot be an ancestor of HEAD — the shape a history rewrite
# under a published pack would leave behind. Written into the manifest directly: the manifest is
# not self-checksummed, and pretending otherwise is what §9 of the protocol says out loud.
R="$(newpacked)"
ORPHAN="$( cd "$R" && git commit-tree "$(git rev-parse 'HEAD^{tree}')" -m orphan </dev/null )"
edit_manifest "$R" "m.repo.base_sha = '$ORPHAN';"
assert_void "a base that is no longer an ancestor" "$R" "still an ancestor"

R="$(newpacked)"
# Split so no line of THIS file matches deny-patterns.txt — written out literally, the pack
# script correctly refuses to pack its own test suite. Same dodge as test-review-pack.sh.
#
# Through assert_void, not an inline grep for the line: grepping only for "that row says VOID"
# passed even when the rule printed the row without setting the verdict, i.e. when the checker
# actually let the workspace through. Same shape as the four found in the phase-binding block,
# and the last one outside it.
SRK="SUPABASE_SERVICE_ROLE""_KEY"
printf '%s=nope\n' "$SRK" > "$R/parking-system/.env.local"
assert_void "a secret env file in the workspace" "$R" "no secret env file in workspace"

R="$(newpacked)"
rm -rf "$R/.review"
assert_void "no pack at all" "$R" "manifest is readable"

echo "check-review-workspace.sh — things that are not grounds to void"
# A stacked slice gets rebased while it waits for review. That moves base_ref without saying
# anything about the head under review, so it warns and the review still counts.
R="$(newpacked)"
( cd "$R" && git checkout -q main && git commit -q --allow-empty -m "base moved" && git checkout -q work ) >/dev/null 2>&1
OUT="$(run_check "$R")"; RC=$?
if [[ $RC -eq 0 ]]; then ok "a moved base_ref still exits 0"; else bad "a moved base_ref still exits 0 (got $RC)"; fi
if grep -q 'RESULT: WARN' <<<"$OUT"; then ok "a moved base_ref warns"; else bad "a moved base_ref warns"; fi
if grep -E 'base_ref unmoved since the pack +WARN' <<<"$OUT" >/dev/null; then
  ok "the warning names base_ref"; else bad "the warning names base_ref"; fi

# A real schema-1 manifest, not a schema-2 one with the number changed: it has neither the
# checksums nor the invocation record. Both absences have to surface, and neither may be read as
# reassurance. An earlier version of this test only edited the version number, which is why the
# waiver line went on claiming PASS for a pack that could not possibly know.
R="$(newpacked)"
edit_manifest "$R" 'm.schema_version = 1; delete m.artifact_sha256; delete m.invocation;'
OUT="$(run_check "$R")"; RC=$?
if [[ $RC -eq 0 ]] && grep -E 'artifact checksums verified +WARN' <<<"$OUT" >/dev/null; then
  ok "a pack predating checksums warns instead of voiding"; else bad "a pack predating checksums warns (rc=$RC)"; fi
if grep -E 'secret scan fully applied +WARN +UNKNOWN' <<<"$OUT" >/dev/null; then
  ok "an unrecorded waiver reports UNKNOWN, never PASS"; else bad "an unrecorded waiver reports UNKNOWN, never PASS"; fi
if grep -q 'RESULT: WARN' <<<"$OUT"; then
  ok "a schema-1 pack lands on WARN overall"; else bad "a schema-1 pack lands on WARN overall"; fi

R="$(newpacked)"
edit_manifest "$R" 'm.invocation.allow_pattern_file_change = true;'
OUT="$(run_check "$R")"; RC=$?
if [[ $RC -eq 0 ]] && grep -E 'secret scan fully applied +WARN' <<<"$OUT" >/dev/null; then
  ok "a waived pattern-file scan is surfaced as a warning"; else bad "a waived pattern-file scan is surfaced (rc=$RC)"; fi

echo "check-review-workspace.sh — stacked base is stated, not assumed"
R="$(newpacked)"
edit_manifest "$R" 'm.repo.base_ref = "chore/parent-slice";'
OUT="$(run_check "$R")"
if grep -q 'stacked review.*chore/parent-slice.*NOT main' <<<"$OUT"; then
  ok "a non-main base is called out"; else bad "a non-main base is called out"; fi

echo "check-review-workspace.sh — the manifest is read as JSON, not as text"
# The parser used to be grep and awk, which coupled the check to the generator's line breaks and
# truncated any value at the first JSON escape. These are the shapes that silently misread.
R="$(newpacked)"
edit_manifest "$R" 'm.artifacts = m.artifacts.slice();'   # re-emitted multi-line by JSON.stringify
OUT="$(run_check "$R")"; RC=$?
if [[ $RC -eq 0 ]] && grep -E 'artifact checksums verified +PASS +7/7' <<<"$OUT" >/dev/null; then
  ok "a multi-line artifacts array is still read"; else bad "a multi-line artifacts array is still read (rc=$RC)"; fi

R="$(newpacked)"
edit_manifest "$R" 'm.repo.base_ref = String.fromCharCode(102,111,111,34,98,97,114);'
OUT="$(run_check "$R")"
if grep -q 'stacked review.*foo"bar' <<<"$OUT"; then
  ok "a base_ref containing a quote survives the round trip"; else bad "a base_ref containing a quote survives the round trip"; fi

R="$(newpacked)"
printf 'not json at all\n' > "$R/.review/manifest.json"
assert_void "an unparseable manifest" "$R" "manifest schema is valid"

echo "check-review-workspace.sh — a broken manifest voids, it does not degrade to WARN"
# The WARN for a missing checksum exists for packs built before checksums did. A complete
# schema-2 pack that has LOST them is a corrupted integrity record, and letting it take the same
# path would turn the strongest check in the script into an advisory note.
R="$(newpacked)"
edit_manifest "$R" 'm.artifact_sha256 = {};'
assert_void "a complete schema-2 pack with no checksums" "$R" "manifest schema is valid"

R="$(newpacked)"
edit_manifest "$R" 'm.artifact_sha256[m.artifacts[0]] = null;'
assert_void "a null checksum" "$R" "manifest schema is valid"

R="$(newpacked)"
edit_manifest "$R" 'm.artifact_sha256[m.artifacts[0]] = 0;'
assert_void "a numeric checksum" "$R" "manifest schema is valid"

R="$(newpacked)"
edit_manifest "$R" 'm.artifact_sha256[m.artifacts[0]] = "deadbeef";'
assert_void "a checksum that is not 64 hex digits" "$R" "manifest schema is valid"

R="$(newpacked)"
edit_manifest "$R" 'm.artifacts.push({ path: "sneaky" });'
assert_void "a non-string artifact entry" "$R" "manifest schema is valid"

# A tab in a value would split a TSV row and shift every field after it. The emitter refuses
# rather than assuming the generator never writes one.
R="$(newpacked)"
edit_manifest "$R" 'm.repo.base_ref = "main" + String.fromCharCode(9) + "extra";'
assert_void "a control character in a value the checker forwards" "$R" "manifest schema is valid"

R="$(newpacked)"
edit_manifest "$R" 'm.invocation.allow_pattern_file_change = null;'
assert_void "a non-boolean waiver flag" "$R" "manifest schema is valid"

R="$(newpacked)"
edit_manifest "$R" 'm.artifacts = "DIFF.patch";'
assert_void "artifacts that is not an array" "$R" "manifest schema is valid"

echo "check-review-workspace.sh — an unrecognised manifest version is not a permissive default"
# Absent used to mean 0, i.e. "older than checksums", i.e. the most forgiving grade available.
# No generator has ever written a manifest without schema_version, so absent does not mean old.
R="$(newpacked)"
edit_manifest "$R" 'delete m.schema_version;'
assert_void "a manifest with no schema_version" "$R" "manifest schema is valid"

R="$(newpacked)"
edit_manifest "$R" 'm.schema_version = 3;'
assert_void "a manifest newer than this checker" "$R" "manifest schema is valid"

echo "check-review-workspace.sh — every checksum entry is validated, not just the listed ones"
R="$(newpacked)"
edit_manifest "$R" 'm.artifact_sha256["not-an-artifact"] = null;'
assert_void "a checksum entry for a file the pack does not list" "$R" "manifest schema is valid"

R="$(newpacked)"
edit_manifest "$R" 'm.artifact_sha256[m.artifacts[0] + String.fromCharCode(9)] = "0".repeat(64);'
assert_void "a checksum key holding a control character" "$R" "manifest schema is valid"

echo "check-review-workspace.sh — regressions the previous round left untested"
R="$(newpacked)"
edit_manifest "$R" 'm.artifacts = []; m.artifact_sha256 = {};'
assert_void "a pack listing no artifacts at all" "$R" "artifact checksums verified"

R="$(newpacked)"
edit_manifest "$R" 'm.status = "partial";'
assert_void "schema 2 with a status other than complete" "$R" "pack status is complete"

echo "check-review-workspace.sh — the version must constrain the shape, not just be in range"
# Relabelling a schema-2 manifest as 1 while keeping its checksums and invocation used to score
# BETTER than a real legacy pack: the evidence a legacy pack is warned about was present, so
# nothing warned. A version that does not say what the document contains is decoration.
R="$(newpacked)"
edit_manifest "$R" 'm.schema_version = 1;'
assert_void "schema 1 still carrying checksums" "$R" "manifest schema is valid"

R="$(newpacked)"
edit_manifest "$R" 'm.schema_version = 1; delete m.artifact_sha256;'
assert_void "schema 1 still carrying invocation" "$R" "manifest schema is valid"

R="$(newpacked)"
edit_manifest "$R" 'm.schema_version = 2; m.status = "complete"; delete m.artifact_sha256;'
assert_void "schema 2 complete with no checksum map at all" "$R" "manifest schema is valid"

echo "check-review-workspace.sh — a repeated artifact does not inflate the count"
# The count is pasted into findings as proof of how much was verified, so overstating it is the
# wrong kind of wrong: 8/8 over seven distinct files reads as more evidence than exists.
R="$(newpacked)"
edit_manifest "$R" 'm.artifacts.push(m.artifacts[0]);'
assert_void "the same artifact listed twice" "$R" "manifest schema is valid"

echo "check-review-workspace.sh — post must be bound to pre, not merely run after it"
# The two phases each described the moment they ran, so a review whose HEAD and packet were
# BOTH replaced mid-read got RESULT: OK twice. That happened for real. The token is what makes
# the post phase able to say anything about the pre phase at all.

# A fixture step that can fail quietly turns its own test green. Three rounds of review found
# the same shape three times: a pack rebuild swallowed by `>/dev/null 2>&1`; then the commit
# that moves HEAD, unchecked; then a case that accepted ANY void when the state it needed had
# not been reached. The rule the helpers follow: assert the STATE the case depends on, never
# just the exit status of the step meant to produce it.

# repack <repo> — rebuild the pack, and FAIL LOUDLY unless it produced a DIFFERENT pack.
# Exit status alone was not enough: a build can succeed and still leave the manifest identical,
# and every case here depends on the manifest having moved.
repack() {
  local d="$1" out before after
  before="$( cd "$d" && sha256 .review/manifest.json )"
  if ! out="$( cd "$d" && bash "$PACK_SCRIPT" --base main 2>&1 )"; then
    bad "fixture: rebuilding the pack failed — $(tail -1 <<<"$out")"
    return 1
  fi
  after="$( cd "$d" && sha256 .review/manifest.json )"
  if [[ "$before" == "$after" ]]; then
    bad "fixture: the rebuilt pack is identical (manifest still ${after:0:12})"
    return 1
  fi
}

# advance_head <repo> — make a new commit, and FAIL LOUDLY if HEAD did not actually move.
# Checking the exit status is not enough on its own: what the case downstream depends on is the
# state, so that is what gets asserted.
advance_head() {
  local d="$1" before after out
  before="$( cd "$d" && git rev-parse HEAD )"
  if ! out="$( cd "$d" && printf 'export const b = 2\n' > parking-system/b.ts \
      && git add -A && git commit -qm "another slice" 2>&1 )"; then
    bad "fixture: committing a new HEAD failed — $(tail -1 <<<"$out")"
    return 1
  fi
  after="$( cd "$d" && git rev-parse HEAD )"
  if [[ "$before" == "$after" ]]; then
    bad "fixture: HEAD did not move (still ${after:0:12})"
    return 1
  fi
}

# sha256 <file> — same command preference as the production scripts. Hard-coding `shasum` here
# would fail on a machine that only ships GNU coreutils, i.e. the test would break where the
# code works.
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | awk '{print $1}'; }

# binding_void <out> <rc> — exit 1 AND the snapshot line is the thing that voided.
#
# The cases below are all named after one rule, and this script has now been caught twice
# accepting a void that came from somewhere else: once where a skipped repack let the stale
# manifest check do the voiding, once where a dead token voided a workspace that was dirty
# anyway. `assert_void` above has always attributed its verdict to a named line; these
# hand-written cases did not, so the rule lives in a helper here too rather than in whether I
# remembered to add a grep.
binding_void() {
  [[ "$2" -eq 1 ]] && grep -qE 'snapshot identical to --phase pre .*VOID' <<<"$1"
}

R="$(newpacked)"
PRE="$(run_check "$R" --phase pre)"
TOKEN="$(awk '/SNAPSHOT token/ { print $NF }' <<<"$PRE")"

# Assert the token's COMPOSITION, not just that a token appeared. "Non-empty" left the manifest
# half untested: a mutation reducing the token to <head12> alone kept the whole suite green,
# which meant the rule catching a same-HEAD packet rebuild was not pinned by anything.
EXPECTED_TOKEN="$( ( cd "$R" && printf '%s:%s' \
  "$(git rev-parse HEAD | cut -c1-12)" "$(sha256 .review/manifest.json)" ) )"
if [[ "$TOKEN" == "$EXPECTED_TOKEN" ]]; then
  ok "pre prints <head12>:<manifest_sha256> as the token"
else bad "pre prints <head12>:<manifest_sha256> as the token (got '$TOKEN', want '$EXPECTED_TOKEN')"; fi

OUT="$(run_check "$R" --phase post --expect "$TOKEN")"; RC=$?
if [[ $RC -eq 0 ]] && grep -q 'snapshot identical to --phase pre .*PASS' <<<"$OUT"; then
  ok "post with the matching token passes"; else bad "post with the matching token passes ($(tail -1 <<<"$OUT"))"; fi

# The comparison must cover the WHOLE token. A mutant comparing only the part after the colon
# passed every other case here, because none of them pairs a CORRECT manifest half with a wrong
# prefix. It has to sit here, before anything rebuilds the pack: further down the manifest half
# of $TOKEN is stale, so such a case would VOID on that instead — which is how the first draft
# of it passed under the very mutation it was written to catch.
#
# What it pins is the CONTRACT — the string the reviewer pastes back is compared entire — not a
# state a workspace can reach on its own: a real HEAD/manifest divergence trips
# `HEAD == manifest head_sha` first. See the note beside SNAPSHOT_TOKEN in the checker.
OUT="$(run_check "$R" --phase post --expect "0123456789ab:${TOKEN#*:}")"; RC=$?
if binding_void "$OUT" "$RC"; then
  ok "post VOIDs on a wrong HEAD half even when the manifest half is right"
else bad "post VOIDs on a wrong HEAD half even when the manifest half is right (rc=$RC: $(tail -1 <<<"$OUT"))"; fi

# The HEAD stays exactly where it was; only the evidence around it is rebuilt. This is the case
# the manifest half of the token exists for, and the one a HEAD-only token cannot see.
# The narrative must satisfy the heading gate, or the build fails and the OLD pack stays put.
( cd "$R" && printf '## slice\n\na second packet over the same commit\n' > .review-narrative.md )
repack "$R"
SAME_HEAD="$( ( cd "$R" && git rev-parse HEAD ) )"
OUT="$(run_check "$R" --phase post --expect "$TOKEN")"; RC=$?
if binding_void "$OUT" "$RC" && [[ "${SAME_HEAD:0:12}" == "${TOKEN%%:*}" ]]; then
  ok "post VOIDs when the packet was rebuilt over the same HEAD"
else bad "post VOIDs when the packet was rebuilt over the same HEAD (rc=$RC: $(tail -1 <<<"$OUT"))"; fi

# Replace HEAD *and* the whole packet, exactly as a concurrent implementer session would. This
# is the scenario the whole slice exists for: it used to produce RESULT: OK in both phases.
#
# Accepting any VOID here is not enough, and review caught that. Skip the repack and the
# workspace is left with a new HEAD against an old manifest, which `HEAD == manifest head_sha`
# voids on its own — the case would stay green having never exercised the binding at all.
# So the assertion is: the packet DID follow HEAD (that integrity check must PASS), and the
# only thing left objecting is the token. That is what isolates pre/post binding from the
# checks that were already there.
advance_head "$R"
repack "$R"
MOVED_HEAD="$( ( cd "$R" && git rev-parse HEAD ) )"
OUT="$(run_check "$R" --phase post --expect "$TOKEN")"; RC=$?
if binding_void "$OUT" "$RC" && [[ "${MOVED_HEAD:0:12}" != "${TOKEN%%:*}" ]] \
   && grep -q 'HEAD == manifest head_sha .*PASS' <<<"$OUT"; then
  ok "post VOIDs when HEAD and packet were both replaced mid-review"
else bad "post VOIDs when HEAD and packet were both replaced mid-review (rc=$RC: $(tail -1 <<<"$OUT"))"; fi

# A post phase carrying nothing forward from pre proves nothing, so it must not exit 0. It used
# to WARN; the closing line of a WARN run tells the reader the review may proceed, which is the
# opposite instruction. The token cannot be recovered afterwards either.
OUT="$(run_check "$R" --phase post)"; RC=$?
if binding_void "$OUT" "$RC" && ! grep -q 'review may proceed' <<<"$OUT"; then
  ok "post without a token is VOID, and never says the review may proceed"
else bad "post without a token is VOID, and never says the review may proceed (rc=$RC: $(tail -1 <<<"$OUT"))"; fi

# ...but pre still needs no token: it is the phase that mints one.
OUT="$(run_check "$R" --phase pre)"; RC=$?
if [[ $RC -eq 0 ]] && ! grep -q 'snapshot identical to --phase pre' <<<"$OUT"; then
  ok "pre without a token is unaffected"; else bad "pre without a token is unaffected (rc=$RC)"; fi

# A token matching nothing must void BECAUSE of the binding. Asserting only exit 1 let this
# case pass on any unrelated failure — review demonstrated it with a token that actually matched
# plus a dirty tree, and the case stayed green while testing the opposite of its name.
OUT="$(run_check "$R" --phase post --expect "deadbeefdead:$(printf '0%.0s' {1..64})")"; RC=$?
if binding_void "$OUT" "$RC"; then ok "a token that matches nothing is VOID"
else bad "a token that matches nothing is VOID (rc=$RC: $(tail -1 <<<"$OUT"))"; fi

echo "check-review-workspace.sh — argument handling"
R="$(newpacked)"
OUT="$(run_check "$R" --phase sideways)"; RC=$?
if [[ $RC -eq 2 ]]; then ok "an unknown phase exits 2"; else bad "an unknown phase exits 2 (got $RC)"; fi
OUT="$(run_check "$R" --nope)"; RC=$?
if [[ $RC -eq 2 ]]; then ok "an unknown argument exits 2"; else bad "an unknown argument exits 2 (got $RC)"; fi

echo
echo "PASS $PASS   FAIL $FAIL"
[[ $FAIL -eq 0 ]]
