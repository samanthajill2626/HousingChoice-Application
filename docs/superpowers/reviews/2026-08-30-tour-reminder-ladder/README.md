# Mission record - tour reminder ladder, Phase A (`feat/tour-reminder-ladder`)

Preserved 2026-09-01 when the branch and its worktree were retired. These files
lived under the worktree's gitignored `.superpowers/`.

**This is a point-in-time record, and Phase A is only half the story.** The
design and plan are frozen at
[`2026-08-26-tour-reminder-ladder-design.md`](../../specs/2026-08-26-tour-reminder-ladder-design.md)
and [`2026-08-26-tour-reminder-ladder.md`](../../plans/2026-08-26-tour-reminder-ladder.md).

**Phase B is LIVE and continues this work on the same five files**, naming
Phase A's spec as its predecessor - see
[`2026-08-31-tour-reminder-ladder-phase-b-design.md`](../../specs/2026-08-31-tour-reminder-ladder-phase-b-design.md).
A third effort, tour-reminder supersession cleanup, is parked behind it on the
same seam. Read those before treating anything here as settled.

## Layout

| directory | what is in it |
|---|---|
| `design-review/` | two plan generations - the original rounds 1-3, then a re-planned v2 with rounds 1-4 and two reviewers in v2 round 1 - plus spec adversarial rounds 2-5 and the planner's adjudications |
| `review/` | conformance review A, adversarial review B and its round 2, the fix-wave report, adjudications |
| `sdd/` | nine slice reports, `worklist.md`, `handback.md`, and the six research findings extracts |

## What was deliberately NOT kept

The keeping rule is decisions, findings, adjudications and reasoning - not
anything recomputable from the repo.

- `review/diff-package.md` - **995KB**, the raw branch diff git already holds.
- `sdd/progress.md` - the timestamped dispatch ledger. Run state.
- **The reference half of all six research files.** They totalled 449KB and ran
  **47-66% inside code blocks** - explicitly byte-exact surveys ("full quote",
  "byte-for-byte", "WHOLE function"). Each carried a `## DRIFT` (plan/spec vs
  the live tree) and `## GAPS` (what the change breaks that the plan omits)
  section at the tail, at **13-23% of the file**. Those findings are kept as
  `sdd/research-*-findings.md`, each with a provenance header; the quotation was
  dropped.

That split is the `one file, one kind` rule doing its job at scale: keeping the
files whole would have committed ~360KB of code quotation, and dropping them
whole would have destroyed six DRIFT/GAPS sections - the only record of where
the plan disagreed with the tree.

## Character set

Nine files carry non-ASCII characters (em dashes and similar, ~1.4KB total) in
authored research and review prose. Preserved verbatim - the ASCII rule governs
newly authored repo text, not a frozen record of what someone wrote.
