# Retry-send-window - closeout

Status: merged and retired on 2026-09-28. This is the current closeout record
for the historical mission reports in this directory.

## Git verification and removal

Branch `feat/retry-send-window` and worktree `W:\tmp\retry-send-window` both
held `bd752bd04d7228727e9193a2956a93ea81071db1`. Immediately before removal,
`git merge-base --is-ancestor <tip> main` exited 0 and
`git rev-list --count main..<tip>` returned 0. Main at verification was
`ea7777b8429a94f714013cff568472d2298c9276`.

The worktree was clean, its tip was stable, and no non-shell process command
line referenced it. Git deregistered the worktree but reported "Directory not
empty" on Windows. After verifying the registration and `.git` file were gone,
the exact leftover directory was removed. The branch was safely deleted with
`git branch -d`. No process was stopped.

## Operational closeout and prior decisions

The [planner verdict](planner-verdict.md) identifies no additional backfill,
migration, Terraform, secrets, flag, or dependency action. Its deployment note
remains: reload dashboard tabs that were open before deployment so they load
the new retry wording and controls. Cleanup did not perform production
operations or reload the user's tabs.

The questions in the earlier [build handback](build-handback.md) were answered
on 2026-09-26 and are not pending cleanup decisions:

- The temporary stale retry promise after a refusal during backoff was accepted;
  [the issue](../../../issues/one-to-one-retry-promise-outlives-job-decline.md)
  records `wontfix`.
- [Relay claim reliance on callback redelivery](../../../issues/relay-retry-claim-assumes-5xx-redelivery.md)
  remains filed as separate work, with no action requested by that ruling.
- Late-30003 alarm noise remains a documented watch item under the existing
  alarm thresholds.

[Native-group retry-promise verification](../../../issues/group-text-30003-leg-retry-promise-unverified.md)
is already resolved. Other deferred issues remain separate; retirement does
not resolve them. References that still awaited this branch's merge were
reconciled in the drift-guard, manual-retry, and retry-job-marker issue notes.

## Preserved evidence

Before removal, `.superpowers` and `e2e/.artifacts` were copied to
`W:\tmp\_preserved-artifacts\retry-send-window-20260928`:

- 245 files, 114,252,407 bytes; every copy checked against its source SHA-256.
- `manifest.json` records source paths, branch and main tips, sizes, and hashes.
- Source and archive hashes were checked again immediately before removal.
- The archive includes gate logs, self-QA artifacts, the progress ledger,
  review briefs, raw reference packages, and intermediate plan drafts.

The previously ignored build-time adjudication and drift worklist is now
version-controlled as [recovered-build-worklist.md](recovered-build-worklist.md),
with its original body unchanged. The ignored `sdd/handback.md` matched the
existing committed `build-handback.md` after line-ending normalization; it did
not need a second copy. Research findings, slice reports, fix-wave reports,
reviews, adjudications, and self-QA already have committed records here.

## Historical documents and verification

The [design](../../specs/2026-09-24-retry-send-window-design.md) and
[implementation plan](../../plans/2026-09-25-retry-send-window.md) are frozen;
their original bodies are unchanged. Build and planner handback headers point
here. Research notes and the recovered worklist retain their historical
content without a design/plan freeze marker.

This administrative cleanup verifies Git ancestry, branch/worktree/directory
absence, archive hashes, documentation diffs, ASCII on added text, and original
body preservation. No application test suite was run. Other branches and
worktrees are outside this cleanup.
