# Mission record - MMS image viewer (`feat/mms-image-viewer`)

Preserved 2026-08-27 when the branch and its worktree were retired. These files
lived under the worktree's gitignored `.superpowers/`.

**This is a point-in-time record, not current documentation.** The design and
plan are frozen at
[`2026-08-27-mms-image-viewer-design.md`](../../specs/2026-08-27-mms-image-viewer-design.md)
and [`2026-08-27-mms-image-viewer.md`](../../plans/2026-08-27-mms-image-viewer.md).
For current truth read the code.

## Open follow-ups this mission left behind

Both are filed in `docs/issues/` and are NOT discharged by the branch retiring:

- **[`authenticated-mms-media-browser-cache`](../../../issues/authenticated-mms-media-browser-cache.md)
  - severity HIGH, open.** Filed by this branch's last commit.
- [`e2e-image-viewer-scroll-flake`](../../../issues/e2e-image-viewer-scroll-flake.md)
  - open.

## It carried another branch into main

This branch is how `feat/media-content-type-fidelity` reached `main`. The human
explicitly authorized merging that reviewed prerequisite directly into this
feature branch, replacing the usual main-ancestor prebuild gate; it came in at
`5b2d3a37` via `git merge --no-ff`, and this branch then merged to main.

The consequence is worth knowing: **main's history NAMES
`feat/media-content-type-fidelity` without ever having merged it**, so that
branch reads as merged while continuing to advance past the point that rode in.
See
[`2026-08-26-media-content-type-fidelity/README.md`](../2026-08-26-media-content-type-fidelity/README.md).

## Layout

| directory | what is in it |
|---|---|
| `design-review/` | spec rounds 1-4 and plan rounds 1-5 (two reviewers in round 1 of each), plus the planner's adjudications |
| `review/` | spec-conformance, adversarial, the findings list, and the fix-wave re-review |
| `sdd/` | slice reports 1-8 including the focus-lifecycle and forward-scroll fixes, `worklist.md`, `handback.md`, the three research notes, and `remove-focus-retry.md` |

## What was deliberately NOT kept

The keeping rule is decisions, findings, adjudications and reasoning - not
anything recomputable from the repo.

- `review/mms-image-viewer.diff` (678KB) and `review/fix-wave.diff` - raw branch
  diffs git already holds.
- Every `*.log` / `*.exit`, including a **66MB** `sdd/final-gate-e2e.log`.
- `sdd/progress.md` - the timestamped dispatch ledger. Run state. The one
  decision inside it that mattered, the authorized prerequisite merge, is
  recorded above and survives as commit `5b2d3a37` in git.

**The three `research-*.md` files ARE kept, whole** - 0%, 0% and 4% of their
lines sit inside code blocks, and the largest opens with a Verdict and closes
with Watch items. Analytical prose citing code by reference, not a byte-exact
survey. (Contrast `2026-08-25-inbox-unread-cluster`, where the same filename
prefix meant the opposite thing.)

## Character set

`design-review/spec-round-1-b.md` carries 30 non-ASCII characters in authored
review prose, preserved verbatim.
