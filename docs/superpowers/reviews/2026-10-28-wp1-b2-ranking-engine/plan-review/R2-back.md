# Plan review R2 - back half (head + S5-S9, plan sections 0-4 and 9-13)

Reviewer: adversarial plan reviewer, read-only. Plan v3 at b71f2b18. I read
the round-1 diff (`git diff f3df4379 b71f2b18`) in full for sections 0-4 and
9-13, the adjudications (PR29-PR39), R1-back-A, and the S2/S3/S4 text my
slices code against. I checked the PR30/PR35/PR39 claims against
`scripts/dev.mjs`, `scripts/lib/devMode.mjs`, `scripts/secrets.mjs`,
`scripts/lib/secretsCore.mjs`, `scripts/deploy.mjs`, `app/src/lib/devRoutes.ts`
and `RUNBOOK.md`.

What holds (checked, no finding): PR35/PR39 now match the code. `.env.dev` is
loaded only in live mode (`scripts/dev.mjs:113-133`), so `.env.dev.example`'s
`RANKING_DRIVER=anthropic` never reaches `--local`. A sync emits commented
example lines verbatim and new keys blank (`secretsCore.mjs:182-187`), and
push/check refuse blanks (`secrets.mjs:160-168`). A deleted line only causes
a "missing" WARNING (`secrets.mjs:139-157`). The dev router needs a set
`DYNAMODB_ENDPOINT` (`devRoutes.ts:19`), so a live laptop never has a dev
tick that could claim hosted-dev jobs. The PR30 worker switch,
`rankingWiring`'s e2e-session pin (`e2e-session.mjs:144`), and the
`defaultCostRange` arithmetic (all four cases recomputed) are right. S7's
`finishedBatchCount` equals S5's `finishedBatchCount`. The PR38 read path
works through the existing PR13 rule. S3 does ship
`AnchorUnreadable.candidateIds` (plan 15571-15586, 15783-15786).

---

## R2-1 [MEDIUM] [DECISION] PR29 also widens UNLAWFUL-flag suppression from a field to the whole requirement item: one unlawful flag on a property's pets text switches off its lawful No pets cap for every tenant

What is wrong. PR29 (plan 461-468) and S4's `capOf` (plan 16664-16677) put
both `accommodationFields` and `openUnlawfulFields` through `itemsOf(...)`.
So an OPEN unlawful flag on any key of an item suppresses a failed
requirement on any key of that item. The cap-eligible items mix a lawful
checkbox with free text: Pets = `no_pets` (checkbox) + `pets` / `pet_fee`
(text); Evictions = `no_evictions_on_program` (checkbox) + `evictions_notes`
(text). Unlawful flags can only be raised on free-text fields (spec D5). So
when the model flags an unlawful clause inside the pets TEXT (say "no pets,
no children"), the property's lawful No pets checkbox stops capping any
pair. The flag is a property record read on every read (spec D10), so this
applies to every tenant with pets, for as long as the flag stays open.

Spec text it departs from: D9 "capped when failedRequirements holds a
cap-eligible key ... that ... is not in the pair's accommodation flags, and
has no open unlawful flag on that property"; D10 "While open, that field
caps no pair of that property". Both are per field. FB1 (the finding PR29
answers) was about ACCOMMODATION only: an assistance animal accommodated on
one key and failed on another. Nothing in FB1 calls for widening the
unlawful half, and PR29 is not listed for Cameron as a spec departure,
unlike PR30/PR37/PR39.

Fix. Use the item grouping for accommodation flags only. Keep unlawful
suppression per field, with only the `landlord:<key>` -> `<key>` mapping (as
spec D2.1 / D10 already provide). Add the capOf case: an open unlawful flag
on `pets` text does NOT suppress a failed `no_pets`. The S8 control is
unaffected, since C2 is a single-key item. If the item-wide unlawful rule is
wanted, it is a spec departure and goes to Cameron.

## R2-2 [LOW] [PRECISION] Binding PR5 still says `putMatches` returns void and throws, which contradicts PR37 and the S2/S5 code

PR5 (plan 315-316): "`putMatches(rows: MatchRow[]): Promise<void>`
(BatchWrite, unprocessed retried, throws when still unprocessed)". PR37 and
S2's revised surface (plan 3779-3784, 3887-3896) return `MatchWriteResult`
and never throw on a DynamoDB failure. Section 0 makes section-4 rulings win
over slice text, so a literal builder holds a binding ruling that
contradicts the slices. Fix: amend PR5 to PR37's signature. Also amend PR5's
`listRuns` entry to PR34's `RankingRunListPage` (summary entries,
`incomplete`).

## R2-3 [LOW] [PRECISION] S5 calls S3's PR38 field "OPEN, NOT in S3's round-1 revision", but S3 ships it

The S5 revision note (plan ~21249) and 9.2 (plan ~21462-21468) say S3 lacks
`AnchorUnreadable.candidateIds` and that "the planner routes the two-line S3
change". S3 already publishes and implements it (plan 10093, 15571-15586,
15785) and tests it (15276-15292). A builder following S5 may edit S3 a
second time or code a fallback. Fix: replace the note with "matched in S3's
revision", and drop the S5.10 report placeholder "<state whether S3's
AnchorUnreadable.candidateIds landed>".

## R2-4 [LOW] [PRECISION] PR37: a partially written batch drops its omitted count from the job message, and its copy says the batch "could not be scored"

In `runBatch` (plan ~24346-24360), when `unwritten` is non-empty the batch
returns `{ kind: 'failed', failure: 'repo' }` but writes `notScored` for its
omitted candidates. `runJob`'s message sums `omitted` from `'scored'`
outcomes only (plan ~23378). So those omitted candidates are on the record
but missing from "N tenants were not scored by the model". The same batch
then counts in `failedBatchesMessage` ("1 of 3 batches could not be scored")
and in S7's status ("..., 1 failed"), even when 39 of 40 rows landed and the
table shows them fresh. Fix: carry `omitted` (and `written`) on the failed
outcome. Give a `'repo'` partial write its own sentence, for example "N
scores could not be saved. Press Rank again.", and show it in S7's status
alongside the not-scored count rather than as a failed batch.

## R2-5 [LOW] [PRECISION] PR36's guard retries with no pause, and a guard failure at the last check marks a fully scored job `failed`

The retry runs back to back (plan ~24903-24930). The error PR36 names is
throttling (the test throws `ProvisionedThroughputExceededException`), and
that rarely clears in the same tick, so one blip still fails the job. Also,
`runJob`'s pre-finish `if (!(await guard())) return;` runs after every batch
has written. If that check fails twice, the guard writes
`failed`/MSG_ERROR over a job whose matches all landed. Fix: wait briefly
before the retry (a few hundred ms, as S2's repo backoffs do). On the
pre-finish path, a guard that cannot read should finish `done` with the
batches' message, or `failed` with a message saying the scores were saved.

## R2-6 [LOW] [PRECISION] PR34's bounded cost default is skipped when only `to` is set, which brings back the all-time read

S6 (plan ~26223-26226 and the cost handler): "one bound given is used as
given". With only `to` set, `listRuns` has no lower bound and walks every
ranking run up to `to` (up to 50 pages), which is the unbounded read PR34
was meant to stop. The page also shows no range note in that case
(`defaultRange` is false). Fix: when only `to` is given, set `from` to the
12-ISO-week start before `to`, and show the range the server used (or echo
it in the response).

## R2-7 [LOW] [PRECISION] PR36: a putRun failure after a FAILED call records `'repo'` and loses the call's own failure

`putRun` runs before `if (!call.ok)` (plan ~24277-24290). When the call
itself failed (timeout, refusal) and the run write then throws, the batch is
recorded as `failure: 'repo'`. The real reason is then on neither the run
(never written) nor the job, and only the error log line has it. Fix: use
`call.ok ? 'repo' : call.failure` for the failedBatch, and keep `call.failure`
on the log line.

## R2-8 [LOW] [PRECISION] `.env.example`'s new comment says live mode makes "real calls on .env.dev's ANTHROPIC_API_KEY" from the laptop

Plan ~37836-37848. On real tables the laptop's worker poll is off and the
laptop has no dev router, so it makes no model call. The press queues a
job, and the DEPLOYED dev worker scores it on the dev stack's own key. The
RUNBOOK caveat (S8.8 Step 3b) says this correctly. The example comment
should match, so nobody puts a key in `.env` expecting the laptop to call
the API.

---

## Adjudications contested / conceded

- PR36 (drop the paid scores when `putRun` fails, rather than writing the
  matches anyway): conceded. Matches whose `runId` points at no run would
  break the run detail link, and the spend is logged.
- PR37, PR38, PR34, PR35/PR39, BB5, BA3/FB4: conceded as fixes. R2-4, R2-6
  and R2-7 are precision edits on top of them.
- PR29: contested for its unlawful half only (R2-1). The accommodation half
  is right.
