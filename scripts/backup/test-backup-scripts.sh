#!/usr/bin/env bash
#
# Failure-path tests for db-backup.sh / db-restore.sh, using fake pg_dump / age / psql /
# aws on PATH so no database or bucket is needed. Runs in CI and locally.
#
# What this covers: that every failure path EXITS NON-ZERO. A backup script that returns 0
# after a broken dump is worse than no backup, because it manufactures confidence.
#
# What this does NOT cover (deliberately, and stated so nobody assumes otherwise): the real
# data round-trip — dump a live DB, encrypt, decrypt, restore, compare counts. That needs
# real Postgres with the real schema, and is covered by the monthly restore drill in
# docs/backup-restore-runbook.md §5. CI proves the guards fire; the drill proves the data
# comes back.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP="$HERE/db-backup.sh"
RESTORE="$HERE/db-restore.sh"
PASS=0; FAIL=0

ok()   { PASS=$((PASS+1)); echo "  PASS  $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL  $1"; }

# Assert a command exits non-zero, and (optionally) that its output mentions a phrase.
expect_fail() {
  local desc="$1" phrase="${2:-}"; shift 2
  local out rc
  out="$("$@" 2>&1)"; rc=$?
  if [[ $rc -eq 0 ]]; then
    bad "$desc (expected non-zero, got 0)"; return
  fi
  if [[ -n "$phrase" ]] && ! grep -qF "$phrase" <<<"$out"; then
    bad "$desc (exited $rc but message lacked '$phrase': $(head -1 <<<"$out"))"; return
  fi
  ok "$desc"
}

expect_ok() {
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then ok "$desc"; else bad "$desc (expected 0, got non-zero)"; fi
}

# ── fake binaries ───────────────────────────────────────────────────────────────
FAKEBIN="$(mktemp -d)"; trap 'rm -rf "$FAKEBIN" "$TMP"' EXIT
TMP="$(mktemp -d)"

cat >"$FAKEBIN/psql" <<'EOF'
#!/usr/bin/env bash
# fake psql: satisfies the version probe and the row-count query
outfile=""; prev=""
for a in "$@"; do [[ "$prev" == "-o" ]] && outfile="$a"; prev="$a"; done
if printf '%s\n' "$@" | grep -q 'server_version'; then echo "17.6"; exit 0; fi
if [[ -n "$outfile" ]]; then printf 'public.users\t9\npublic.audit_logs\t4\n' > "$outfile"; exit 0; fi
echo "0"; exit 0
EOF

cat >"$FAKEBIN/pg_dump" <<'EOF'
#!/usr/bin/env bash
[[ "${FAKE_PGDUMP_FAIL:-0}" = "1" ]] && { echo "pg_dump: connection failed" >&2; exit 1; }
printf 'PGDMP-fake-dump-bytes'
EOF

cat >"$FAKEBIN/age" <<'EOF'
#!/usr/bin/env bash
# fake age: -o <out>. Modes let us simulate a broken encryptor.
out=""; prev=""
for a in "$@"; do [[ "$prev" == "-o" ]] && out="$a"; prev="$a"; done
data="$(cat)"
case "${FAKE_AGE_MODE:-ok}" in
  empty)     : > "$out" ;;
  plaintext) printf '%s' "$data" > "$out" ;;      # forgot to encrypt
  *)         { printf 'age-encryption.org/v1\n-> X25519 fake\n'; printf '%s' "$data"; } > "$out" ;;
esac
exit 0
EOF

cat >"$FAKEBIN/aws" <<'EOF'
#!/usr/bin/env bash
[[ "${FAKE_AWS_FAIL:-0}" = "1" ]] && { echo "upload failed" >&2; exit 1; }
exit 0
EOF

chmod +x "$FAKEBIN"/*
export PATH="$FAKEBIN:$PATH"

BASE_ENV=(SUPABASE_DB_URL=postgres://u:p@h/db AGE_RECIPIENT=age1fake)

echo "db-backup.sh — configuration guards"
expect_fail "missing SUPABASE_DB_URL"  "SUPABASE_DB_URL" env -u SUPABASE_DB_URL AGE_RECIPIENT=age1fake LOCAL_DEST="$TMP/a" bash "$BACKUP"
expect_fail "missing AGE_RECIPIENT"    "AGE_RECIPIENT"   env -u AGE_RECIPIENT SUPABASE_DB_URL=x LOCAL_DEST="$TMP/a" bash "$BACKUP"
expect_fail "no destination"           "destination"     env "${BASE_ENV[@]}" bash "$BACKUP"
expect_fail "two destinations"         "only ONE"        env "${BASE_ENV[@]}" LOCAL_DEST="$TMP/a" S3_BUCKET=b bash "$BACKUP"

echo "db-backup.sh — failure paths must not report success"
expect_fail "pg_dump failure fails the run" "" \
  env "${BASE_ENV[@]}" LOCAL_DEST="$TMP/b" FAKE_PGDUMP_FAIL=1 bash "$BACKUP"
expect_fail "empty artifact is refused" "empty" \
  env "${BASE_ENV[@]}" LOCAL_DEST="$TMP/c" FAKE_AGE_MODE=empty bash "$BACKUP"
expect_fail "unencrypted artifact is refused" "not age-encrypted" \
  env "${BASE_ENV[@]}" LOCAL_DEST="$TMP/d" FAKE_AGE_MODE=plaintext bash "$BACKUP"
expect_fail "upload failure fails the run" "upload" \
  env "${BASE_ENV[@]}" S3_BUCKET=bkt FAKE_AWS_FAIL=1 bash "$BACKUP"

echo "db-backup.sh — happy path still succeeds, and writes BOTH objects"
expect_ok "local backup succeeds" env "${BASE_ENV[@]}" LOCAL_DEST="$TMP/ok" bash "$BACKUP"
if [[ -n "$(find "$TMP/ok" -name 'parking-*.pgc.age' -print -quit 2>/dev/null)" \
   && -n "$(find "$TMP/ok" -name 'parking-*.manifest.age' -print -quit 2>/dev/null)" ]]; then
  ok "wrote dump + manifest"
else
  bad "wrote dump + manifest"
fi

echo "db-restore.sh — preconditions"
expect_fail "missing args"        "usage"            bash "$RESTORE"
expect_fail "missing artifact"    "artifact not found" bash "$RESTORE" "$TMP/nope.pgc.age" "postgres://x/y"
: > "$TMP/present.pgc.age"
expect_fail "unknown flag rejected" "unknown argument" \
  env AGE_IDENTITY="$TMP/present.pgc.age" bash "$RESTORE" "$TMP/present.pgc.age" "postgres://x/y" --oops
expect_fail "missing age identity" "identity" \
  env AGE_IDENTITY="$TMP/no-identity" bash "$RESTORE" "$TMP/present.pgc.age" "postgres://x/y"
expect_fail "missing manifest"    "manifest not found" \
  env AGE_IDENTITY="$TMP/present.pgc.age" MANIFEST="$TMP/no.manifest.age" \
      bash "$RESTORE" "$TMP/present.pgc.age" "postgres://x/y"

echo "db-restore.sh — a failure must leave the diagnostic log behind"
# Regression guard: the failure message used to promise './restore-failed.log' while no
# copy was ever made, and cleanup then deleted the temp dir — so a REAL restore failure
# destroyed its own evidence, mid-disaster, which is when you need it most.
if (
  LOGT="$TMP/logtest"; mkdir -p "$LOGT/run"
  printf 'FAKEDUMP' > "$LOGT/a.pgc.age"
  if command -v sha256sum >/dev/null; then s="$(sha256sum "$LOGT/a.pgc.age" | awk '{print $1}')"
  else s="$(shasum -a 256 "$LOGT/a.pgc.age" | awk '{print $1}')"; fi
  { echo "artifact_sha256=$s"; echo "backup_utc=T"; echo "# schema.table<TAB>rows";
    printf 'public.users\t9\n'; } > "$LOGT/a.manifest.age"
  : > "$LOGT/id"
  # age passthrough; pg_restore emits a NON-benign error so the restore is rejected
  cat >"$FAKEBIN/pg_restore" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
echo 'pg_restore: error: could not execute query: ERROR:  relation "users" is corrupt'
exit 1
EOF
  cat >"$FAKEBIN/age" <<'EOF'
#!/usr/bin/env bash
f=""; for a in "$@"; do [[ -f "$a" ]] && f="$a"; done
[[ -n "$f" ]] && cat "$f" || cat
EOF
  chmod +x "$FAKEBIN/pg_restore" "$FAKEBIN/age"
  cd "$LOGT/run" || exit 1
  AGE_IDENTITY="$LOGT/id" MANIFEST="$LOGT/a.manifest.age" VERIFY_SQL="$LOGT/a.manifest.age" \
    bash "$RESTORE" "$LOGT/a.pgc.age" 'postgresql://u:pw@h/db' >/dev/null 2>&1
  [[ -s "$LOGT/run/restore-failed.log" ]]
); then ok "failure preserves ./restore-failed.log"; else bad "failure preserves ./restore-failed.log"; fi

echo "db-restore.sh — the target URL must never echo credentials"
: > "$TMP/id.txt"; : > "$TMP/m.age"
out="$(env AGE_IDENTITY="$TMP/id.txt" MANIFEST="$TMP/m.age" \
       bash "$RESTORE" "$TMP/present.pgc.age" 'postgresql://postgres:HUNTER2@h.example:5432/db?x=1' 2>&1 || true)"
if grep -q 'HUNTER2' <<<"$out"; then bad "password not echoed"; else ok "password not echoed"; fi

echo
echo "passed=$PASS failed=$FAIL"
[[ $FAIL -eq 0 ]]
