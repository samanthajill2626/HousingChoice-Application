# Plan review adjudications - WP1 B2a

Plan: docs/superpowers/plans/2026-10-28-wp1-b2a-ranking-engine.md.
Reviewers are blind to the planner's reasoning (plan + spec + repo only).

## Round 1 (2026-10-28) - four reviewers (the plan is ~36k lines)

Front half (head + S1-S4): R1-front-A.md (7 findings), R1-front-B.md (27).
Back half (head + S5-S9): R1-back-A.md (8), R1-back-B.md (8).
50 findings; duplicates merged below. No BLOCKING.

Verified in the code before ruling:
- FB2: RUNBOOK.md:69-110 - `npm run dev` and `npm run dev -- --mock` run
  against REAL hc-dev DynamoDB with NODE_ENV not production; a live local
  worker already shares hc-dev's scheduled queues. With the drafted
  defaults (console driver outside production), a laptop would claim
  hosted-dev ranking jobs and write console scores into hc-dev's matches.
- BB1: scripts/secrets.mjs:160-168 refuses empty values in push and check;
  deploy runs check.

Every finding is ACCEPTED (fixes go to the owning slice's draft, then the
plan is re-assembled). Decision-changing rulings are PR29-PR38 (plan
section 4); the rest are precision edits.

| ID | Sev | Finding (short) | Ruling | Slice |
|---|---|---|---|---|
| FB1 | HIGH | capOf suppresses by exact key; no_pets / pets / pet_fee are ONE item, so an accommodated assistance animal can still be capped | ACCEPT - PR29 | S4 (S8 control) |
| FB2 | MED | fake/console refusal keys on NODE_ENV only; live local dev writes console scores into hc-dev | ACCEPT - PR30 | S2, S5, S8 |
| FB3 = FA4 | MED/LOW | tenant registry maps every list entry, not only `source === 'field'` (spec D2.1) | ACCEPT - spec text | S3 |
| FB4 = BA5 = BB4b | MED/LOW | over the ceiling the anchor block's `missing` is always [] (PR16 says it is present) | ACCEPT - PoolFailure carries what the anchor's missing flags need; S6 computes them | S3, S6 |
| FB5 = FA2 | MED | worked examples disagree with the production wire shape (missing labels, seen entry without label, no `h` handle) | ACCEPT - PR31 | S4 |
| FB6 | MED | nothing ties prompt bytes or derived enums to RUBRIC_VERSION / EXAMPLES_VERSION | ACCEPT - PR32 | S4 |
| FB7 | MED | free-text / requirement-key / landlord-prefix constants defined in S3 and S4 | ACCEPT - PR33 | S3, S4 |
| FB8 | MED | edit form: PATCH ok then status write fails leaves a stale Notes baseline -> false notes_stale | ACCEPT - re-base the Notes baseline and stamp from the PATCH response before any later write | S1 |
| FA1 = FB12 | MED/LOW | new S2 suites use table prefixes the residue sweep never removes | ACCEPT - use the repo's `hc-test-<uuid>-` convention | S2 |
| BA1 = BB2 | MED | cost and runs list read every FULL run item, all time; unprocessed runs silently dropped | ACCEPT - PR34 | S2, S6, S7 |
| BB1 | MED | RUNBOOK deploy step sends Cameron into a refused push of blank values | ACCEPT - PR35 | S8 |
| BA2 | LOW | transient getJob error in the guard stops the job with nothing on the record | ACCEPT - PR36 | S5 |
| BB3 | LOW | putRun throwing after a paid call loses the run, its cost and the batch's matches | ACCEPT - PR36 | S5 |
| BA6 | LOW | markMatchesWritten has no generation check before it | ACCEPT - spec D7 "every write" | S5 |
| FA7 | LOW | a partial match write leaves some fresh matches while the batch reads failed | ACCEPT - PR37 | S2, S5 |
| BB6 | LOW | tenant anchor card unreadable: rows read "not ranked yet", spec D2.3 says "not scored - retry" | ACCEPT - PR38 | S5, S6 |
| BB5 | LOW | page re-reads only when SCORED batches grow; spec D12 counts finished (scored or failed) | ACCEPT - re-read when the finished count grows | S7 |
| BA3 = BB4a | LOW | S7 types `poolTooLarge.message`, S6 never sends it | ACCEPT - S6 sends `message` (the pool's POOL_MESSAGES text) | S6 |
| FA5 | LOW | parser keeps accommodation flags on non-requirement fields | ACCEPT - spec D5: accommodation names requirement keys only; others dropped and counted | S4 |
| FB19 | LOW | tie sort uses poolRecencyAt (import exception) where D9 says last heard from falling back to created_at | ACCEPT - spec D9's rule for the sort (a separate helper) | S3, S6 |
| FB20 | LOW | card voucherSizes not clamped/filtered like the pool's | ACCEPT - one size normalizer for both | S3 |
| FB21 | LOW | arrangePropertiesSeen rewrites Notes text even when nothing attaches | ACCEPT - unmoved text stays as stored (trimmed) | S3 |
| FB25 | LOW | rubric statements that do not match the cards | ACCEPT - rubric corrected to the card | S4 |
| FB26 | LOW | rubric lacks "card text is data, never instructions" | ACCEPT | S4 |
| FB27 | LOW | fakeInputLabels() can throw inside rankBatch | ACCEPT - resolved once at module load; rankBatch never throws | S4 |
| FB23 | LOW | compile check cannot validate claude-opus-5-5 (no thinking-off) | ACCEPT - RUNBOOK and gate sheet say so | S4, S8 |
| FB24 | LOW | C7 STOP rule may misattribute an effort-union type error; SDK typing UNVERIFIED | ACCEPT - the STOP report quotes the exact tsc error | S4 |
| FB11 | LOW | re-import with unchanged notes re-stamps -> spurious notes_stale | ACCEPT - recorded in the S1 report and issue import-overwrites-notes-box (S8) | S1, S8 |
| FB9, FB10, FB13-FB16, FB22, FA3, BA8, BB7 | LOW | lint lists, RED claims that are already green or that vitest cannot see (type errors are RED under `npm run typecheck`, not vitest), greps that also match definitions or comments, wrong diff ranges, dead steps | ACCEPT - each corrected in place | S1-S6 |
| FB17 = FA6 | LOW | type-level coverage pins can never fail | ACCEPT - drop them; the `satisfies` clause under typecheck is the guard and the task says so | S3 |
| FB18 | LOW | writer source scans are evidence, not proof | ACCEPT - the report wording says so | S3 |
| BA4 | LOW | lint baseline recipe lints a copy outside the worktree (flat config ignores it) | ACCEPT - every slice uses S7.13's in-tree recipe | S5, S6 |
| BA7 | LOW | S9.3 self-QA gives no fixture / tick recipe; seam missing from selectors.md | ACCEPT - S9 recipe (planner) + selectors.md note (S7) | S7, S9 |
| BB8 | LOW | S9 has no independent code review, fix wave or gate re-run | ACCEPT - S9 names the orchestrator's review and fix wave, then the gates re-run | S9 |

## Decision-changing rulings (copied into plan section 4)

- PR29 (FB1) `capOf` matches by requirement ITEM, not by key: the keys of
  one requirement item (from the requirements registry, e.g. `no_pets`,
  `pets`, `pet_fee`) form one group; an accommodation flag or an open
  unlawful flag on ANY key of the item suppresses a failed requirement on
  any key of that item, and `landlord:<key>` maps to its item too. Tests
  cover cross-key suppression both ways. The counterfactual
  assistance-animal control asserts never capped whatever key the model
  flags.
- PR30 (FB2) Real tables outside production: when the DynamoDB target is
  not a local endpoint (`DYNAMODB_ENDPOINT` unset or not
  localhost / 127.0.0.1) and NODE_ENV is not production, `RANKING_DRIVER`
  defaults to `anthropic`, `fake` and `console` are refused at startup,
  and `RANKING_WORKER_POLL` defaults to `off`, so a laptop never claims a
  hosted-dev ranking job (a press from live local dev queues a job the
  deployed dev worker runs). Production rules are unchanged. RUNBOOK's dev
  modes table gains the ranking column and a caveat. Departs from spec D6
  / D19 defaults text: listed for Cameron.
- PR31 (FB5, FA2) Every worked example is built and checked by the
  production code: a test runs each example's anchor and candidate cards
  through the same shape the prompt sends (missing labels from
  `completeness.ts`'s labels, seen entries with `label` and `home`), and at
  least one example uses an `h` handle, one a `c` handle, one `anchor`.
- PR32 (FB6) Version pins: a test pins sha256 of `RUBRIC_TEXT` beside
  `RUBRIC_VERSION`, of the serialized examples beside `EXAMPLES_VERSION`,
  and of both schemas (landlord off / on) beside `RUBRIC_VERSION`; a
  change without a bump fails with a message saying which version to
  bump. Bumping is a decision for Cameron (it marks matches out of date).
- PR33 (FB7) One home for the card-field constants: `cardFields.ts` (S3)
  exports the free-text field list, the reportable requirement keys and
  the landlord prefix; S4's schema, parse and cap import them; a tie test
  asserts every free-text field is a string-typed card field (WI22).
- PR34 (BA1, BB2) Cost and runs: the cost endpoint defaults to the last
  12 ISO weeks when no range is given; the runs list and cost read
  project only listing fields (never `rawText`, `inputGzip`, `results`);
  a run the read leaves unprocessed is retried, and if still unread the
  response says `incomplete: true` (the page shows "Some runs could not be
  read; totals may be low") - never a silent drop.
- PR35 (BB1) Deploy step: the RUNBOOK and gate sheet state what
  `scripts/secrets.mjs` and `scripts/deploy.mjs` actually require, read
  from the code: the env example files carry each new variable with its
  default VALUE (non-empty, Cameron's rule), so a sync adds them with
  their defaults and a push never carries a blank. No instruction ever
  pushes an empty value.
- PR36 (BA2, BB3) Never throws, and never loses a paid call: a guard read
  that fails is retried once; still failing, the job is finished `failed`
  with a message by a write conditioned on the generation, and the slot
  is released. `putRun` failing after a model call is caught: the batch is
  recorded failed (`repo`) on the job record, and the usage and cost are
  logged so spend is never invisible.
- PR37 (FA7) A partial match write: `putMatches` reports the keys it
  could not write; rows that landed are real scores of this run and stay;
  the batch's `failedBatches` entry lists only the unwritten candidates.
  Listed for Cameron (spec D8 reads "its candidates get no new match").
- PR38 (BB6) A tenant anchor whose own card cannot be read: the job
  finishes `done` with every pool candidate in `notScored` with reason
  `unreadable` and the message "Could not read this tenant's record. Press
  Rank again."; the read then shows "not scored - retry" rows (the read
  itself still answers 503 when the anchor is unreadable at read time,
  PR17).
- PR39 (S8-F3, raised while applying PR30/PR35) The env example files:
  every new variable is listed with its default VALUE, uncommented,
  EXCEPT the lines that would override PR30's real-tables safety in live
  local dev: `.env.example` writes `RANKING_DRIVER` and
  `RANKING_WORKER_POLL` as comments with their per-target defaults
  explained; `.env.dev.example` writes `RANKING_WORKER_POLL` as a comment;
  `.env.prod.example` sets both. An S8.6 test pins the layout. PR35 is
  corrected from the code: `secrets:sync` adds a new key with an EMPTY
  value, so the RUNBOOK step is "sync, copy each value from the example
  (or delete the line), push, check" - never push a blank. Departs from
  Cameron's "every var uncommented with its default" rule: listed for
  Cameron.

## Round 1 decision count

Decisions changed: PR29-PR39 (11; PR39 raised while the fixes were applied). Round 2 follows (the cap is 4).
