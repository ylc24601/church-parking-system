#!/usr/bin/env bash
#
# Encrypted database backup for the church parking system (interim, while on the
# Supabase Free tier — see docs/backup-restore-runbook.md and docs/go-live-checklist.md §1.1).
#
# Produces TWO objects per run, sharing a timestamped basename:
#   parking-<stamp>.pgc.age        the dump   (pg_dump custom format, age-encrypted)
#   parking-<stamp>.manifest.age   the manifest (age-encrypted)
#
# The manifest records the row count of EVERY base table in public+private, plus the
# SHA-256 of the encrypted dump. db-restore.sh refuses to proceed unless the dump it was
# handed hashes to what the manifest says, then asserts the restored row counts match the
# manifest exactly. That is what turns "some tables have some rows" into a real check —
# a partially-restored or truncated dump fails instead of being eyeballed as fine.
#
# Both files are streamed through `age` — plaintext PII never lands on disk, which matters
# most in LOCAL_DEST mode where the disk is somebody's persistent machine, not an
# ephemeral CI runner.
#
# Destination — set exactly ONE:
#   * S3-compatible (Cloudflare R2 / Backblaze B2 / S3): S3_BUCKET (+ S3_ENDPOINT)
#   * a local path (NAS mount, attached encrypted drive):  LOCAL_DEST=/path/to/dir
#
# Required env:
#   SUPABASE_DB_URL   postgres connection string. From CI use the SESSION-MODE POOLER
#                     (port 5432, aws-*.pooler.supabase.com) — GitHub runners are IPv4-only
#                     and Supabase's direct connection is IPv6-only.
#   AGE_RECIPIENT     the church's age PUBLIC key (age1...). Not secret.
# Optional:
#   HEARTBEAT_URL     pinged only on full success. Use a dead-man's-switch monitor
#                     (healthchecks.io etc.) so a backup that STOPS RUNNING alerts —
#                     a workflow that never fires produces no failure, only silence.
#   RETENTION_DAYS    LOCAL_DEST only (S3 retention belongs in a bucket lifecycle rule).
#
# Never echoes SUPABASE_DB_URL or any credential.

set -euo pipefail

fail() { echo "backup: ERROR $*" >&2; exit 1; }

: "${SUPABASE_DB_URL:?SUPABASE_DB_URL is required}"
: "${AGE_RECIPIENT:?AGE_RECIPIENT (age public key) is required}"

command -v pg_dump >/dev/null || fail "pg_dump not found"
command -v age     >/dev/null || fail "age not found"
command -v psql    >/dev/null || fail "psql not found"

if [[ -n "${S3_BUCKET:-}" && -n "${LOCAL_DEST:-}" ]]; then
  fail "set only ONE of S3_BUCKET or LOCAL_DEST, not both"
elif [[ -z "${S3_BUCKET:-}" && -z "${LOCAL_DEST:-}" ]]; then
  fail "set a destination: S3_BUCKET (+ S3_ENDPOINT) or LOCAL_DEST"
fi

RETENTION_DAYS="${RETENTION_DAYS:-90}"
PREFIX="${S3_PREFIX:-parking-db}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BASE="parking-${STAMP}"

WORK="$(mktemp -d)"
# Capture and re-raise the status: a bare `trap 'rm -rf ...' EXIT` lets the cleanup's own
# exit code (rm succeeds = 0) become the script's, so a FATAL error can report SUCCESS.
# For a backup script that is the worst possible bug — it manufactures confidence.
# (Found by scripts/backup/test-backup-scripts.sh, not by reading.)
cleanup() { rc=$?; rm -rf "$WORK"; exit "$rc"; }
trap cleanup EXIT
DUMP_ENC="$WORK/${BASE}.pgc.age"
MAN_ENC="$WORK/${BASE}.manifest.age"

sha256_of() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

# ── 1. Row counts FIRST, immediately before the dump ────────────────────────────
# pg_dump's snapshot begins when it starts, so counting just before it minimises the
# window in which a concurrent write could make manifest and dump disagree. Enumerated
# from the catalog, not a hand-written list, so a table that disappears entirely is
# caught rather than silently skipped.
echo "backup: reading row counts for every base table in public+private ..."
COUNTS="$WORK/counts.tsv"
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -tA -F$'\t' -o "$COUNTS" -c "
  select table_schema||'.'||table_name,
         (xpath('/row/c/text()', query_to_xml(
            format('select count(*) as c from %I.%I', table_schema, table_name),
            false, true, '')))[1]::text::bigint
  from information_schema.tables
  where table_schema in ('public','private') and table_type='BASE TABLE'
  order by 1;" || fail "could not read row counts"
[[ -s "$COUNTS" ]] || fail "row-count query returned nothing — refusing to write a manifest that asserts nothing"
TABLE_COUNT="$(wc -l < "$COUNTS" | tr -d ' ')"

SERVER_VERSION="$(psql "$SUPABASE_DB_URL" -tA -c 'show server_version' | tr -d ' ')"

# ── 2. Dump, encrypted in-stream ────────────────────────────────────────────────
echo "backup: dumping public+private (schema+data), encrypting in-stream ..."
# pipefail makes a pg_dump failure fail the pipeline, so a broken dump is never encrypted
# and shipped as if it were good. --no-owner keeps restore portable across projects.
pg_dump --format=custom --no-owner --schema=public --schema=private "$SUPABASE_DB_URL" \
  | age -r "$AGE_RECIPIENT" -o "$DUMP_ENC"

[[ -s "$DUMP_ENC" ]] || fail "produced an empty dump artifact"
head -c 21 "$DUMP_ENC" | grep -q 'age-encryption.org' \
  || fail "dump artifact is not age-encrypted — refusing to ship"
DUMP_SHA="$(sha256_of "$DUMP_ENC")"
DUMP_SIZE="$(wc -c < "$DUMP_ENC" | tr -d ' ')"

# ── 3. Manifest, bound to the dump by hash ──────────────────────────────────────
{
  echo "# parking-system backup manifest"
  echo "manifest_version=1"
  echo "backup_utc=${STAMP}"
  echo "artifact=${BASE}.pgc.age"
  echo "artifact_sha256=${DUMP_SHA}"
  echo "artifact_bytes=${DUMP_SIZE}"
  echo "pg_server_version=${SERVER_VERSION}"
  echo "table_count=${TABLE_COUNT}"
  echo "# schema.table<TAB>rows"
  cat "$COUNTS"
} | age -r "$AGE_RECIPIENT" -o "$MAN_ENC"

[[ -s "$MAN_ENC" ]] || fail "produced an empty manifest"
head -c 21 "$MAN_ENC" | grep -q 'age-encryption.org' \
  || fail "manifest is not age-encrypted — refusing to ship"

echo "backup: ${BASE}.pgc.age (${DUMP_SIZE} bytes, sha256 ${DUMP_SHA:0:12}...), manifest covers ${TABLE_COUNT} tables"

# ── 4. Ship both ────────────────────────────────────────────────────────────────
if [[ -n "${S3_BUCKET:-}" ]]; then
  command -v aws >/dev/null || fail "aws CLI not found"
  ENDPOINT_ARG=(); [[ -n "${S3_ENDPOINT:-}" ]] && ENDPOINT_ARG=(--endpoint-url "$S3_ENDPOINT")
  for f in "$DUMP_ENC" "$MAN_ENC"; do
    n="$(basename "$f")"
    # ${arr[@]+"${arr[@]}"} — expanding an EMPTY array as "${arr[@]}" trips `set -u` on
    # bash 3.2 (macOS). Do not "simplify" this back.
    aws s3 cp "$f" "s3://${S3_BUCKET}/${PREFIX}/${n}" ${ENDPOINT_ARG[@]+"${ENDPOINT_ARG[@]}"} --only-show-errors \
      || fail "upload of ${n} failed"
  done
  echo "backup: uploaded both objects to s3://${S3_BUCKET}/${PREFIX}/"
  echo "backup: NOTE retention on S3 is a bucket LIFECYCLE RULE (see runbook §1.4), not this script."
else
  mkdir -p "$LOCAL_DEST" || fail "cannot create LOCAL_DEST $LOCAL_DEST"
  cp "$DUMP_ENC" "$MAN_ENC" "$LOCAL_DEST/" || fail "copy to LOCAL_DEST failed"
  echo "backup: wrote both objects to $LOCAL_DEST/"
  # Local destinations have no lifecycle rule, so prune here. Non-fatal: a stale extra
  # copy must never fail an otherwise-good backup.
  find "$LOCAL_DEST" -maxdepth 1 -type f \( -name 'parking-*.pgc.age' -o -name 'parking-*.manifest.age' \) \
       -mtime "+${RETENTION_DAYS}" -delete 2>/dev/null \
    || echo "backup: WARN prune of >${RETENTION_DAYS}d old local copies failed (backup itself is fine)" >&2
fi

# ── 5. Heartbeat — only after everything above succeeded ────────────────────────
if [[ -n "${HEARTBEAT_URL:-}" ]]; then
  if command -v curl >/dev/null && curl -fsS -m 15 "$HEARTBEAT_URL" -o /dev/null; then
    echo "backup: heartbeat sent"
  else
    # Do not fail the backup: the data is safely stored; only the monitor ping failed.
    echo "backup: WARN heartbeat ping failed — the backup itself succeeded" >&2
  fi
fi

echo "backup: OK ${BASE}"
