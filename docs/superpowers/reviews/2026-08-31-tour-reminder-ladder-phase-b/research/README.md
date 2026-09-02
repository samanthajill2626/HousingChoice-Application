# Research and briefs - recovered at cleanup (2026-09-01)

**Everything else in this record was committed by the mission itself**, as the
records rule now requires - `design-review/`, `code-review/`, `build/`, the
handbacks and self-QA all landed with the work. This directory and `../briefs/`
are the gap: they existed only in the retired worktree's gitignored
`.superpowers/sdd/`, and were promoted when the branch was retired.

Verified before promoting: every review, slice, fix-wave, handback and worklist
in the worktree was **byte-identical** to its committed counterpart under a
different name (`reports/review-adversarial.md` = `code-review/r1-adversarial.md`,
`reports/slice-1.md` = `build/slice-1.md`, and so on). Only these files were
genuinely missing, so nothing here duplicates what is already tracked.

## What is here

| file | what it is |
|---|---|
| `research-A-job.md` | `jobs/tourReminders.ts` anchor verification, the repo contract, the confirmation-conversion inventory, every reader of the manual-only kinds, and an invariant sweep of skip-reason writers/readers |
| `research-B-surfaces.md` | the dashboard and route surfaces the relabel touches |
| `research-C-relay.md` | `interpolate`/`resolveMessage`, the catalog, `relayFanOut`, `rosterEdits`, `relayAnnouncements`, and the relay tripwire inventory - its DRIFT FLAGS are at the TOP, marked blocking-first |
| `research-D-sweep-e2e.md` | the sweep script and its e2e surface |
| `confirmation-conversion-worklist.md` | the conversion worklist the job research fed |

`../briefs/` holds the charge given to each child - the four research briefs and
their common preamble, the nine slice briefs, the implementer and fix-wave
briefs, and the two review briefs. They are kept because a brief is where scope
was decided, and a finding only makes sense against what its author was asked to
look for.

## Why they were kept whole

Three of the four research files carry a `DRIFT FLAGS` section, and they run
**11-28% of lines inside code blocks** - analytical prose with illustrative
snippets, not the byte-exact surveys Phase A produced at 47-66%, which had to be
split into findings and reference. The flags also sit at inconsistent positions
(top of C, bottom of A and B, absent in D), so a mechanical split would have cut
through reasoning rather than separating it.

Compare `../../2026-08-30-tour-reminder-ladder/` for the same mission family
making the opposite call on much denser files.

## Character set

`research-C-relay.md` and `research-D-sweep-e2e.md` carry a few non-ASCII
characters in authored prose. Preserved verbatim.
