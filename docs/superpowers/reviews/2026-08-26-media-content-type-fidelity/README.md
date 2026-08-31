# Mission record - inbound media content-type fidelity (`feat/media-content-type-fidelity`)

Recovered 2026-08-27 from the worktree's gitignored `.superpowers/`. This mission
ran BEFORE records were written to a tracked path, so these files existed only
inside `W:\tmp\media-content-type-fidelity` and would have died with it.

**This is a point-in-time record, not current documentation.** The design and
plan are at
[`2026-08-26-media-content-type-fidelity-design.md`](../../specs/2026-08-26-media-content-type-fidelity-design.md)
and
[`2026-08-26-media-content-type-fidelity.md`](../../plans/2026-08-26-media-content-type-fidelity.md).
For current truth read the code.

## Branch status - READ THIS BEFORE ASSUMING IT SHIPPED

The bulk of this work reached `main` **indirectly**: it was merged into
`feat/mms-image-viewer` at `5b2d3a37` and rode in from there, so `main`'s history
names the branch without ever having merged it directly. The merge base is
`e3a97e77`, which is exactly the tip the handback below calls MERGE-READY.

**The branch is NOT fully merged.** Three commits made after that point are still
only on the branch as of 2026-08-27:

| commit | what |
|---|---|
| `15498eff` | `fix(backfill)`: refuse unknown argv; stop the pool on an S3 failure |
| `9c18a3e7` | `fix(dashboard)`: essence-match PDF at all three render sites |
| `474c3aa4` | `docs(issues)`: file four findings from the retroactive review |

Two are real fixes carrying tests; the third files
`backfill-scan-pulls-message-bodies`,
`inbound-media-content-type-index-mismatch`,
`media-mirror-reverts-backfilled-types` and
`outbound-email-attachment-filename-unsanitized`. The branch and its worktree
were therefore LEFT IN PLACE - only these records were harvested.

Also outstanding, and human-run: the content-type **backfill** (dev then prod,
after each deploy, `--dry-run` first).

## Why this record is worth keeping

The planner's independent merge verdict **never ran** - both reviewers died on a
weekly API limit - so the work reached `main` without the final adversarial gate
the pipeline is built around. The four issues filed in `474c3aa4` came out of a
later retroactive review. That makes the review history here the closest thing
to the verdict that was skipped, rather than a formality after the fact.

## Layout

| directory | what is in it |
|---|---|
| `design-review/` | spec rounds 1-4 and plan rounds 1-3 (two reviewers in round 1, one continued after), plus the planner's adjudications |
| `review/` | spec-conformance, adversarial, planner-side conformance and adversarial passes, and the re-review of the fix diff |
| `sdd/` | seven slice reports, two fix-wave reports, worklist, progress ledger, handback |

## Character set

Four files carry a handful of non-ASCII characters (25 in total: ellipses, `S`
section signs, em dashes) in **authored review prose** - not, as in the
neighbouring inbox-unread-cluster record, captured tool output. They are
preserved verbatim anyway: rewriting a frozen record's wording to satisfy a rule
aimed at newly authored repo text edits history to look like something it was
not. The ASCII rule still binds anything written from here on.
