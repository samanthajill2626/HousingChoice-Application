# Mission record - inbox unread cluster (`feat/inbox-unread-cluster`)

Preserved 2026-08-27 when the branch and its worktree were retired. These files
were written under the worktree's gitignored `.superpowers/` directory, so
without this promotion they would have been destroyed by the cleanup.

**This is a point-in-time record, not current documentation.** The design and
plan it refers to are frozen at
[`2026-08-25-inbox-unknown-tab-walk-design.md`](../../specs/2026-08-25-inbox-unknown-tab-walk-design.md)
and
[`2026-08-25-inbox-unknown-tab-contact-side-read.md`](../../plans/2026-08-25-inbox-unknown-tab-contact-side-read.md).
For current truth read the code.

## Why this one is worth keeping

A first build passed all five gates AND a clean spec-conformance review, and was
called merge-ready. A plan-blind adversarial round then returned **NOT
MERGE-READY with 3 HIGH findings - none of which were build defects.** They were
consequences of decisions the spec itself had authorised. The rework that
followed (cursor-paged and unbounded, untriaged-first, sweep deleted) is the
work the second half of these files describes.

That sequence is the reason the review files are kept rather than summarised:
the interesting artifact is the disagreement between two reviews of the same
correct-to-spec code, which no summary preserves.

## Layout

| directory | what is in it |
|---|---|
| `design-review/` | spec and plan review adjudications, pre-build |
| `review/` | spec-conformance, both adversarial rounds, the blast-radius and paging re-reviews, and every adjudication |
| `sdd/` | per-slice build reports, fix-wave reports, research notes, worklist, self-QA, handback |

## What was deliberately NOT kept

The keeping rule is **decisions, findings, adjudications and reasoning** - not
anything a reader could recompute from the repo.

- `review/diff-package.md` and `review/rework-diff-package.md` (151KB + 217KB) -
  raw diffs of the branch, reconstructable from git history.
- The REFERENCE half of the three research files (190KB total). These files were
  internally split: a drift/corrections section stating what the plan and spec
  got WRONG, then per-file byte-exact quotation of the tree. Measured, the
  findings were **10%, 11% and 0%** of each file - the third was 83KB of pure
  quotation with no findings at all. The findings halves are KEPT, extracted to
  `sdd/research-*-findings.md`; the quotation halves were dropped as
  recomputable from the commits those findings cite. **`worklist.md`'s pointers
  to `.superpowers/sdd/research-*` are therefore dead links** - deliberately
  left unedited rather than rewriting a historical record.

  This one file is why the workflow now tells researchers to emit findings and
  reference as SEPARATE artifacts at authorship. Dropping a mixed file whole
  loses findings; keeping it whole commits 90% waste; and bisecting it later
  depends on someone re-reading 66KB to find the seam.
- Every `*.log`, `*.exit` and `*.pid` from the gate and session runs.

## A note on character set

Three files under `sdd/` contain non-ASCII bytes - vitest `+` result marks in
captured terminal output, and arrows or em dashes inside quoted test names.
These are preserved VERBATIM. The repo's ASCII-only rule governs newly authored
spec, plan, issue and log text; rewriting captured tool output to satisfy it
would falsify the record.
