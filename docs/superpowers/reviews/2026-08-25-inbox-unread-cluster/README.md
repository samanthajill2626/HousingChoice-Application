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

`review/diff-package.md` and `review/rework-diff-package.md` (151KB + 217KB).
They are raw diffs of the branch and are reconstructable from git history, so
they were dropped rather than committed.

## A note on character set

Three files under `sdd/` contain non-ASCII bytes - vitest `+` result marks in
captured terminal output, and arrows or em dashes inside quoted test names.
These are preserved VERBATIM. The repo's ASCII-only rule governs newly authored
spec, plan, issue and log text; rewriting captured tool output to satisfy it
would falsify the record.
