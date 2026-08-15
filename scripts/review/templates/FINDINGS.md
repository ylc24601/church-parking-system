---
reviewed_head_sha:
reviewed_base_sha:
reviewed_merge_base_sha:
packet_manifest_sha256:
previous_findings:
review_date:
reviewer:
verdict:
---

<!-- Copy to .review-notes/FINDINGS-<head12>.md. Delete these comments as you fill it in.
     The frontmatter is what makes the next round possible: a delta review has to be able to
     say which commit the last verdict applied to, without anyone remembering. -->

# FINDINGS — `<branch>` @ `<head12>`

<!-- If base_ref is not main, say so here and give the base SHA. The reviewer reads it from
     .review/manifest.json — never assume main. -->

## Workspace check

<!-- Paste the output of scripts/review/check-review-workspace.sh --phase pre verbatim.
     A verdict without this block is not accepted (docs/review-protocol.md). -->

```text
```

## Blockers

<!-- Numbered F-001, F-002, … The IDs are referenced by the implementer's RESPONSES file, so
     they must stay stable across rounds. Drop the section if there are none. -->

### F-001 — <one line>
- **Severity:**
- **File:** `path:line`
- **Finding:** <what is wrong, and how you established it — packet evidence, source, or both>
- **Required change:**

## Non-blockers

<!-- Same shape, N-001, N-002, … Include what you checked and found correct, when knowing it
     was checked saves the next round from re-deriving it. -->

## Validation reviewed

<!-- What the packet's evidence actually shows, in your own words: exit codes, test counts,
     whether DIFF.patch matches the real diff. If you re-ran anything, say what and why —
     the default is not to re-run (docs/review-protocol.md). -->

## Verdict

**Approve** / **Changes requested** — <one line>

## Workspace check (post)

<!-- Paste `--phase post --expect <the token pre printed>` here. The token is required: without
     it the run is VOID, because a post phase carrying nothing forward from pre proves nothing.
     What it establishes is that pre and post saw the SAME <head12>:<manifest_sha256> — not that
     nothing moved in between. Replaced and put back reads as never touched. -->

```text
```
