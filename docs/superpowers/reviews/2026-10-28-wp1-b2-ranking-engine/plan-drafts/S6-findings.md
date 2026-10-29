# S6 plan-draft findings - the read and the API

Drafter: S5/S6 section drafter, 2026-10-28. Draft:
`.superpowers/sdd/plan-draft-S6.md` (plan section 10).

## S6-F1. Where the WI18 5-second budget is enforced

- WI18: "The 150-tenant property read completes under 5 s on the hermetic
  stack; the measurement and its number are in the S6 report. A miss is
  fixed in S6 (batch the per-tenant reads), never by dropping the
  out-of-date test." Spec D9 says the same.
- The tree: the hermetic stack's database is DynamoDB Local, which the app
  suite shares across ~53 integration files; AGENTS.md records loaded runs
  of 446-509 s against 75-95 s and an explicit-key regime that collapses
  every file onto one write lock. A wall-clock assertion inside `npm test`
  measures that contention, not the read.
- Draft's choice (Task S6.5): the 150-tenant case runs in every `npm test`
  with a 20 s ceiling (catches a gross regression, never flakes on
  contention); the 5 s budget is asserted under `RANKING_READ_BUDGET=1`,
  which the S6 task runs ALONE and records in the report (three timings).
- Ruling needed: accept the split, or require the 5 s assertion in the
  shared gate run (accepting the flake risk), or move the strict
  measurement to the S9 self-QA on the hermetic lane.

## S6-F2. A WI18 miss is fixed in S3's files

- WI18 assigns the fix to S6 ("batch the per-tenant reads"); the reads it
  would batch (each tenant's `listByContact`, `listByTenant`, the seen-units
  BatchGet, the placements read) live in S3's `assemble.ts`, `seenSet.ts`
  and `pairHistory.ts` (PR2).
- Draft's choice: Task S6.5 Step 3 measures first and, only on a miss,
  stops for the planner's ruling before editing S3's files.
- Ruling needed: pre-authorize S6 to touch those three S3 files for this
  purpose only, or route a miss back to S3's owner.
