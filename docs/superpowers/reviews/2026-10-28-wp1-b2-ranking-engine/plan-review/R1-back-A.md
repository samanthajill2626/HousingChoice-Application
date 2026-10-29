# Plan review R1 - back half A (plan sections 9-13: S5, S6, S7, S8, S9)

Reviewer scope: plan `docs/superpowers/plans/2026-10-28-wp1-b2a-ranking-engine.md`
lines 19957-36475 read in full for S5, S6, S9 and the S7 / S8 task bodies
(S7.1-S7.6, S7.9-S7.13, S8.2, S8.6, S8.10, S8.11 read line by line; S7.7/S7.8
and S8.1/S8.3/S8.4/S8.5/S8.8/S8.9 read for their interfaces and the rules the
gate depends on). Sections 0-4 and the spec read in full. Repo read at
main @404e039d (no node_modules; nothing run).

Overall: the back half is unusually tight. Nearly every anchor the S5-S7
tasks quote exists verbatim in the tree (checked below), the S5 job code
and its fake model the S2 conditions faithfully, and the S5/S6/S7 wire
names agree with each other. The findings are therefore few and mostly
LOW; one MEDIUM is a real scaling defect that the tests cannot see.

---

## F1. [MEDIUM] Cost totals (and the runs list) read every FULL run item, over an unbounded default range, and silently drop unread runs from the totals

What is wrong. `GET /api/admin/rankings/cost` (S6.4, plan 26967-27015) pages
`runs.listRuns({ entityKey: rankings#global, limit: 100 })` up to
`MAX_COST_PAGES = 50` (5,000 runs). S2's `listRuns` (plan 8488-8540) answers
each page with ONE BatchGetItem of the full `rrun#` items (`batchGetRuns`,
plan 8416-8434) - no ProjectionExpression - so every run's `rawText`,
`inputGzip` (the gzipped user message of up to 40 tenant cards plus every
seen home's full property card), `handles` and `results[]` are read just to
sum `costUsd` and two token counts. The page asks for that cost on every
open with no date range: `RankingsSection` passes `from` / `to` straight
from the URL (plan 31669-31675), both undefined by default, and the server
then applies no bound (`dateRange`, plan 26757-26768). The runs list does
the same per 25-row page (plan 26842-26851).

Separately, the cost loop skips every `expired` entry (plan 26987
`if (entry.expired) continue;`), and S2 returns a run whose key was still
unprocessed after the BatchGet retries as `{ expired: true, unavailable:
true }` (plan 8536-8538). Such a run is dropped from `totalUsd` and its week
with no signal: `truncated` is set only by the page cap (plan 27001-27004).

Evidence. Plan lines above; spec D11 (the run stores `rawText`, `inputGzip`
up to the 350 KB guard, `handles`, `results[]`), D12 (cost "totals by ISO
week and by environment"), D18 ("weekly cost totals ... above the list").

What it implies. A 40-candidate run item is plausibly ~100 KB or more
(gzipped base64 input plus raw output plus results). Once B3 makes presses
routine, a 180-day TTL of runs makes one Rankings tab open read hundreds of
MB from DynamoDB (cost and latency), and BatchGet's 16 MB response cap makes
unprocessed keys - and therefore silently under-counted cost - more likely,
on the one page whose job is to show what ranking costs. No S6/S7 test sees
it (the fakes return small records).

Fix. (a) Read summaries, not items: give S2's `listRuns` a summary mode
(BatchGet with a ProjectionExpression of the list/cost fields:
`runId, startedAt, finishedAt, anchorKind, anchorId, direction, batchIndex,
candidateCount, driver, model, costUsd, latencyMs, outcome, failure,
environment, usage`), used by both the runs list and the cost route; only
`getRun` reads the whole item. (b) Count `unavailable` entries in the cost
route and return them (`incomplete: n`, or set `truncated`), and show it on
the page. (c) Default the page's cost range (for example the last 12 ISO
weeks) when the URL carries none. (a) is an S2 change - a cross-slice note
for the planner.

---

## F2. [LOW] A transient error on the generation check silently stops the job and records nothing

What is wrong. `rankAnchor`'s `guard()` (plan 23402-23415) treats a THROWN
`getJob` (throttling, a network blip) exactly like a superseded generation:
`stopped = true`, an error log, and every later write is skipped -
including `finishJob`. The record is left `running` with nothing on it.

Evidence. Spec D7: "on a different generation the job exits quietly" and
"Never throws: a model, batch, pool or organization-list failure is
recorded on the record ... and the job finishes." A read error is not a
different generation, and it is not recorded. The lease-renewal stop (plan
23418-23430) is spec-sanctioned ("a renewal that fails stops the job"); the
guard's error path is not.

What it implies. In production the record sits `running` until its lease
lapses (90 s), then the poll takes it over and re-runs EVERY batch from the
start (a second full model spend); a second blip marks it failed with "The
ranking stopped before it finished". On the hermetic lane (poll off) the
page shows "Ranking: n of m" until some later tick past the lease. Rare
(the SDK already retries), hence LOW.

Fix. On a thrown guard read, retry once; if it still throws, try
`finishJob(job, 'failed', MSG_ERROR)` (itself conditional on the
generation) before stopping, so the failure is on the record as D7 says.
Add one rankAnchor case (getJob rejects once mid-job).

---

## F3. [LOW] S7's `poolTooLarge` type carries a `message` the server never sends, and S7.13 tells the builder to confirm it

What is wrong. S7.1 types `poolTooLarge?: { size: number; message: string }`
(plan 28053) and the panel test feeds one (plan 30001); S6 sends
`poolTooLarge: { size }` only (plan 25745; PR16 "poolTooLarge: { size }";
rankingsApi test plan 26072-26075). The panel renders from `size` alone
(plan 30179), so nothing breaks at runtime - but S7.13 step 5 orders the
builder to "confirm against S5's and S6's committed code that every field
of S7.1's types is what the server sends (... `poolTooLarge.message` on the
read ...)" (plan 32628-32633), and the S7 coverage row repeats
`poolTooLarge { size, message }` (plan 32688). A literal builder finds the
drift and "fixes" it - most likely by adding a message to S6's read, which
S6's own tests pin as absent.

Fix. Drop `message` from the S7.1 type, the panel test fixture, the S7.13
checklist and the coverage row; the page already builds the copy from
`size` (spec D1's "Pool too large to rank (N candidates)").

---

## F4. [LOW] The S5 / S6 lint-baseline recipe lints a copy OUTSIDE the worktree, which ESLint's flat config does not lint

What is wrong. S5.10 step 2 and S6.6 step 2 attribute errors in the
pre-existing files (`api.ts`, `dev.ts`, `worker.ts`, `sse.test.ts`,
`eventBridge.test.ts`) by `git show <tip>:<path>` "into a temp file OUTSIDE
the worktree, linted with the root config" (plan 24434-24441, 27467-27472).
`eslint.config.mjs` selects rules by repo-relative globs (`**/*.ts`,
`app/src/**/*.ts` at eslint.config.mjs:15 and :75). A file outside the
config's base directory is reported "File ignored because outside of base
path" (ESLint 9 flat config; UNVERIFIED by running - no node_modules), so
the baseline is empty and the comparison is meaningless; even an in-repo
path elsewhere would miss the `app/src/**` block. S7.13 uses an in-tree
sibling copy instead (plan 32580-32586), which does work - the slices
disagree.

What it implies. Low today (the 23 known errors are all dashboard
`react-hooks/*`, AGENTS.md gate 5), but the recipe would mis-attribute the
first real app-side error.

Fix. One recipe for every slice: write the base version beside the
original under the same directory (S7.13's method, e.g.
`app/src/routes/.lint-base-api.ts`), lint, diff, delete; or a temporary
`git worktree add` at the base commit, removed afterwards.

---

## F5. [LOW] Over the ceiling the anchor block's `missing` is always empty

What is wrong. PR16 says the over-ceiling read keeps "the anchor block
present (display, `anchorNotes`, missing)". S6's resolution (contradiction
5, plan 24610-24614; code plan 25729-25747) returns `missing: []` because
`PoolFailure` carries no card. The anchor's flags are computable from what
the failure does carry: `propertyMissing(anchorRecord, ctx)` /
`tenantMissing(anchorRecord)` (S3, plan 9397-9398) need only the record
(and, for a property, the org entries the pool read).

What it implies. The one case where the page shows no table (a pool over
300) is also the case where it hides the anchor's missing-data flags, which
are exactly what a staff member would fix first. Spec D9 lists "its missing
flags (D3)" in the anchor block without exception.

Fix. Either have S3's `PoolFailure` for `pool_too_large` carry `missing`
(computed where the pool already holds the record and org entries), or
note the departure from PR16's wording in the S6 report for Cameron.

---

## F6. [LOW] `markMatchesWritten` is the one write with no generation check before it

What is wrong. runBatch guards the run put, the match write, each flag
write and the progress write (plan 22888, 22909, 22927, 22760), but not
`markMatchesWritten` (plan 22916-22923). Spec D7: "before every model call
and every write (match, run, flag, record), a consistent read of the
record". The run is a write target.

What it implies. Negligible (the update only stamps the run that this job
itself wrote); listed so the builder does not have to decide whether it is
a deviation.

Fix. Either add `if (!(await ctx.guard())) return STOPPED;` before it, or
add one sentence to S5's contradictions saying the stamp of the job's own
run is exempt.

---

## F7. [LOW] S9.3 self-QA cannot be executed literally: no fixture recipe and no tick recipe on the lane

What is wrong. S9.3 (plan 36463-36470) says "rank a property ..., tick,
read the table (capped pair last, out of date after a card edit, 'not
scored - retry' for `[fake:fail-batch]`), rank a tenant ...". The lean
world has no available unit and one searching tenant (spec section 2;
S7 C5/C6), and the ranking tick is a POST with no UI. The plan does not
say how the self-QA agent builds the property/tenants (the API recipe
lives only in `e2e/fixtures/ranking.ts`) or how it calls
`POST /__dev/ranking/tick` on the e2e:session lane's port (not `:5174` /
`:8080`, AGENTS.md). The new seam is also missing from the dev-seam table
in `e2e/support/selectors.md` (the tour auto-close tick is listed there at
:124), which is where a spec author or self-QA agent looks.

Fix. In S9.3 name the recipe: create the fixtures with the same calls as
`e2e/fixtures/ranking.ts` (org entry, available property, tenants) through
the lane's dashboard URL, and tick with a `fetch('/__dev/ranking/tick',
{ method: 'POST' })` from the lane page. Add the seam's row to
`e2e/support/selectors.md` in S7.10 (or S8's docs).

---

## F8. [LOW] Two watch-item greps cannot produce the output the report template expects

What is wrong. S5.10 step 4 runs `git grep -n "putMatches(" -- app/src`
and expects "the only `putMatches(` caller is runBatch.ts" (plan
24447-24450); the pattern also matches `matchesRepo.ts`'s interface and
implementation lines. S6.6 step 5 greps `capOf(` over `app/src` (plan
27481-27483) and S5.10 step 5 over four files; the S6 grep also lists
`cap.ts`'s definition and `runLog.ts`. A literal builder records a
"mismatch" or edits the wording.

Fix. Say what the grep lists (the definition in matchesRepo.ts / cap.ts
plus the one caller) or grep for the call shape (`matches.putMatches(`,
`capOf({`).

---

## Checked and found sound (no finding)

Anchors quoted by S5-S7 exist verbatim at main @404e039d:
`app/test/sse.test.ts:173-175, 221, 232, 248`;
`app/test/eventBridge.test.ts:42-44` (count 10);
`app/src/routes/api.ts:61-62, 369-370, 891-899, 2790, 2802, 2836`;
`app/src/lib/events.ts:343, 353, 375`;
`app/src/routes/dev.ts:78` (`appEvents` already imported), `:88`, `:141-143`,
`:785-791`; `app/src/worker.ts:24, 34, 292-298, 507-508`;
`scripts/e2e-session.mjs:140, 258, 339`;
`dashboard/src/App.tsx:223-229`; `dashboard/src/routes/settings/settingsTabs.ts:25`;
`settingsTabs.test.ts:22-23, 29, 39-40, 63`; `SettingsPage.test.tsx:66-67, 87`;
`dashboard/src/api/types.ts:401-405`; `endpoints.ts:10-11, 3046-3050`;
`.env.example:199-200`, `.env.dev.example:231-232`, `.env.prod.example:256-257`.

Behavior claims verified in the code:
- `runWithContext` replaces the store (`app/src/lib/context.ts:56-58`) and
  the logger mixin spreads the context and derives `correlationId`
  (`app/src/lib/logger.ts:244-249`), so S5.7's WI14 assertions
  (`requestId`, `traceparent`, no `bootId` / `pollRunId`) can hold.
- `pollLoop.startPoll` never awaits a tick (`app/src/jobs/pollLoop.ts:56-76`):
  S5's reserve-before-claim slots are the right model.
- `/internal/events` re-emits on `api.events` (`app/src/app.ts:154-155`);
  the dev router mounts before the origin validator (`app/src/app.ts:131`).
- `createUserRateLimit` answers 429 `{ error: 'rate_limited' }` with
  `Retry-After` (`app/src/middleware/rateLimit.ts:252-317`); Express is 5
  (`app/package.json:36`), so a rejected async handler reaches the error
  handler.
- `/api` is an edge-mutating prefix (`app/src/app.ts:80`); no new
  CloudFront behavior is owed for `/api/rankings` or `/api/admin/rankings`.
- The e2e fixtures' API calls exist: create accepts `pets`, `notes`,
  `status: 'searching'`, the B1 inputs via `parseTenantMatchingInputs`
  (`app/src/routes/contacts.ts:929-936, 982-988, 997`); units accept
  `voucher_size_accepted`, `accepted_authorities` (org-checked), `area`,
  `no_pets`, `notes` (`app/src/lib/unitFields.ts:66, 129, 147`;
  `app/src/routes/units.ts:944-961`); `PATCH /api/units/:id/listing-status`
  (`app/src/routes/statusTransition.ts:342`); `addOrg`
  (`e2e/fixtures/orgFixture.ts:81-88`); `AdminRoute` redirects a VA to
  Templates (`dashboard/src/routes/settings/AdminRoute.tsx:9-11`); the
  settings routes have no catch-all, so S7.10's RED is red for the stated
  reason (`dashboard/src/App.tsx:193-240`).
- e2e runs `workers: 1`, `fullyParallel: false`, expect timeout 15 s
  (`e2e/playwright.config.ts:135, 140-141`): the unscoped dev tick is safe,
  and the 5 s job poll fits inside the expect window.
- `labelMatches` / `propertyLabel` (`app/src/lib/propertyLabel.ts:60-88`)
  make S6.5's WI11 "named home" and "feedback only" cases non-vacuous
  ("3 Seen St, Atlanta" matches its Notes line; "1 Seen St" does not match
  "10 Seen St").
- The listing-sends key is `(unitId, contactId)` and the tours GSIs are
  `byTenant` / `byUnit` (`app/src/lib/tables.ts:415-422, 526-532`), so
  S6.5's raw fixture rows and UpdateCommand keys are the real shapes.
- The ESLint `readFileSync` ban is scoped to `app/src/**`
  (`eslint.config.mjs:75`); S5's source-scan tests sit in `app/test`.

Spec coverage for S5-S9 (D7, D8 writes, D9, D10, D11, D12, D17, D18, D19,
spec 5 surfaces and spec 6 tests in scope) walked to tasks: every bullet
has a delivering task; the gaps are F1, F5 and F7 above.
