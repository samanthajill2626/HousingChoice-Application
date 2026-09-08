# CloudFront maintenance page closeout

Closed 2026-09-08 on Cameron's explicit instruction to retire
`codex/cloudfront-maintenance-page`.

## Integration and retirement

- Feature tip: `b929560c4e9319b8a7fe33f229a95e5fea277aea`.
- Merge: `2cc8fd33` (`Merge branch 'codex/cloudfront-maintenance-page'`).
- Main at retirement: `8e193c94356cae85e2deb5a816d4a65b032c12ea`.
- Immediately before removal, the tip matched the worktree HEAD,
  `git merge-base --is-ancestor` exited 0, and `main..branch` contained 0 commits.
  The worktree was clean and no non-shell process command line referenced it.
- Removed `W:\tmp\cloudfront-maintenance-page` and deleted the branch with
  `git branch -d`. Git deregistered the worktree but initially left a non-empty
  directory; the exact validated leftover was removed separately. No process was
  killed and no unrelated worktree was changed.
- The approved spec and implementation plan are frozen as historical records,
  with their original bodies preserved. Review records retain their original
  findings and test results; the two handbacks link here for current status.

## Hosted verification and operations

Cameron confirmed on 2026-09-08 that he verified the maintenance page and saw the
502/504 fallback page appear during an app deployment. This is operator-confirmed
hosted substitution, beyond merely opening the static maintenance document.
The observation did not distinguish the exact status or environment; it is not
recorded as independently captured HTTP proof for both statuses in both environments.

Earlier in the cleanup conversation, Cameron reported the branches should already
be merged, Terraform planned/applied, and deployed. Git integration was verified
directly; AWS state was not independently queried during cleanup. No additional
backfill, migration, reseed, secret push, feature flag, or app redeploy is required
by this feature. Current operating instructions remain in `RUNBOOK.md`.

## Remaining native browser-zoom check

The prior hermetic check enlarged the root font from 16px to 32px at a 320px-wide
viewport and passed readability, overflow, and action checks. It did not exercise
the browser's own 200% zoom setting; the computer-use attempt failed before input.
Cameron's observation that the default text looks large is not recorded as a
native-zoom test. Branch retirement is authorized independently of this check.

To complete it, open the maintenance document, set the browser menu's Zoom to
200%, and verify the heading and body are readable without clipping or horizontal
scrolling and that Try again remains visible, keyboard-focusable, and usable.
Restore Zoom to 100% afterward. This tests layout under enlargement; it does not
require changing the default font size or inducing another app outage.

## Preserved evidence

Before deletion, copied and SHA-256-verified 263 files totaling 190,014,695 bytes
to `W:\tmp\_preserved-artifacts\cloudfront-maintenance-page-20260908`.
`manifest.json` there records every relative path, byte count, and verified hash.
The preserved files came from `.superpowers`, `.playwright-mcp`, and `e2e/.artifacts`.

This retains gate logs and exits, builder/parent MMS failure traces, screenshots,
browser reports, infrastructure-check evidence, and detailed research references.
Both ignored handbacks already had exact tracked copies. The durable research
decisions are in `research-worklist.md`; the ignored detailed source references
are preserved externally instead of duplicating source quotations in Git.

The historical full E2E exit 1 remains in the handbacks. The subsequently merged
MMS test fix has its own record in
`../2026-09-07-outbound-mms-scroll-recheck/verification.md`; cleanup does not
relabel the original failed runs as passing or close unrelated follow-up issues.
