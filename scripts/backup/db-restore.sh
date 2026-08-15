#!/usr/bin/env bash
#
# Restore (or restore-DRILL) an encrypted backup produced by db-backup.sh.
# See docs/backup-restore-runbook.md for the disaster-recovery model.
#
#   scripts/backup/db-restore.sh <artifact.pgc.age> <TARGET_DB_URL> [--clean]
#
# It SUCCEEDS only if all four of these hold. Any one failing exits non-zero:
#   1. the artifact hashes to what its manifest says (right dump, undamaged, right pair)
#   2. pg_restore emitted no error outside a short, explicit benign allowlist
#   3. every table's restored row count equals the manifest exactly, none missing
#   4. verify_schema_prod.sql passes against the restored database
#
# "Print the counts and let a human judge" is not a disaster-recovery success condition:
# a partial restore, a truncated dump, or a table that vanished all look reassuring in a
# list of numbers. The manifest is what makes the check mean something.
#
# <TARGET_DB_URL>  the database to restore INTO. No default, no prod guessing — you type it,
#                  so a restore can never hit the wrong database by omission.
# --clean          DESTRUCTIVE: drops existing objects first. Off by default. Only for
#                  re-running a drill against a scratch DB you are willing to lose.
#
# Requires the church's age IDENTITY (private key) at $AGE_IDENTITY (default ./age-identity.txt).
# Never echoes credentials: the target is printed as host/database only.

set -euo pipefail

fail() { echo "restore: FAILED — $*" >&2; exit 1; }

ART="${1:-}"; TARGET="${2:-}"; CLEAN_FLAG="${3:-}"
[[ -n "$ART" && -n "$TARGET" ]] || fail "usage: db-restore.sh <artifact.pgc.age> <TARGET_DB_URL> [--clean]"
[[ -f "$ART" ]] || fail "artifact not found: $ART"

CLEAN=0
if [[ -n "$CLEAN_FLAG" ]]; then
  [[ "$CLEAN_FLAG" == "--clean" ]] || fail "unknown argument: $CLEAN_FLAG"
  CLEAN=1
fi

AGE_IDENTITY="${AGE_IDENTITY:-./age-identity.txt}"
[[ -f "$AGE_IDENTITY" ]] || fail "age identity (private key) not found at $AGE_IDENTITY — set AGE_IDENTITY"

MANIFEST="${MANIFEST:-${ART%.pgc.age}.manifest.age}"
[[ -f "$MANIFEST" ]] || fail "manifest not found at $MANIFEST — download it alongside the dump (db-backup.sh writes both)"

for c in age pg_restore psql; do command -v "$c" >/dev/null || fail "$c not found"; done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERIFY_SQL="${VERIFY_SQL:-$SCRIPT_DIR/../../parking-system/supabase/tests/verify_schema_prod.sql}"
[[ -f "$VERIFY_SQL" ]] || fail "verify_schema_prod.sql not found at $VERIFY_SQL — set VERIFY_SQL"

# Show WHERE we are restoring, with credentials removed. Splitting on the LAST '@'
# (not the first) keeps a password that itself contains '@' from leaking a fragment.
sanitize_url() { local u="$1"; u="${u#*://}"; u="${u##*@}"; printf '%s' "${u%%\?*}"; }

# Capture and re-raise the status — a bare cleanup trap lets `rm`'s own exit code (0)
# become the script's, turning a FATAL error into a reported success. See db-backup.sh.
WORK="$(mktemp -d)"
cleanup() {
  rc=$?
  # On failure, preserve the diagnostics BEFORE the temp dir is removed. A restore that
  # fails loudly but destroys its own evidence is only half a guard — and it destroys it
  # at exactly the moment you need it, mid-disaster. Applies to EVERY failure path, not
  # just the pg_restore one, so verify.log survives too.
  if [[ $rc -ne 0 ]]; then
    if [[ -f "$WORK/restore.log" ]]; then cp "$WORK/restore.log" ./restore-failed.log 2>/dev/null || :; fi
    if [[ -f "$WORK/verify.log"  ]]; then cp "$WORK/verify.log"  ./restore-failed-verify.log 2>/dev/null || :; fi
  fi
  rm -rf "$WORK"
  exit "$rc"
}
trap cleanup EXIT

echo "restore: target = $(sanitize_url "$TARGET")"
[[ $CLEAN -eq 1 ]] && echo "restore: --clean given — existing objects in that database WILL BE DROPPED first."

# ── 1. Artifact matches its manifest ────────────────────────────────────────────
sha256_of() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}
age -d -i "$AGE_IDENTITY" "$MANIFEST" > "$WORK/manifest.txt" 2>"$WORK/age.err" \
  || fail "could not decrypt the manifest (wrong key?): $(head -1 "$WORK/age.err")"

EXPECT_SHA="$(grep -m1 '^artifact_sha256=' "$WORK/manifest.txt" | cut -d= -f2 || true)"
[[ -n "$EXPECT_SHA" ]] || fail "manifest has no artifact_sha256 — refusing to trust it"
ACTUAL_SHA="$(sha256_of "$ART")"
[[ "$EXPECT_SHA" == "$ACTUAL_SHA" ]] \
  || fail "artifact does not match its manifest (expected ${EXPECT_SHA:0:12}..., got ${ACTUAL_SHA:0:12}...) — wrong pair, or the dump is damaged"
echo "restore: artifact matches manifest (sha256 ${ACTUAL_SHA:0:12}...), taken $(grep -m1 '^backup_utc=' "$WORK/manifest.txt" | cut -d= -f2)"

# ── 2. Restore, and hold pg_restore to a short benign allowlist ─────────────────
# Supabase emits a few unavoidable lines we do NOT control: the managed `public` schema
# already exists, and default privileges belong to `supabase_admin`. Everything else —
# a corrupt dump, a failed function/trigger/grant, a permission problem on
# --disable-triggers — must fail the restore rather than be waved through.
CLEAN_ARGS=(); [[ $CLEAN -eq 1 ]] && CLEAN_ARGS=(--clean --if-exists)
set +e
# ${arr[@]+"${arr[@]}"} — expanding an EMPTY array as "${arr[@]}" trips `set -u` on bash 3.2
# (macOS), which is where this gets run by hand. Do not "simplify" this back.
age -d -i "$AGE_IDENTITY" "$ART" \
  | pg_restore --no-owner --disable-triggers ${CLEAN_ARGS[@]+"${CLEAN_ARGS[@]}"} -d "$TARGET" >"$WORK/restore.log" 2>&1
PIPE_STATUS=("${PIPESTATUS[@]}")
set -e
[[ "${PIPE_STATUS[0]}" -eq 0 ]] || fail "decryption failed (wrong key, or truncated artifact)"
# pg_restore exits non-zero for the benign Supabase notices too, so a non-zero code alone
# is not a failure — but a non-zero code with NO server 'ERROR:' lines means it never got
# as far as running queries (bad connection, unreadable dump). Report that honestly rather
# than letting it surface later as a confusing count mismatch.
if [[ "${PIPE_STATUS[1]}" -ne 0 ]] && ! grep -q 'ERROR:' "$WORK/restore.log"; then
  tail -10 "$WORK/restore.log" >&2
  fail "pg_restore failed before executing any statement (connection refused, or not a valid dump)"
fi

BENIGN='schema "public" already exists|permission denied to change default privileges'
[[ $CLEAN -eq 1 ]] && BENIGN="$BENIGN"'|does not exist'

UNEXPECTED="$(grep 'ERROR:' "$WORK/restore.log" | grep -Ev "$BENIGN" || true)"
if [[ -n "$UNEXPECTED" ]]; then
  echo "restore: pg_restore reported errors outside the benign allowlist:" >&2
  echo "$UNEXPECTED" | head -20 >&2
  fail "restore is NOT trustworthy — full log preserved at ./restore-failed.log"
fi
# Cross-check pg_restore's own tally against what we classified, so an error shape we
# failed to parse cannot slip through as "no unexpected errors".
IGNORED="$(grep -oE 'errors ignored on restore: [0-9]+' "$WORK/restore.log" | grep -oE '[0-9]+$' || echo 0)"
CLASSIFIED="$(grep -c 'ERROR:' "$WORK/restore.log" || true)"
[[ "${IGNORED:-0}" -le "${CLASSIFIED:-0}" ]] \
  || fail "pg_restore ignored ${IGNORED} errors but only ${CLASSIFIED} were parsed — unclassified failures present"
echo "restore: pg_restore clean (${CLASSIFIED} benign Supabase-managed notices allowed)"

# ── 3. Row counts must equal the manifest, exactly, for every table ─────────────
MISMATCH=0; CHECKED=0
while IFS=$'\t' read -r tbl expected; do
  [[ -z "${tbl:-}" || "$tbl" == \#* ]] && continue
  schema="${tbl%%.*}"; name="${tbl#*.}"
  actual="$(psql "$TARGET" -tA -c "select count(*) from \"$schema\".\"$name\"" 2>/dev/null || echo MISSING)"
  CHECKED=$((CHECKED+1))
  if [[ "$actual" == "MISSING" ]]; then
    echo "restore:   $tbl — TABLE MISSING (manifest expected $expected rows)" >&2; MISMATCH=1
  elif [[ "$actual" != "$expected" ]]; then
    echo "restore:   $tbl — expected $expected, got $actual" >&2; MISMATCH=1
  fi
done < <(sed -n '/^# schema.table/,$p' "$WORK/manifest.txt" | tail -n +2)

[[ "$CHECKED" -gt 0 ]] || fail "manifest listed no tables — refusing to call this a successful restore"
[[ "$MISMATCH" -eq 0 ]] || fail "row counts do not match the manifest (see above) — the restore is INCOMPLETE"
echo "restore: row counts match the manifest for all $CHECKED tables"

# ── 4. Structure must verify, not just data ─────────────────────────────────────
# Catches functions/triggers/grants that failed to restore — invisible to row counts.
if psql "$TARGET" -v ON_ERROR_STOP=1 -f "$VERIFY_SQL" >"$WORK/verify.log" 2>&1; then
  echo "restore: verify_schema_prod.sql passed ($(grep -c 'PASS:' "$WORK/verify.log" || echo '?') assertions)"
else
  tail -15 "$WORK/verify.log" >&2
  fail "verify_schema_prod.sql did NOT pass — data may be present but the security structure is not intact (full log at ./restore-failed-verify.log)"
fi

echo "restore: OK — artifact verified, restore clean, all $CHECKED table counts match, schema verified."
