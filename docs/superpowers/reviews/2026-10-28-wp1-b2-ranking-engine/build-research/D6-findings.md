# D6 findings - S6 "The read and the API" (WP1 B2a build, Phase 1 delta read)

- Reader: D6 (read-only delta reader).
- Scope: plan section 10, S6 (tasks S6.1-S6.6): `readRanking.ts`
  (derivations, sort, not ranked / not scored, ceiling, unverified,
  PR16/PR17), `routes/rankings.ts` (rank, read, job; roles; rate limit),
  `routes/adminRankings.ts` (runs, run detail, cost; PR14/PR34), the two
  mounts in `routes/api.ts`, the WI18 150-tenant budget and the WI11
  invariants on DynamoDB Local. Spec D9, D12; WI1, WI11, WI17, WI18.
- Read: plan lines 1-590 (binding), 26728-30044 (S6, in full); the
  producers S6 consumes - S2 cross-slice notes 3833-3996, S2.6 matchesRepo
  6780-7032, S2.8 job types 7772-7960, S2.9 run/pointer family 8930-9290,
  S2.10 flag family 9575-9684; S3 Published shapes 10012-10268, pool rules
  12600-12760, assemble 15790-16067; S4 cross-slice 16432-16602, `capOf`
  16910-16924, the anthropic driver's `meta.model` 20990-21110; S5 9.0-9.2
  21586-21898, S5.2 fixtures + `flags.ts` 22224-22970, S5.3 fakes + `job.ts`
  22974-23775, S5.9 e2e-session edit 26540-26570; S7 N1 30154-30311, S7.1
  wire types 30313-30700, S7.10 e2e presses 34790-34975. Spec sections 2,
  D8-D13, D18, D19, 6. Tree (main @404e039d + docs): `app/src/routes/api.ts`,
  `app/src/app.ts`, `middleware/{rateLimit,auth,csrfOrigin,correlation,originSecret}.ts`,
  `lib/{context,logger,dynamo,dynamoAdmin,tables,config,contactName,propertyLabel,unitFields}.ts`,
  `routes/{aiRuns,broadcasts}.ts`, `repos/{contacts,units,listingSends,tours,orgList}Repo.ts`,
  `test/helpers/{authSession,logCapture}.ts`, `test/globalSetup.ts`,
  `test/globalTeardown.ts`, `app/vitest.config.ts`, the tsconfigs,
  `eslint.config.mjs`, `scripts/e2e-session.mjs`.
- Verdict: S6 is buildable as written. Every anchor exists byte-exact once,
  every consumed name and signature matches its producer slice, the
  hand-worked values (bands, sort orders, ISO weeks, cost ranges, totals)
  recompute correctly, and the wire matches S7.1's types. No BLOCKER, no
  MAJOR; 7 MINOR precision items (two RED descriptions, two test-fixture
  hygiene items, one lane-env gap, one fidelity nit, one efficiency nit).

## Findings

### D6-1 (MINOR) - S6.3's stated RED reason is wrong: the test file loads and the routes 404

- Plan: line 28445-28449, Task S6.3 Step 2 ("`../src/routes/rankings.js` is
  not found (the file fails to load)").
- Code fact: `app/test/rankingsApi.test.ts` (plan 28234-28254) imports
  `rankings.js` only as `import type { RankingsRouterDeps }`, which esbuild
  erases; every runtime import it has (`src/app.js`, `lib/context.js`,
  `lib/config.js`, `lib/logger.js`, the helpers) exists after S5. On the
  unchanged api.ts (`app/src/routes/api.ts:891-899` is the last mount
  before `/contacts`; no catch-all at the end, 2836-2845) `/api/rankings/*`
  falls through to Express's default 404.
- Problem: plan section 0 says "confirm it is red for the stated reason".
  The builder will see every route case fail on status 404 (body `{}`), and
  `401 without a session` (28389-28392) PASS on the unchanged tree
  (`requireAuth` runs before any router, `app/src/app.ts:231-245`).
- Correction: restate S6.3 Step 2's runtime half as "every route case fails
  on a 404 (no `/api/rankings` mount yet); `401 without a session` is
  already green (a PIN)". The typecheck half (`api.rankings` not an
  `ApiRouterDeps` field; `rankings.js` not found) stands. S6.4's RED is
  correct as written (its test value-imports `costRange`, `defaultCostRange`,
  `isoWeekOf`, so that file does fail to load).

### D6-2 (MINOR) - S6.2's typecheck RED lists `RANKING_UNAVAILABLE_MESSAGE` as missing, but S6.1 already exports it

- Plan: line 27993-27998, Task S6.2 Step 2.
- Code fact: S6.1's `readRanking.ts` (plan 27346) already has
  `export const RANKING_UNAVAILABLE_MESSAGE = 'The ranking could not be read. Try again.';`.
- Problem: after S6.1, `npm run typecheck` reports only `readRanking` and
  `RankingReadDeps` missing; the runtime half ("readRanking is not a
  function" in every case) is right.
- Correction: drop `RANKING_UNAVAILABLE_MESSAGE` from the expected
  typecheck errors.

### D6-3 (MINOR) - The integration test's table prefix escapes the residue sweep

- Plan: line 29634, Task S6.5 (`TABLE_PREFIX: \`hc-rkread-${label}-${uuid}-\``).
- Code fact: `app/test/globalTeardown.ts:80-84` sweeps leaked throwaway
  tables only by `/^hc-test-/`, `/^hc-hist-/`, `/^hc-local-\d+-/`; its
  comment (`:60-78`) records a residue-loaded key running 607 s with 9
  failures. Every S2 integration test in this plan uses `hc-test-`
  (plan 5781, 6102, 6644, 7266, 8390, 8747, 9444).
- Problem: an interrupted run (Ctrl-C, a killed worker, a hook timeout
  before `afterAll`) leaks this file's 16 tables (8 per describe) into its
  per-file database for good; the sweep never sees them.
- Correction: use `TABLE_PREFIX: \`hc-test-rkread-${label}-${randomUUID().slice(0, 8)}-\``.
  (S5.8's `hc-rankjob-` at plan 26018 has the same gap; that is S5's
  reader's to carry.)

### D6-4 (MINOR) - The hermetic lane leaves the new per-user rank limiter at its production default

- Plan: S5.9 e2e-session edit (plan 26544-26563) sets only `RANKING_DRIVER`
  and `RANKING_WORKER_POLL`; S6.3 creates the limiter at
  `config.rateLimitRankPerMin` (plan 28558-28563), default 6 (plan 4689).
- Code fact: `scripts/e2e-session.mjs:182-193` raises EVERY other per-user
  limiter (manual send, broadcast send, originate, verify start) to
  `'100000'` for the hermetic stack, with the reason: "the whole e2e suite
  drives those routes as the ONE seeded dev-login user within minutes".
- Problem: not hit by S7.10 as drafted (four founder presses, plan
  34816/34872/34894/34928, under 6), but S9's interactive self-QA and any
  later spec that presses a seventh time within a minute as the same
  dev-login user gets a 429 with no obvious cause.
- Correction: add, beside the S5.9 lines,
  `RATE_LIMIT_RANK_PER_MIN: process.env.RATE_LIMIT_RANK_PER_MIN ?? '100000',`
  following the existing block's comment (an externally set value still
  wins, so a focused 429 spec can pin a small ceiling). The file is S5's
  under PR2; the planner assigns it.

### D6-5 (MINOR) - S6.5 ignores its own setup-write results, so a seeding shortfall reads as a ranking defect

- Plan: lines 29618-29631 (`batchPut`), 29728-29731 and 29809-29810
  (`putMatches`), Task S6.5.
- Code fact: S2's `putMatches` never throws on a DynamoDB failure; it
  returns `{ written, unwritten }` (plan 6842-6860, PR37). The test's
  `batchPut` gives up after 10 attempts without throwing.
- Problem: an unprocessed seed or match row surfaces later as "read.rows
  has 149 entries", a row with `match: null`, or a WI11 case reading `[]`
  for the wrong reason - which Step 2 tells the builder to report to the
  planner as an S3 fingerprint defect.
- Correction: in `batchPut`, throw when items remain after the last
  attempt; after each `putMatches`, `expect(result.unwritten).toEqual([])`.

### D6-6 (MINOR) - The WI11 "tour roster change" case mutates `groupThreadId`, not the roster

- Plan: lines 29822-29825, Task S6.5 (`SET groupThreadId = :g`).
- Code fact: `TourItem` carries the roster as `roster?: RosterEntry[]` and
  `rosterVersion?: number` (`app/src/repos/toursRepo.ts:95`, `:97`);
  `groupThreadId` (`:85`) is the group-thread link.
- Problem: the invariant still holds (any non-projection field), but the
  case does not exercise the field its name claims (spec 6: "a tour's
  reminder or roster change does not").
- Correction: also `SET rosterVersion = :v, #roster = :r` (a one-entry
  roster) in the same UpdateCommand, keeping `groupThreadId`.

### D6-7 (MINOR) - The run detail reads candidate-property flags one query at a time

- Plan: lines 29357-29372, Task S6.4 (`for (const unitId of unitIds) { ... await runs.getOpenCandidateFlags(unitId) ... }`).
- Code fact: S6's own read bounds the same per-property flag queries with
  S3's `mapWithConcurrency` and `rankingReadConcurrency` (plan 28129-28136,
  IR29).
- Problem: a tenant-anchor run of a full batch (40 candidates) issues 40
  sequential Queries per detail open. Correct, only slow.
- Correction (optional): wrap the loop in `mapWithConcurrency(unitIds,
  deps.config.rankingReadConcurrency, ...)` and concat the results in
  `unitIds` order, so `flags` stays deterministic.

## Wire contract S6 publishes (as built; for S7)

- `POST /api/rankings/:anchorKind/:anchorId/rank` body `{ includeOlder?: boolean }`:
  202 `{ job: RankingJobView, joined: boolean }`; 400 `{ error:
  'invalid_anchor_kind' | 'invalid_anchor_id' | 'invalid_include_older' }`;
  404 `{ error: 'anchor_not_found' }`; 409 `{ error: 'ranking_running',
  message: MSG_RUNNING }`; 429 `{ error: 'rate_limited' }` + `Retry-After`.
  The limiter counts every POST, 400s included.
- `GET /api/rankings/:anchorKind/:anchorId?includeOlder=true|false` (absent
  or empty = false; anything else 400): 200 `{ anchor: { kind, id, display,
  anchorNotes, missing: { key, label }[], cardChanged }, job:
  RankingJobView | null, rows: RankingReadRow[] (sorted), flags: { unitId,
  field, reason, runId, raisedAt }[], poolWindowDays: number,
  poolTooLarge?: { size, message } }`; over the ceiling `rows: []`,
  `flags: []`, `cardChanged: false`, `anchor.missing` populated; 404 `{
  error: 'anchor_not_found' }`; 503 `{ error: 'ranking_unavailable',
  message }`.
- `RankingReadRow`: `{ candidateId, tenantId, unitId, display, hasConsent?,
  priority?, notRankedYet, notScored, match: null | { score, band, capped,
  capReason: 'requirement not met' | null, for, against, missing: { key?,
  text }[], failedRequirements, fairHousingFlags: { kind, field }[],
  computedAt, model, runId, outOfDate: ('card' | 'pairHistory' | 'age' |
  'version' | 'failedBatch' | 'unverified')[] } }`.
- `RankingJobView` (S5 `jobView`): `{ status: 'queued' | 'running' | 'done'
  | 'failed' | 'expired', generation, includeOlder, requestedAt, startedAt?,
  finishedAt?, poolSize?, batchCount (0 until built), batchesDone: number[],
  failedBatches: { index, candidateIds, failure }[], notScored: {
  candidateId, reason }[], message? }`.
- `GET /api/rankings/:anchorKind/:anchorId/job`: 200 `{ job: RankingJobView | null }`; 400 on a bad anchor.
- `GET /api/admin/rankings/runs?from&to&anchorKind&anchorId&cursor&limit`
  (admin; anchor both or neither; limit default 25, max 100): 200 `{ runs,
  nextCursor?, incomplete?: true }`; live row `{ runId, expired: false,
  startedAt, finishedAt, anchorKind, anchorId, anchorDisplay (always; the
  id when nothing resolves), direction, batchIndex, candidateCount, driver,
  model, costUsd, latencyMs, outcome, failure?, environment }`; gone or
  unread row `{ runId, expired: true }`; 400 `invalid_from` /
  `invalid_to` / `invalid_anchor`.
- `GET /api/admin/rankings/runs/:runId` (admin): 200 `{ run (the record
  less itemId, inputGzip, handles, results), anchorDisplay, input: string |
  null, pairs, flags, currentUnavailable?: true, flagsUnavailable?: true }`;
  pair `{ candidateId, handle, display, returned, score?, band? (bandOf,
  'weak' when cappedAtRun), cappedAtRun: boolean, capReason:
  'requirement not met' | null, for, against, missing, unknowns,
  failedRequirements, fairHousingFlags, currentRunId: string | null,
  sinceRescored }`; 404 `{ error: 'run_not_found' }`.
- `GET /api/admin/rankings/cost?from&to` (admin): 200 `{ environment:
  config.appEnv, weeks: { week: 'YYYY-Www', environment, runs, inputTokens,
  outputTokens, costUsd }[] (week desc, then environment asc), totalUsd,
  truncated, incomplete?: true }`; a missing `to` = today (UTC), a missing
  `from` = the Monday 11 weeks before `to`'s ISO-week Monday.
- Every name above matches S7.1's types (plan 30427-30700); S7 types the
  extra `failure`, `tenantId`, `unitId`, `notRankedYet`, `sinceRescored`
  and the 409 `message` as optional or not at all - harmless.

## Checked and fine

- Anchors: `import { createAiRunsRouter } from './aiRuns.js';` (api.ts:166),
  the `aiRunsRepo` comment pair (369-370) and the `/ai-runs` mount
  (891-899) each exist once, byte-exact, LF; S6.4's anchors are S6.3's own
  text and unique (the mount tail includes `...deps.rankings,`). S5 edits
  only the SSE block (2731-2847) and an events import, away from all three.
- `contacts` (api.ts:700), `units` (686) and `config` (630) are in scope
  before the new mounts; no router mounted before `/ai-runs` matches
  `/rankings` or `/admin`; the four `/`-mounted routers come later
  (1107, 1138, 1234, 1264); nothing in the tree is mounted at `/admin`.
- `ApiRouterDeps` has no exhaustive consumer (`keyof`, `Required<>`,
  `Record`); `BuildAppDeps.api` is `Omit<ApiRouterDeps, 'config' |
  'logger'>` (app.ts:50), so `api: { rankings }` / `{ adminRankings }`
  type-check once the fields exist. The nested seam departs from the flat
  `<router>Now` convention (`toursNow`, `placementsNow`, `poolNumbersNow`
  returns Date) but compiles and is what PR27 allows.
- Locked chain: correlation -> logger -> origin secret -> body parsers ->
  routes (app.ts:114-146); the mounts sit in the route stage behind
  `csrfOriginMiddleware`, `sessionMiddleware`, `requireAuth` (app.ts:231-245).
  CSRF lets an absent Origin through (csrfOrigin.ts:53-56), so supertest
  POSTs pass. `/api` is already in `EDGE_MUTATING_PREFIXES` (app.ts:80).
- `createUserRateLimit({ routeKey, max, windowMs, logger })`, 429 `{ error:
  'rate_limited' }` + integer `Retry-After`, keyed by `user.userId`
  (rateLimit.ts:265-319); ONE instance per router ahead of the POST alone -
  identical to broadcasts.ts:1158-1163 and api.ts:1377-1383.
- `requireRole('admin')` -> 403 `{ error: 'forbidden' }` (auth.ts:235-247),
  used as `router.use(...)` exactly as aiRuns.ts:137; `AuthedRequest.user.userId`.
- Test harness names: `adminUserItem`, `makeFakeUsersRepo(...).repo`,
  `TEST_ADMIN_COOKIE`/`TEST_ADMIN_USER` (admin), `TEST_SESSION_COOKIE`/
  `TEST_SESSION_USER` (role `va`), `testUserItem` (authSession.ts:22-139);
  `createLogCapture().stream`; `x-origin-verify`; `x-request-id` echoed by
  correlation.ts; `buildApp({ config: loadConfig({ NODE_ENV: 'test',
  CF_ORIGIN_SECRET }) , auth, api })` has precedent (apiRoutes.test.ts:38-63).
- `currentTraceparent`, `getContext`, `newRequestId`, `isValidTraceparent`
  (context.ts:62-121); `PRESS_TRACEPARENT` is a valid traceparent.
- `contactDisplayName` (contactName.ts:74) and `propertyLabel`
  (propertyLabel.ts:60) take `ContactDisplayItem` / `UnitDisplayItem`;
  `getDisplaysByIds` exists on both repos (contactsRepo.ts:784,
  unitsRepo.ts:688).
- S2 consumption: `MatchRow` (all 20 fields, `schema: 2`, `stage: 1`),
  `matchPairKey(tenantId, unitId)`, `getPairs(keys, { requireComplete:
  true })`, `createMatchesRepo(RepoDeps)`, `gunzipBase64`; `getJob(kind,
  id, { consistent: boolean })`; `RankingJobRecord`/`RankingFailedBatch`
  (`failure: string`)/`RankingNotScored`; `rankingRunEntityKey()` =
  `rankings#global`, `({ kind, id })` = `rankings#<kind>#<id>`;
  `listRuns(ListRankingRunsOptions)` -> `RankingRunListPage` with the
  `{ expired: false; run: RankingRunSummary }` / `{ expired: true;
  unavailable?: true }` entries; the summary carries every field the list
  and cost read (incl. `usage?`, `failure?`); `getRun`;
  `getOpenCandidateFlags` -> `UnlawfulFlagRecord[]`;
  `RankingRunResult` (optional scored fields, `cappedAtRun?`).
- S3 consumption: `AssembleResult` union and its `reason` discriminant;
  `PoolFailure` (`size?`, `anchorRecord?`, `anchor?`, `anchorNotes?`,
  `orgEntries?`); `AssembledAnchor.fingerprint` / `.propertyFacts:
  PropertyFacts | null`; `VerifiedCandidate` (`unverified: false`,
  non-null fingerprints/facts) / `UnverifiedCandidate` (`unverified: true`;
  facts = the anchor's on a property anchor, null on a tenant anchor -
  assemble.ts plan 15916-15924, 15987); `sortRecencyAt(contact): string |
  null` (no import exception); `mapWithConcurrency`; `rankingAnchorExists(
  anchor, { contacts, units })`; `tenantDisplay` / `propertyDisplay`;
  `createAssembleDeps({ config, logger, env?, doc? })` (contacts, units,
  placements, listing_sends, tours, settings); `loadPropertyFacts`;
  `poolTooLargeMissing(failure, deps)`; `PropertyFacts` from `cards.ts`.
- S4 consumption: `bandOf`/`Band` (bands.ts), `capOf` + `flagFieldsOfKind`
  (cap.ts; non-eligible and unrecorded keys skipped, `landlord:` via
  `baseField`, accommodation by item), `RUBRIC_VERSION` (rubric.ts),
  `EXAMPLES_VERSION` (examples.ts). The anthropic driver stamps
  `meta.model = config model` (plan 21023), fake `'fake'`, console
  `'console'`, so `currentRankingModel` agrees with what S5 writes.
- S5 consumption: `claimRanking` + `ClaimDeps` (`jobs`, `anchorExists`,
  `config`, `now(): string`), `ClaimResult`, `RankingPress`, `jobView(record,
  nowIso)` (omits absent optionals, `batchCount ?? 0`), `RankingJobView`,
  `MSG_RUNNING` (text matches the 409 test), `isVerified`, `openFlags`,
  `textHashOf`; fixtures (`queuedJob` derives `queuedExpiresAt` from
  `requestedAt`, so `isoAt(-700_000)` reads expired at T0) and fakes
  (`RankingRunsApi` covers `getJob` + `getOpenCandidateFlags`; plain
  writable object, so the tests' method overrides and `vi.spyOn` work;
  `createMatchesFake` drops non-schema-2 rows and has `failGets`).
- Hand-worked values recomputed and correct: the 8 band boundaries; the
  cap cases; every out-of-date case incl. the exact-limit age and the
  fixed reason order; all five sort expectations (property anchor with
  FB19 created_at fallback and capped-last-in-Weak; priority ignored;
  within_band label tiebreak `'A Street, Atlanta'` < `'good-plain-75 Elm
  St, Atlanta'`; one_band_up; always_first); the admin pairs (85 strong,
  70 capped -> weak); ISO weeks (2026-10-28 and 2026-10-26 -> 2026-W44,
  2025-12-29 -> 2026-W01, 2027-01-01 -> 2026-W53 since 2026 starts on a
  Thursday, 2027-01-04 -> 2027-W01); cost ranges (2026-08-10, 2026-07-13,
  2026-10-19 Mondays) and totals (0.75 / 1 / 1.75; tokens 2000/1000 and
  1000/500).
- Compile spot checks (scratch, real TS 5.9.3 + vitest 3.2.6 types): the
  runs route's `anchorKind` narrowing into `rankingRunEntityKey({ kind,
  id })` type-checks; the `it.each` tuple tables (score/band and the
  version overrides into `row(over)`) type-check.
- Lint: `no-unused-vars` honors `^_` (eslint.config.mjs:32-39), so the
  `_input`/`_itemId`/`_handles`/`_results`/`_omit` rests pass; no `any`
  in the three src files; every import in the five test files is used.
  S6.1 leaves imports S6.2 uses unused for one commit - no tsc error
  (`noUnusedLocals` is off) and lint runs at S6.6.
- Smoke/tsconfig: new src files are under `app/tsconfig.json` (`src`),
  tests under `tsconfig.test.json`; every relative import ends `.js`; no
  directory import; no import cycle (readRanking -> job/assemble/flags,
  none back).
- Spec/ruling conformance: D9 derivations, the PR13 rule over both job
  lists, PR16 (anchor block + `poolTooLarge`, no pairs read), PR17 (503
  from the anchor's card/seen set/own flag read, plus org list, incomplete
  pairs and job read; unverified rows with the facts-null and flags-unread
  cap rules), PR14 names, PR21 404, PR24 split ceiling, PR26
  `poolWindowDays`, PR34 summary reads/`incomplete`/12-week default, R2B6
  bounds, PR38/PR43 read side, FB19, BA3, FB4; D12 roles (WI17) and the
  limiter; WI1 readers (`getPairs` only; S6.6's grep finds exactly the two
  call sites); WI13 (`capOf({` once, in `deriveMatch`).
- WI11 (S6.5) reasoned against S3's code: every "changes nothing" case
  touches only sends, Notes-named-but-unseen homes, a non-projection tour
  field or a feedback-only home; every "card" case adds a stored outcome
  (`declinedOf` reads the stored decline, no effectiveness filter) or
  changes the Notes text or a declined home's `rent_max` (an included card
  field); the pair decline moves `pairHistory`. Config resolves the
  `console` driver on both sides (local endpoint), so no `version` noise.
- WI18 (S6.5): all eight tables the gatherer and the read touch are
  created; the 150 tenants pass every pool fence (searching, phone, no
  opt-out, window, no unit sizes = every size, no authorities = unlimited);
  `listByContact` keeps rows with `sentAt` (listingSendsRepo.ts:235-237);
  no duplicate key in any BatchWrite chunk; `RANKING_READ_BUDGET=1 ... -t
  "WI18"` filters to the budget describe; the 20 s / 5 s split is PR24's.
- ASCII: plan lines 26728-30044 contain no non-ASCII byte; api.ts is a
  pre-existing non-ASCII file, so S6.6's added-lines check is the right one.
