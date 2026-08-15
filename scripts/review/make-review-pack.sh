#!/usr/bin/env bash
#
# Build a review pack: the evidence bundle an independent reviewer reads INSTEAD of
# re-deriving everything from GitHub.
#
#   scripts/review/make-review-pack.sh [--base <ref>] [--narrative <file>]
#                                      [--allow-pattern-file-change]
#
# The point is not convenience, it is trust. A reviewer who only reads the implementer's
# summary is reviewing a claim, not a change. So this script separates the two:
#
#   EVIDENCE  — machine-produced, the implementer cannot curate it:
#               DIFF.patch, FILES.txt, COMMITS.txt, STATUS.txt, logs/*.log, manifest.json
#   NARRATIVE — the implementer's account, written BEFORE this runs and handed in via
#               --narrative (default: .review-narrative.md). It is embedded into REVIEW.md
#               and hashed with everything else, which is why it cannot be written after:
#               editing REVIEW.md breaks its own checksum and voids the pack. With no
#               narrative, REVIEW.md carries .github/PULL_REQUEST_TEMPLATE.md as a blank
#               form and says so — a blank form is not an account of the change.
#               A narrative must CONTAIN every `## ` section heading the template asks for, or
#               this refuses to build, so prose cannot silently drop the A/B/R section. It
#               checks that the heading is there, NOT that anything under it answers the
#               question — nothing here can judge that. See WHAT THIS GATE IS FOR, below.
#
# Read the evidence first, then the narrative. Never the other way round.
#
# Five properties this script exists to guarantee:
#
#   1. WHAT WAS VERIFIED IS WHAT IS PACKED. Every artifact is derived from one snapshot
#      (MERGE_BASE_SHA..HEAD_SHA), resolved once at the start and then used as a literal.
#      The tracked working tree must equal HEAD before, and HEAD must be unmoved after —
#      this repo is shared by concurrent sessions, so that is not a theoretical race.
#   2. A FAILED RUN NEVER LOOKS FINISHED. The pack is built in a temp dir and only replaces
#      .review/ after everything passed. On any failure the evidence is renamed to
#      .review-FAILED-* instead, and an existing .review/ is left untouched.
#      This is NOT an atomic rename, and it cannot be: rename(2) refuses to replace a
#      non-empty directory, so swapping a directory is necessarily more than one step. What
#      the publish step does guarantee is that a COMPLETE pack is on disk at every instant —
#      the previous pack is moved aside rather than deleted, and is dropped only once the new
#      one is in place. An interrupt leaves .review/ or .review.prev.*, never neither.
#   3. REAL EXIT CODES. `npm run verify` is redirected to a log, never piped into tee —
#      a pipeline can report tee's 0 while the command failed. Its status is captured
#      explicitly and recorded in the manifest.
#   4. NOTHING LEAKS. See the scan section below.
#   5. THE PACK CAN BE CHECKED AFTER THE FACT. manifest.json carries a sha256 for every artifact
#      and records the flags the run was given, so a reviewer can show that the DIFF.patch in
#      front of them is the one that was verified, and can see when part of the scan was waived
#      by --allow-pattern-file-change. Naming the artifacts proved only that files with those
#      names existed. scripts/review/check-review-workspace.sh is what reads this.
#
# Verification runs against a `git archive HEAD` export in a scratch directory, not against
# your working tree: same clean-tree guarantee the CI runner gives, and it does not blow
# away your node_modules with `npm ci`.
#
# ON THE SECRET SCAN, HONESTLY: the real control is constructive — the pack contains only
# files this script generates. There is no `cp -r`, no `find`, so nothing can be swept in
# by accident, and git plumbing only ever sees tracked content (never node_modules, never
# a nested worktree). The regex scan in scripts/review/deny-patterns.txt is a second net
# for KNOWN SHAPES on top of that. It cannot recognise a real member's name. Do not read a
# passing scan as proof the pack is clean of PII.
#
# THE ONE EXCEPTION, NAMED: the narrative. It is arbitrary file content chosen by the
# implementer, so the constructive argument above does not cover it — for that input the
# regex net is the only net, which is a weaker guarantee than the rest of the pack enjoys.
# It is therefore constrained on three axes: the path must resolve inside the repository,
# the bytes are read once and scanned with the same deny patterns as the diff, and what is
# published is that same snapshot. (Found in review: an outside-the-repo narrative carrying
# a phone number produced a clean pack.)
#
# Failure messages never echo a matched line — they name the pattern and the count. Same
# rule the backup scripts follow for connection strings.

set -euo pipefail

PROG="$(basename "$0")"
BASE_REF="main"
ALLOW_PATTERN_FILE_CHANGE=0
NARRATIVE=""
DEFAULT_NARRATIVE=".review-narrative.md"

# Captured before parsing, because the manifest has to say how the pack was asked for. A pack
# built with --allow-pattern-file-change had part of its secret scan waived, and until this was
# recorded the reviewer had no way to know that from the evidence.
ORIG_ARGV=("$@")

# One list, used for both the manifest's `artifacts` and its checksums, so the two cannot drift.
ARTIFACTS=(DIFF.patch FILES.txt COMMITS.txt STATUS.txt REVIEW.md logs/npm-ci.log logs/verify.log)

usage() {
  cat <<EOF
usage: $PROG [--base <ref>] [--narrative <file>] [--allow-pattern-file-change]

  --base <ref>                  what to diff against (default: main). Use the parent slice's
                                branch when this branch is stacked on an unmerged slice —
                                otherwise that slice's commits land in your diff.
  --narrative <file>            markdown to embed in REVIEW.md as the implementer's account.
                                Defaults to $DEFAULT_NARRATIVE when that file exists.
                                Write it BEFORE building the pack: REVIEW.md is checksummed,
                                so editing it afterwards voids the pack.
  --allow-pattern-file-change   permit scripts/review/deny-patterns.txt to appear in the
                                diff. Editing it necessarily trips the scanner against
                                itself; this flag says you meant to.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base)
      BASE_REF="${2:-}"
      [[ -n "$BASE_REF" ]] || { echo "$PROG: --base needs a ref" >&2; exit 2; }
      shift 2 ;;
    --narrative)
      NARRATIVE="${2:-}"
      [[ -n "$NARRATIVE" ]] || { echo "$PROG: --narrative needs a file" >&2; exit 2; }
      shift 2 ;;
    --allow-pattern-file-change) ALLOW_PATTERN_FILE_CHANGE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    # Says WHICH argument, never WHAT it was. The parser necessarily runs before the
    # invocation scan — that scan needs the repo root and the pattern file, neither of which
    # is resolved yet — so at this point the arguments are still entirely unvetted, and
    # echoing one back is the same leak the scan exists to prevent, just earlier.
    *)
      echo "$PROG: unknown argument #$(( ${#ORIG_ARGV[@]} - $# + 1 )) (not echoed: arguments are unvetted until the secret scan runs)" >&2
      usage >&2
      exit 2 ;;
  esac
done

# ── failure handling ────────────────────────────────────────────────────────────
# STAGE is what the manifest records when something blows up; FAIL_MSG is why.
STAGE="startup"
FAIL_MSG=""
INVOCATION_SCANNED=0   # see write_manifest: argv is redacted until this flips
PACK=""          # temp pack dir; emptied once published so the trap leaves it alone
EXPORT_DIR=""    # scratch export used for verification
NARRATIVE_SNAPSHOT=""   # private copy of the narrative, taken from the validated descriptor
OUT=".review"

fail() { FAIL_MSG="$*"; echo "$PROG: FAILED [$STAGE] — $*" >&2; exit 1; }

on_exit() {
  local rc=$?
  if [[ $rc -ne 0 && -n "$PACK" && -d "$PACK" ]]; then
    write_manifest failed 2>/dev/null || true
    local short stamp dest
    short="$(printf '%s' "${HEAD_SHA:-unknown}" | cut -c1-7)"
    stamp="$(date -u +%Y%m%dT%H%M%SZ)"
    dest=".review-FAILED-$short-$stamp"
    rm -rf "$dest"
    if mv "$PACK" "$dest" 2>/dev/null; then
      echo "$PROG: evidence kept in $dest/ — this is NOT a review pack, do not send it as one" >&2
      PACK=""
    fi
  fi
  [[ -n "$PACK" && -d "$PACK" ]] && rm -rf "$PACK"
  [[ -n "$EXPORT_DIR" && -d "$EXPORT_DIR" ]] && rm -rf "$EXPORT_DIR"
  [[ -n "$NARRATIVE_SNAPSHOT" && -f "$NARRATIVE_SNAPSHOT" ]] && rm -f "$NARRATIVE_SNAPSHOT"
  # Preserve the real status. A cleanup trap that returns its own exit code is exactly how
  # this repo previously shipped a script that reported success after a fatal error
  # (see .github/workflows/backup-ci.yml).
  exit $rc
}
trap on_exit EXIT

# Newlines are the ones that matter here, not an edge case: the secret-scan failure reason is
# built as a MULTI-LINE list (one line per matching pattern) and is embedded verbatim in the
# FAILED manifest's `failed_reason`. A line-oriented `sed` never sees those newlines, so the
# manifest for the most safety-relevant failure path was the one that came out unparseable.
# Done with parameter expansion rather than a pipeline so the substitution is not itself
# line-oriented.
#
# Escaping is total, not "the characters we expect". An earlier version stopped at the five
# with short forms and justified it by claiming nothing else could reach the function — untrue:
# NODE_V, NPM_V and `uname -sr` are external command output, and BASE_REF is whatever came in
# on --base. JSON requires every character below U+0020 to be escaped, so the ones without a
# short form go out as \u00XX. (U+0000 is unreachable: a bash string cannot hold a NUL.)
json_escape() {
  local s="${1:-}"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\b'/\\b}"
  s="${s//$'\f'/\\f}"
  s="${s//$'\t'/\\t}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\n'/\\n}"
  # The glob keeps the per-character loop off the normal path: it runs only for a string that
  # still holds a control character after the five short forms above.
  if [[ "$s" == *[[:cntrl:]]* ]]; then
    local out="" i c
    for (( i = 0; i < ${#s}; i++ )); do
      c="${s:i:1}"
      if [[ "$c" == [[:cntrl:]] ]]; then printf -v c '\\u%04x' "'$c"; fi
      out+="$c"
    done
    s="$out"
  fi
  printf '%s' "$s"
}

# Same fallback order as scripts/backup/db-backup.sh: coreutils first, macOS second.
sha256_of() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

write_manifest() {
  local status="${1:-failed}" extra="" argv_json="" artifacts_json="" hashes="" a sep

  # Redacted until the invocation has been through the deny scan, because this manifest is
  # written by the EXIT trap too: a run rejected for a secret in its arguments would otherwise
  # copy that value into the .review-FAILED-* directory it leaves behind, and that directory is
  # kept deliberately. Refusing to build is not containment if the rejected value ships anyway.
  # `allow_pattern_file_change` below is a separate field, so the waiver record survives this.
  sep=""
  if [[ $INVOCATION_SCANNED -eq 1 ]]; then
    for a in ${ORIG_ARGV[@]+"${ORIG_ARGV[@]}"}; do
      argv_json="$argv_json$sep\"$(json_escape "$a")\""
      sep=", "
    done
  else
    argv_json="\"<redacted — the invocation had not passed the secret scan when this was written>\""
  fi

  sep=""
  for a in "${ARTIFACTS[@]}"; do
    artifacts_json="$artifacts_json$sep\"$a\""
    sep=", "
  done

  # Checksums only on a complete pack. A failed run may have written half of an artifact, and a
  # checksum over half a file is worse than none: it looks like verification and certifies the
  # truncation. The `artifacts` list stays either way — it names what a pack should contain.
  if [[ "$status" == "complete" ]]; then
    sep=""
    for a in "${ARTIFACTS[@]}"; do
      hashes="$hashes$sep
    \"$a\": \"$(sha256_of "$PACK/$a")\""
      sep=","
    done
    hashes=",
  \"artifact_sha256\": {$hashes
  }"
  fi

  if [[ "$status" != "complete" ]]; then
    # Leading newline lives in the value, so a complete manifest has no blank line here.
    extra="
  \"failed_stage\": \"$(json_escape "$STAGE")\",
  \"failed_reason\": \"$(json_escape "$FAIL_MSG")\","
  fi
  cat > "$PACK/manifest.json" <<EOF
{
  "schema_version": 2,
  "status": "$status",$extra
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "invocation": {
    "argv": [$argv_json],
    "allow_pattern_file_change": $([[ $ALLOW_PATTERN_FILE_CHANGE -eq 1 ]] && echo true || echo false),
    "narrative": $([[ -n "$NARRATIVE" && $INVOCATION_SCANNED -eq 1 ]] && echo "\"$(json_escape "$NARRATIVE")\"" || echo null)
  },
  "repo": {
    "branch": "$(json_escape "${BRANCH:-}")",
    "base_ref": "$(json_escape "$BASE_REF")",
    "base_sha": "${BASE_SHA:-}",
    "head_sha": "${HEAD_SHA:-}",
    "merge_base_sha": "${MERGE_BASE_SHA:-}"
  },
  "tree": { "tracked_clean": ${TRACKED_CLEAN:-false} },
  "toolchain": {
    "node": "$(json_escape "${NODE_V:-}")",
    "npm": "$(json_escape "${NPM_V:-}")",
    "uname": "$(json_escape "$(uname -sr)")"
  },
  "verify": {
    "method": "git archive HEAD -> npm ci -> npm run verify (clean export, no app env)",
    "install_cmd": "npm ci",
    "install_exit": ${INSTALL_EXIT:-null},
    "install_log": "logs/npm-ci.log",
    "verify_cmd": "npm run verify",
    "verify_exit": ${VERIFY_EXIT:-null},
    "verify_log": "logs/verify.log"
  },
  "artifacts": [$artifacts_json]$hashes
}
EOF
}

# ── preflight ───────────────────────────────────────────────────────────────────
STAGE="preflight"
git rev-parse --git-dir >/dev/null 2>&1 || fail "not inside a git repository"
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

APP_DIR="parking-system"
TEMPLATE=".github/PULL_REQUEST_TEMPLATE.md"
PATTERN_FILE="scripts/review/deny-patterns.txt"

[[ -f "$APP_DIR/package.json" ]] || fail "$APP_DIR/package.json not found"
grep -q '"verify"' "$APP_DIR/package.json" \
  || fail "$APP_DIR has no \`verify\` script — the canonical verification command must exist first"
[[ -f "$TEMPLATE" ]]     || fail "$TEMPLATE not found — REVIEW.md is seeded from it, there is no second copy"
[[ -f "$PATTERN_FILE" ]] || fail "$PATTERN_FILE not found"

# ── the invocation is untrusted input, and it is vetted FIRST ───────────────────
# `invocation.argv` and `invocation.narrative` go into manifest.json, and the narrative path
# is printed in REVIEW.md's evidence header, so a file called `notes-<a phone number>.md`
# puts that number into a published pack without ever appearing in a scanned line. The script
# already knew filenames are user content — the changed-path scan further down exists for
# exactly that reason; this input was simply added later and did not inherit the rule.
#
# It runs HERE, before any narrative check, because those checks interpolate the path into
# their failure messages: validating first would print the very value being kept out. Nothing
# above this point has echoed the arguments, and write_manifest redacts them until the flag
# below is set, so a rejected invocation cannot reach stderr or the retained failed pack.
INVOCATION_HITS=""
INVOCATION_TEXT="$(
  printf '%s\n' ${ORIG_ARGV[@]+"${ORIG_ARGV[@]}"}
  [[ -n "$NARRATIVE" ]] && printf '%s\n' "$NARRATIVE"
  [[ -f "$DEFAULT_NARRATIVE" ]] && printf '%s\n' "$DEFAULT_NARRATIVE"
  true
)"
while IFS= read -r pat; do
  case "$pat" in ''|'#'*) continue ;; esac
  n="$(grep -c -E -- "$pat" <<<"$INVOCATION_TEXT" || true)"
  [[ "${n:-0}" -eq 0 ]] || INVOCATION_HITS="$INVOCATION_HITS
  $n argument(s) match: $pat"
done < "$PATTERN_FILE"
# Names the pattern and the count only. The argument itself is the thing being contained.
[[ -z "$INVOCATION_HITS" ]] \
  || fail "secret/PII scan rejected this run's invocation (arguments are recorded in the manifest):$INVOCATION_HITS"
INVOCATION_SCANNED=1

# ── narrative ───────────────────────────────────────────────────────────────────
# REVIEW.md carries the implementer's account, and it is checksummed like every other
# artifact. Those two facts used to be in direct conflict: the file was published as a blank
# copy of the PR template, so filling it in — the one thing it exists for — invalidated its
# own hash and the workspace check voided the review. The narrative therefore has to be
# written BEFORE the pack is built, and handed in here, so the hash covers the final text.
#
# An explicit --narrative that does not exist is a hard failure, never a silent fallback to
# the empty template: "I wrote the narrative and the reviewer got a blank form" is exactly
# the outcome this must not produce.
if [[ -n "$NARRATIVE" ]]; then
  [[ -f "$NARRATIVE" ]] || fail "--narrative file not found: $NARRATIVE"
elif [[ -f "$DEFAULT_NARRATIVE" ]]; then
  NARRATIVE="$DEFAULT_NARRATIVE"
fi

# `## ` headings that are actually headings: a fenced block is a picture of markdown, not
# markdown. Without this, a document with no visible sections at all satisfies the gate by
# quoting the template inside a code fence — worse than no gate, because it reads as one.
#
# The fence rules follow markdown rather than approximating it, because the approximation was
# itself the bypass (found in review): one boolean toggled by "any ``` or ~~~ line" is closed
# by a tilde line inside a backtick fence, and by a three-backtick line inside a four-backtick
# fence. In both documents the headings are still fenced to every markdown renderer, and the
# gate passed anyway. So: a fence opens on a run of 3+ ` or ~, and closes only on the SAME
# character with a run at least as long as the opener.
#
# What counts as "hidden" is markdown's answer, not this script's: a fence marker is a fence
# marker only with 0–3 spaces of indentation (four columns is code content, and a tab is four
# columns), and a fence is not the only container. Four rounds of review found a variant each
# time — `~~~` closing a backtick fence, a shorter closer, a closer with trailing text, a
# four-space closer, and `## X` sitting inside an HTML comment, which renders as nothing at all.
#
# CommonMark §4.6 defines SEVEN kinds of HTML block, each with its own end condition, and all
# seven are handled below. An earlier version of this comment claimed that whatever was not
# modelled would fail CLOSED; that claim was false and is the reason it is now spelled out —
# types 3/4/5 (`<?`, `<!DECLARATION`, `<![CDATA[`) were not recognised at all, so a heading
# inside one was counted as a real heading. Unrecognised markup fails OPEN here by nature: a
# line this does not understand is treated as ordinary text, and a `## ` line after it counts.
#
# THE HONEST LIMIT: this is a bounded model of CommonMark, not a parser, and it never becomes
# one — see WHAT THIS GATE IS FOR, above the caller, for why that is the right trade and not
# an excuse.
extract_headings() {
  # CommonMark §4.6 type 6 recognises only these tag names. Spelled out rather than
  # approximated by "looks like a tag", because that approximation swallowed ordinary prose:
  # `<span>note</span>` and even the autolink `<https://example.com>` started a block that ran
  # to the next blank line, and the headings after them stopped counting. An author could not
  # submit a legitimate narrative — a far worse failure than the bypasses this began with.
  awk -v BLOCK_TAGS='address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul' '
    BEGIN { blank_before = 1 }   # start of document counts as "preceded by a blank line"
    {
      line = $0
      lower = tolower(line)
      is_blank = (line ~ /^[[:space:]]*$/)
      raw_end = "</(script|pre|style|textarea)>"   # literal, per spec: "</script   >" is not it

      if (fence) {
        if (match(line, /^ {0,3}(`{3,}|~{3,})/)) {
          marker = substr(line, RSTART, RLENGTH); sub(/^ */, "", marker)
          rest = substr(line, RSTART + RLENGTH)
          # Same character, run at least as long as the opener, nothing but whitespace after.
          if (substr(marker, 1, 1) == fence_ch && length(marker) >= fence_len && rest ~ /^[ \t]*$/) fence = 0
        }
      }
      else if (comment) { if (line ~ /-->/)     comment = 0 }          # type 2
      else if (pi)      { if (line ~ /\?>/)     pi      = 0 }          # type 3
      else if (decl)    { if (line ~ />/)       decl    = 0 }          # type 4
      else if (cdata)   { if (line ~ /\]\]>/)   cdata   = 0 }          # type 5
      # Type 1 ends on ANY of the four end tags, not the one that opened it.
      else if (raw)     { if (lower ~ raw_end)  raw     = 0 }          # type 1
      else if (html)    { if (is_blank)         html    = 0 }          # types 6 and 7

      else if (match(line, /^ {0,3}(`{3,}|~{3,})/)) {
        marker = substr(line, RSTART, RLENGTH); sub(/^ */, "", marker)
        # An opening fence MAY carry an info string (```bash); a closing one may not.
        fence = 1; fence_ch = substr(marker, 1, 1); fence_len = length(marker)
      }
      # Types 1-5 may open and close on the same line, in which case nothing after is hidden.
      else if (line ~ /^ {0,3}<!--/)        { if (line !~ /-->/)    comment = 1 }
      else if (line ~ /^ {0,3}<\?/)         { if (line !~ /\?>/)    pi      = 1 }
      else if (line ~ /^ {0,3}<!\[CDATA\[/) { if (line !~ /\]\]>/)  cdata   = 1 }
      else if (line ~ /^ {0,3}<![A-Za-z]/)  { if (line !~ />/)      decl    = 1 }
      # Type 1 opener: the tag may be followed by whitespace, ">", or the end of the line.
      else if (lower ~ /^ {0,3}<(script|pre|style|textarea)([ \t>]|$)/) {
        if (lower !~ raw_end) raw = 1
      }
      # Type 6: only the listed block tags, followed by whitespace, ">", "/>" or end of line.
      else if (lower ~ "^ {0,3}</?(" BLOCK_TAGS ")([ \t>]|/>|$)") { html = 1 }
      # Type 7: ONE complete open or closing tag, alone on its line, and it may not interrupt
      # a paragraph — so it only starts a block after a blank line. Without that restriction
      # this rule eats inline HTML that happens to sit at the start of a line.
      else if (blank_before && \
               (line ~ /^ {0,3}<[A-Za-z][A-Za-z0-9-]*([ \t][^>]*)?\/?>[ \t]*$/ || \
                line ~ /^ {0,3}<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>[ \t]*$/)) { html = 1 }
      # ── an actual level-two heading ─────────────────────────────────────────────
      else if (line ~ /^## /) { h = line; sub(/[[:space:]]+$/, "", h); print h }

      blank_before = is_blank
    }
  '
}

# The narrative is read ONCE, here, into a snapshot. Everything downstream — the heading
# gate, the secret scan, the text embedded into REVIEW.md — works on that snapshot.
# "Snapshot" is normalised text, not a byte image: command substitution strips trailing
# newlines and one is added back on the way out. That is stated rather than glossed, because
# all three checks consume the SAME normalised text — which is the property that matters —
# and claiming byte-exactness the implementation does not deliver is the failure mode this
# whole line of work exists to prevent.
# Reading the file again at embed time would mean validating one document and publishing
# another: `npm ci` and `npm run verify` sit between the two, which is minutes, and the
# default narrative is gitignored so the final tracked-tree check cannot see it change.
NARRATIVE_TEXT=""
if [[ -n "$NARRATIVE" ]]; then
  [[ -r "$NARRATIVE" ]] || fail "--narrative file is not readable: $NARRATIVE"

  # The path is interpolated into an HTML comment and a Markdown table row in REVIEW.md, so
  # its characters are structure, not just text: a filename carrying a newline and `-->`
  # closes the machine-generated comment and writes arbitrary lines into the evidence header —
  # the part of the pack a reviewer is meant to be able to trust without reading this script.
  # Restricting the charset rather than escaping at each emit site is deliberate: escaping has
  # to be correct in every place the value is printed, and the next person to print it will
  # not know that. This way the invariant is true of the value itself.
  case "$NARRATIVE" in
    *[!A-Za-z0-9._/\ -]*)
      fail "narrative path may only contain letters, digits, space, and . _ - / — it is embedded in REVIEW.md, where other characters are structure" ;;
  esac

  # A symlink is refused outright rather than resolved. `pwd -P` canonicalises the directory
  # components, so a symlinked parent is already handled — but the FINAL component was left
  # unresolved, and an in-repo `notes.md -> /somewhere/else` therefore passed the boundary
  # while reading bytes from outside it (found in review). Refusing is preferred over
  # following: "the narrative is a file in this checkout" is a rule someone can hold in their
  # head, whereas "it is followed to wherever it points, then re-checked" is one more thing
  # that has to be right every time.
  # EVERY component, not just the last one. Checking only the file left the directories above
  # it free to change: a review fixture replaced the narrative's parent directory with a symlink
  # to an outside directory after the boundary check had passed, and every stat and open after
  # that resolved through the new parent — so the "before" and "after" identities agreed with
  # each other and both described the outside file. Walking the components is what makes the
  # before/after pair mean something.
  narrative_symlink_component() {
    local rel="${1#./}" acc=""
    local IFS=/
    for part in $rel; do
      [[ -n "$part" ]] || continue
      acc="${acc:+$acc/}$part"
      [[ -L "$acc" ]] && { printf '%s' "$acc"; return 0; }
    done
    return 1
  }
  LINKED="$(narrative_symlink_component "$NARRATIVE" || true)"
  [[ -z "$LINKED" ]] \
    || fail "narrative path passes through a symlink ($LINKED) — point --narrative at a real file inside the repository"

  # Inside the repository, resolved on both sides (/var vs /private/var on macOS would
  # otherwise make an in-repo path look external). The scan below is the real control; this
  # keeps the blast radius of a mistyped path from reaching outside the checkout at all.
  REPO_ROOT_P="$(cd "$REPO_ROOT" && pwd -P)"
  NARRATIVE_DIR_P="$(cd "$(dirname "$NARRATIVE")" && pwd -P)"
  NARRATIVE_ABS="$NARRATIVE_DIR_P/$(basename "$NARRATIVE")"
  case "$NARRATIVE_ABS" in
    "$REPO_ROOT_P"/*) ;;
    *) fail "narrative must live inside the repository ($REPO_ROOT_P), got: $NARRATIVE_ABS" ;;
  esac

  # ── bind the checks above to the bytes below ────────────────────────────────
  # Every check so far applied to a PATH. The reads that follow used to re-open that path, so
  # nothing tied them to the file the checks passed: a review fixture swapped the file for a
  # symlink between the two and published bytes from outside the repository into a completed
  # pack. Documenting that as a known limit was the wrong answer — the boundary exists exactly
  # because the deny scan cannot recognise an arbitrary real name.
  #
  # So the file is opened ONCE and everything downstream reads the snapshot taken from that
  # descriptor. A later swap cannot change what was already read, and a swap that happened
  # around the open is detected: the descriptor's inode must equal the validated path's, and
  # the path must still be the same non-symlink object afterwards.
  # dev:inode, BSD and GNU stat. The flavour is DETECTED, not tried-in-order: GNU's `-f` is
  # --file-system, so `stat -f '%d:%i' path || stat -c ...` does not fall through on Linux —
  # it prints filesystem status to stdout AND then the fallback, and the caller compares two
  # strings that both contain junk. (Every narrative case went red in CI on that; the macOS
  # run was green, which is exactly the one-platform "all green" this repo keeps relearning.)
  if stat -c '%i' "$REPO_ROOT" >/dev/null 2>&1; then STAT_FLAVOUR=gnu; else STAT_FLAVOUR=bsd; fi
  narrative_stat() {
    if [[ "$STAT_FLAVOUR" == gnu ]]; then stat -c '%d:%i' "$1" 2>/dev/null
    else stat -f '%d:%i' "$1" 2>/dev/null; fi
  }
  NARRATIVE_ID_BEFORE="$(narrative_stat "$NARRATIVE")"
  [[ -n "$NARRATIVE_ID_BEFORE" ]] || fail "cannot stat the narrative file"

  exec 9<"$NARRATIVE" || fail "cannot open the narrative file for reading"

  # Deliberately NOT stat'ing /dev/fd/9 to identify what was opened. That reads differently on
  # each platform — macOS reports the devfs device, and on the CI runner it disagreed with the
  # path in a way this environment cannot reproduce, so every narrative case went red there
  # while macOS was green. A check whose meaning depends on the OS is not a check; the two
  # things below hold everywhere and are what the guarantee actually rests on:
  #
  #   * the CONTENT comes from the descriptor, so a swap after this line changes nothing;
  #   * the PATH is re-identified after the read, so a swap around this line is detected.
  #
  # Residual: a swap-and-restore inside that window goes unnoticed. Saying so, rather than
  # implying otherwise with a check that does not do what its name suggests.

  # Snapshot lives in TMPDIR, never under $PACK: the exit trap preserves $PACK, and unvetted
  # content must not be written where retention happens (the rule from an earlier round).
  NARRATIVE_SNAPSHOT="$(mktemp "${TMPDIR:-/tmp}/review-narrative.XXXXXX")"
  cat <&9 > "$NARRATIVE_SNAPSHOT" || fail "cannot read the narrative file"
  exec 9<&-

  LINKED="$(narrative_symlink_component "$NARRATIVE" || true)"
  [[ -z "$LINKED" && "$(narrative_stat "$NARRATIVE")" == "$NARRATIVE_ID_BEFORE" ]] \
    || fail "the narrative path changed while it was being read — refusing to use it"

  # A NUL means this is not the markdown document it is being treated as; command
  # substitution would silently drop the byte and publish something else again.
  cmp -s <(tr -d '\000' < "$NARRATIVE_SNAPSHOT") "$NARRATIVE_SNAPSHOT" \
    || fail "narrative $NARRATIVE is not text (contains NUL bytes)"

  NARRATIVE_TEXT="$(cat "$NARRATIVE_SNAPSHOT")"
  [[ -n "${NARRATIVE_TEXT//[[:space:]]/}" ]] || fail "narrative $NARRATIVE is empty"

  # WHAT THIS GATE IS FOR — read this before tightening it again.
  #
  # A narrative REPLACES the template in REVIEW.md, so it must still carry every section
  # heading the template asks for; otherwise writing your own prose silently drops the A/B/R
  # deployment-compatibility section. The requirements are read out of the template itself, so there is
  # no second list to keep in sync.
  #
  # It catches OMISSION. It does not, and cannot, resist EVASION. The ceiling is structural,
  # not a gap waiting to be closed: nothing here can tell whether the section is answered.
  # An author who wants to skip A/B/R writes the heading with nothing under it and is through.
  # So "the heading was hidden inside an HTML comment" and "the heading was there and said
  # nothing" have the same effect, and hardening only the first is theatre — it buys the
  # appearance of a control against an adversary who was never stopped.
  #
  # Four review rounds graded this as if it were adversarial, and each round produced another
  # markdown container. The honest end of that road is a real CommonMark parser, which is far
  # more machinery than the thing it guards. The standard is therefore stated rather than
  # escalated: this gate is a typo-and-forgetfulness check, the reviewer reading REVIEW.md is
  # what catches a section that exists but says nothing, and bug reports against it are about
  # ordinary documents, not crafted ones.
  TEMPLATE_HEADINGS="$(extract_headings < "$TEMPLATE")"
  [[ -n "$TEMPLATE_HEADINGS" ]] \
    || fail "$TEMPLATE has no '## ' sections — a template that asks nothing cannot gate a narrative"
  NARRATIVE_HEADINGS="$(printf '%s\n' "$NARRATIVE_TEXT" | extract_headings)"
  MISSING=""
  while IFS= read -r heading; do
    [[ -n "$heading" ]] || continue
    grep -qxF -- "$heading" <<<"$NARRATIVE_HEADINGS" || MISSING="$MISSING
  $heading"
  done <<<"$TEMPLATE_HEADINGS"
  [[ -z "$MISSING" ]] || fail "narrative $NARRATIVE is missing sections the PR template requires:$MISSING"
fi

# Tracked tree must equal HEAD. Untracked and ignored files are deliberately NOT grounds to
# refuse: .review/, node_modules, and a stray scratch file say nothing about whether the
# code under test matches the code being packed.
if ! git diff --quiet || ! git diff --cached --quiet; then
  TRACKED_CLEAN=false
  fail "tracked working tree differs from HEAD — the tree that gets verified would not be the tree that gets packed. Commit or revert first."
fi
TRACKED_CLEAN=true

# ── snapshot ────────────────────────────────────────────────────────────────────
STAGE="snapshot"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
HEAD_SHA="$(git rev-parse HEAD)"
git rev-parse --verify --quiet "$BASE_REF^{commit}" >/dev/null \
  || fail "base ref '$BASE_REF' does not resolve to a commit"
BASE_SHA="$(git rev-parse "$BASE_REF^{commit}")"
MERGE_BASE_SHA="$(git merge-base "$BASE_SHA" "$HEAD_SHA")"
[[ "$MERGE_BASE_SHA" != "$HEAD_SHA" ]] \
  || fail "no commits between $BASE_REF and HEAD — nothing to review"

NODE_V="$(node --version 2>/dev/null || echo unknown)"
NPM_V="$(npm --version 2>/dev/null || echo unknown)"

# Counted before the temp pack dir exists, or the pack counts itself. (In this repo .review*
# is gitignored so it would not show; in a repo without that rule it would — and a number that
# depends on the reader's .gitignore is not evidence.)
UNTRACKED_COUNT="$(git ls-files --others --exclude-standard | wc -l | tr -d ' ')"

PACK="$(mktemp -d "$REPO_ROOT/.review.tmp.XXXXXX")"
mkdir -p "$PACK/logs"

# ── artifacts (all bound to the one snapshot, never to a re-resolved ref) ────────
STAGE="artifacts"
git diff --binary "$MERGE_BASE_SHA" "$HEAD_SHA"      > "$PACK/DIFF.patch"
git diff --name-status "$MERGE_BASE_SHA" "$HEAD_SHA" > "$PACK/FILES.txt"
git log --oneline "$MERGE_BASE_SHA..$HEAD_SHA"       > "$PACK/COMMITS.txt"
{
  echo "branch          $BRANCH"
  echo "base_ref        $BASE_REF"
  echo "base_sha        $BASE_SHA"
  echo "head_sha        $HEAD_SHA"
  echo "merge_base_sha  $MERGE_BASE_SHA"
  echo
  # Deliberately a count, not a listing. The tracked tree is verified equal to HEAD above, so
  # `git status --short` here would contain nothing BUT untracked filenames — and a filename
  # is user content, not something this script generated. That made it the one place where
  # unvetted input entered the pack, and the deny-pattern scan does not cover it (it reads the
  # added lines of DIFF.patch). A stray `王小明名單.csv` in the working directory is exactly
  # the shape of thing this pack must never carry, and no regex would have caught it.
  echo "untracked files: $UNTRACKED_COUNT (names omitted on purpose — see the comment in $PROG)"
} > "$PACK/STATUS.txt"

# ── scan ────────────────────────────────────────────────────────────────────────
# Cheap, so it runs before the slow verification: a pack that must be rejected should be
# rejected in seconds, not after a full build.
STAGE="scan"

CHANGED_PATHS="$(cut -f2- "$PACK/FILES.txt" | tr '\t' '\n' | sed '/^$/d' | sort -u)"

if printf '%s\n' "$CHANGED_PATHS" | grep -qx "$PATTERN_FILE"; then
  [[ $ALLOW_PATTERN_FILE_CHANGE -eq 1 ]] \
    || fail "$PATTERN_FILE is in this diff, which necessarily matches its own patterns. Re-run with --allow-pattern-file-change if you meant to edit it."
fi

while IFS= read -r p; do
  [[ -n "$p" ]] || continue
  case "$p" in
    .env.example|*/.env.example) ;;
    .env|.env.*|*/.env|*/.env.*)   fail "diff touches an env file: $p" ;;
    *.age|*.pgc|*.dump|*.sql.gz)   fail "diff touches a database dump or encrypted artifact: $p" ;;
    age-identity*|*/age-identity*) fail "diff touches an age identity (private key): $p" ;;
    docs/import-templates/*)
      case "$p" in
        *README.md|*範本.csv) ;;
        *) fail "diff touches an untracked-by-policy import file (these hold real member data): $p" ;;
      esac ;;
  esac
done <<EOF
$CHANGED_PATHS
EOF

# Scan ADDED lines only. `+++ b/path` headers are not content.
if [[ $ALLOW_PATTERN_FILE_CHANGE -eq 1 ]]; then
  git diff "$MERGE_BASE_SHA" "$HEAD_SHA" -- . ":(exclude)$PATTERN_FILE" > "$PACK/logs/.scan-diff"
else
  cp "$PACK/DIFF.patch" "$PACK/logs/.scan-diff"
fi
grep '^+' "$PACK/logs/.scan-diff" | grep -v '^+++' > "$PACK/logs/.scan-added" || true

DENY_HITS=""
while IFS= read -r pat; do
  case "$pat" in ''|'#'*) continue ;; esac
  n="$(grep -c -E -- "$pat" "$PACK/logs/.scan-added" || true)"
  [[ "${n:-0}" -eq 0 ]] || DENY_HITS="$DENY_HITS
  $n added line(s) match: $pat"
done < "$PATTERN_FILE"
rm -f "$PACK/logs/.scan-diff" "$PACK/logs/.scan-added"

# Deliberately reports the pattern and the count, never the matched line.
[[ -z "$DENY_HITS" ]] || fail "secret/PII scan rejected this diff:$DENY_HITS"

# The narrative gets the same patterns applied to it. It is the one packet input this script
# does not generate, so the constructive argument above ("nothing can be swept in") does not
# reach it: without this, prose is a clean channel from any file in the checkout into a
# published pack. Scanned from the snapshot, not from disk — the file could differ by now.
if [[ -n "$NARRATIVE" ]]; then
  # Scanned from the shell variable, never written to a file under $PACK. A temp file there
  # was removed on the normal path, but `on_exit` preserves that whole directory as
  # .review-FAILED-* — so any exit while the file existed (an interrupt, a failing `rm`)
  # retained the very body the scan was about to reject. The rule that generalises: unvetted
  # content does not get written where retention happens, rather than being cleaned up after.
  NARRATIVE_HITS=""
  while IFS= read -r pat; do
    case "$pat" in ''|'#'*) continue ;; esac
    n="$(grep -c -E -- "$pat" <<<"$NARRATIVE_TEXT" || true)"
    [[ "${n:-0}" -eq 0 ]] || NARRATIVE_HITS="$NARRATIVE_HITS
  $n line(s) match: $pat"
  done < "$PATTERN_FILE"
  # Names the pattern and the count, and — unlike the diff message — does NOT name the file,
  # because the path is itself suspect content here (see the invocation scan below).
  [[ -z "$NARRATIVE_HITS" ]] || fail "secret/PII scan rejected the narrative:$NARRATIVE_HITS"
fi

# (The invocation scan runs in preflight, before anything can echo the arguments.)

# ── verification (clean export, exactly what CI runs) ───────────────────────────
STAGE="verify"
EXPORT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/review-pack-verify.XXXXXX")"
git archive "$HEAD_SHA" "$APP_DIR" | tar -x -C "$EXPORT_DIR"

# No app env is provided, and that is the point: if verification only passes with secrets
# present, something reads them at import time and that is a finding, not a config gap.
set +e
( cd "$EXPORT_DIR/$APP_DIR" && npm ci ) > "$PACK/logs/npm-ci.log" 2>&1
INSTALL_EXIT=$?
set -e
[[ $INSTALL_EXIT -eq 0 ]] || fail "npm ci failed (exit $INSTALL_EXIT) — see logs/npm-ci.log"

# Redirected, not piped: `cmd | tee log` can report tee's success while cmd failed.
set +e
( cd "$EXPORT_DIR/$APP_DIR" && npm run verify ) > "$PACK/logs/verify.log" 2>&1
VERIFY_EXIT=$?
set -e
[[ $VERIFY_EXIT -eq 0 ]] || fail "npm run verify failed (exit $VERIFY_EXIT) — see logs/verify.log"

# ── REVIEW.md (narrative, seeded from the one canonical template) ───────────────
STAGE="review-md"
{
  echo "<!-- Evidence header generated by scripts/review/make-review-pack.sh."
  if [[ -n "$NARRATIVE" ]]; then
    echo "     Everything below the rule is $NARRATIVE as read at validation time, with"
    echo "     trailing newlines normalised to one. Same snapshot that was scanned and checked."
    echo "     REVIEW.md is checksummed — edit the narrative source and rebuild, never this file. -->"
  else
    echo "     Everything below the rule is a verbatim copy of $TEMPLATE"
    echo "     with links rewritten for this directory. Do not maintain a second template."
    echo "     No narrative was supplied: this is a BLANK FORM, not an account of the change."
    echo "     Write one and pass --narrative <file>; editing this file voids the pack. -->"
  fi
  echo
  echo "# Review pack — \`$BRANCH\`"
  echo
  echo "| | |"
  echo "|---|---|"
  echo "| base_ref | \`$BASE_REF\` |"
  echo "| base_sha | \`$BASE_SHA\` |"
  echo "| head_sha | \`$HEAD_SHA\` |"
  echo "| merge_base_sha | \`$MERGE_BASE_SHA\` |"
  echo "| tracked tree == HEAD | yes |"
  echo "| pattern-file change waived | $([[ $ALLOW_PATTERN_FILE_CHANGE -eq 1 ]] && echo '**yes — part of the secret scan was skipped**' || echo no) |"
  echo "| narrative | $([[ -n "$NARRATIVE" ]] && echo "\`$NARRATIVE\`" || echo '**none — the prose below is a blank template**') |"
  echo "| npm ci | exit $INSTALL_EXIT |"
  echo "| npm run verify | exit $VERIFY_EXIT |"
  echo "| toolchain | node $NODE_V, npm $NPM_V, $(uname -sr) |"
  echo
  echo "Evidence: \`DIFF.patch\`, \`FILES.txt\`, \`COMMITS.txt\`, \`STATUS.txt\`, \`logs/\`, \`manifest.json\`."
  echo "Read those before the prose below."
  echo
  echo "---"
  echo
  if [[ -n "$NARRATIVE" ]]; then
    # From the snapshot taken at validation time, never re-read from disk.
    printf '%s\n' "$NARRATIVE_TEXT"
  else
    sed 's#](\.\./#](#g' "$TEMPLATE"
  fi
} > "$PACK/REVIEW.md"

# ── publish ─────────────────────────────────────────────────────────────────────
STAGE="publish"
NOW_HEAD="$(git rev-parse HEAD)"
[[ "$NOW_HEAD" == "$HEAD_SHA" ]] \
  || fail "HEAD moved during the run ($HEAD_SHA -> $NOW_HEAD) — the pack would not describe what was verified"
if ! git diff --quiet || ! git diff --cached --quiet; then
  fail "tracked working tree changed during the run — the pack would not describe what was verified"
fi

write_manifest complete

# The old pack is moved aside, NOT deleted first. `rm -rf "$OUT" && mv "$PACK" "$OUT"` reads
# as one step but is two, and an interrupt between them leaves no pack at all — the previous
# evidence destroyed to make room for evidence that never arrived.
PREV=""
if [[ -e "$OUT" ]]; then
  PREV="$OUT.prev.$$"
  rm -rf "$PREV"
  mv "$OUT" "$PREV" \
    || fail "could not move the existing $OUT/ aside — nothing published, the previous pack is untouched"
fi

# The rollback below only runs when the filesystem misbehaves, which is to say: never, during
# development. An untested guard is a comment — the reason this script's failure paths are
# tested at all — so there is one seam for the suite to pull. Set by test-review-pack.sh only.
# Matched against an exact sentinel, not tested for non-emptiness: an inherited
# REVIEW_PACK_SIMULATE_PUBLISH_FAILURE=0 meaning "off" would otherwise fail every run.
if [[ "${REVIEW_PACK_SIMULATE_PUBLISH_FAILURE:-}" == "simulate-publish-failure" ]] || ! mv "$PACK" "$OUT"; then
  if [[ -n "$PREV" ]] && mv "$PREV" "$OUT" 2>/dev/null; then PREV=""; fi
  fail "could not publish the pack to $OUT/${PREV:+ — WARNING: the previous pack is still in $PREV, move it back by hand}"
fi
PACK=""

# Only now is the old pack redundant. A .review.prev.* left by an earlier crash is deliberately
# NOT swept up here: it may be the only complete pack on disk, and deleting it would be exactly
# the failure this sequence exists to prevent. Remove it by hand once you have looked at it.
if [[ -n "$PREV" ]]; then rm -rf "$PREV"; fi

echo "$PROG: wrote $OUT/ — $BASE_REF..$BRANCH @ $(printf '%s' "$HEAD_SHA" | cut -c1-7)"
echo "  $(wc -l < "$OUT/COMMITS.txt" | tr -d ' ') commit(s), $(grep -c '' "$OUT/FILES.txt" | tr -d ' ') file(s) changed, verify exit $VERIFY_EXIT"
