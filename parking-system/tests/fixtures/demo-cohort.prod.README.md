# `demo-cohort.prod.csv` — Phase 9 Slice 4 demo cohort (MANUAL prod demo only)

**Do NOT wire this file into any automated import, seed, or test.** It exists solely for the
Phase 9 Slice 4 *demo-complete on prod* scripted walkthrough, where an operator uploads it once
through the Admin member-import UI and then cleans it up. It is deliberately named `.prod.csv`
(not the regular `members-sample.csv`) to keep it out of the local fixtures used by the test
suite.

## What it contains

Six **purely synthetic** P2 members. **Zero real PII** — no real names, phone numbers, plates,
LINE IDs, or UUIDs. Every row passes the real production validator (`lib/memberImport.ts`); no
validator was relaxed for the markers.

Markers (searchable for cleanup):

| Field | Marker |
|---|---|
| `applicant_name` | `DEMO` prefix (e.g. `DEMO測試甲`) |
| `mobile_phone` | reserved block `0900000001`–`0900000006`, one per member |
| `license_plate` | `DEMO01`…`DEMO06` (normalizes to itself, globally unique) |
| `reason_type` | mostly `1` (mobility_long, permanent, no review); one `4` (elderly_companion) for variety |

## The live demo member is NOT in this file

The one live member in the walkthrough is the **developer's own LINE-bound identity** (from
Phase 9 Slice 3). Its row — carrying the developer's *real* name/phone — is **never committed**.
At run time the operator copies this CSV to an ignored local temp file
(`parking-system/.local/…`, gitignored), injects the developer row from shell env vars, uploads
that temp file, then `unset`s the vars and deletes the temp file. See the Slice 4 plan and
`docs/prod-deploy-runbook.md` §Slice 4.

## Row → allocation order (see plan D4)

Effective capacity is dropped to 2 for the demo event, so with all members P2 / penalty 0 /
never-attended, ordering is purely by `applied_at`. The operator creates reservations via the
`apply_reservation` RPC with explicit increasing `p_now` so that:

1. `DEMO測試甲` → approved
2. `DEMO測試乙` → approved (the pastoral-alert subject: seeded `consecutive_no_show=3`, ends the
   walkthrough as `no_show`)
3. **developer** → waiting rank 1 (the substitution offer recipient)
4. `DEMO測試丙`–`己` → waiting

## Cleanup

All six synthetic members + the developer identity are removed together in one FK-safe stop-gate
teardown (plan 產出 4). Resolve synthetic user ids by marker (`display_name LIKE 'DEMO%'` / the
reserved phone block / `DEMO%` plates), union the developer's recorded user id, then delete in FK
order. Verify marker/phone/plate/`line_id` all return zero afterwards.
