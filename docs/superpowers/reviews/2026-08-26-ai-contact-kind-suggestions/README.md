# Mission record - AI contact-kind suggestions (`feat/ai-contact-kind-suggestions`)

Preserved 2026-08-27 when the branch and its worktree were retired. These files
lived under the worktree's gitignored `.superpowers/`, so without this promotion
the cleanup would have destroyed them.

**This is a point-in-time record, not current documentation.** The design and
plan are frozen at
[`2026-08-26-ai-contact-kind-suggestions-design.md`](../../specs/2026-08-26-ai-contact-kind-suggestions-design.md)
and
[`2026-08-26-ai-contact-kind-suggestions.md`](../../plans/2026-08-26-ai-contact-kind-suggestions.md).
For current truth read the code.

## What it covers

Eight slices, each with a brief, an implementer report, a review, and where
needed one or more re-reviews after a fix: canonical `ContactKind` /
`SuggestedContactKind` unions and parser validation (S1), monotonic
classification revisions with revision-fenced verdict persistence (S2),
extraction-time retraction of stale type suggestions (S3), PATCH reconciliation
for every known suggested kind including race proofs (S4), the Tenant /
Landlord / Property Manager / Partner dashboard choices (S5), runtime extraction
activated only AFTER its consumers existed (S6), and focused end-to-end coverage
(S7). `sdd/build-log.md` is the one-screen version of that sequence.

The design review ran four rounds on the spec and four on the plan, with two
independent reviewers in round 1 of each.

## Layout

| directory | what is in it |
|---|---|
| `design-review/` | spec rounds 1-4 and plan rounds 1-4, plus the planner's adjudications |
| `sdd/` | per-task briefs, implementer reports, reviews and re-reviews; fix reports; the final adversarial and spec reviews with their adjudications; `worklist.md` (live-tree delta and the contracts to preserve byte-for-byte); `build-log.md`; `handback.md` |

## What was deliberately NOT kept

The keeping rule is **decisions, findings, adjudications and reasoning** - not
anything recomputable from the repo.

- `review/final-3c2962a4..49146fba.diff` (332KB) - the branch diff, which git
  already holds.
- Both progress ledgers (`sdd/progress.md`, 33KB, and its per-task counterpart).
  These are timestamped dispatch bookkeeping - when a child was spawned, which
  SHA it reported, which file to read next - and every durable fact in them is
  either a commit git has or a report kept here. Run state, not reasoning.

**The three `research-*.md` files ARE kept, whole.** That is the opposite call
from the neighbouring `2026-08-25-inbox-unread-cluster` record, and the
difference is the point: those research files were a thin drift section on top of
a byte-exact survey (10%, 11% and 0% findings), while these are compact
analytical prose that cites code by `file:line` instead of pasting it - 0%, 14%
and 0% of their lines sit inside code blocks. Same filename prefix, opposite
disposition, because the rule is about what a file IS, not what it is called.

## Character set

Two files carry a few non-ASCII characters (21 in total) in authored review
prose. Preserved verbatim - the ASCII rule governs newly authored repo text, and
editing a frozen record's wording to satisfy it would misrepresent what was
written.
