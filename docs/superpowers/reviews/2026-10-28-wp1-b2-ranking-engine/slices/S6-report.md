# S6 report - the read and the API (WP1 B2a)

Branch feat/wp1-b2-ranking-engine, worktree `W:/tmp/wp1-b2-ranking-engine`.
Tasks S6.1-S6.6, built by one S6 implementer (Claude Opus 5.5, 2026-10-29).
Slice range: 7c9b959a (the S5 report, the commit before S6.1) .. d4fff389
(S6.5), plus this report's commit (the slice tip).

- Spec: D9 (the read), D12 (endpoints, roles, rate limit). Rulings in force:
  PR13, PR14, PR16, PR17, PR21, PR24, PR26, PR27, PR34, PR38 / PR43 (read
  side), R2B6, BA3, FB4, FB19. Watch items: WI1 (S6 share), WI11 (S6 share),
  WI12, WI13, WI17, WI18. WORKLIST: section G and WL-S6-1 .. WL-S6-4.
- Verdict: S6.1-S6.5 one commit each; S6.6 is this report's commit. Every
  task RED for its stated reason (two REDs as D6-1 / D6-2 restate them), then
  GREEN, except S6.5, a PIN task (all 12 cases green on the first run, as the
  plan allows). No one-value test fix. No QUESTION. No S3 file changed (the
  read is far inside its budget).
- WI18 (PR24), the isolated measurement, run ONCE as instructed:
  `RANKING_READ_BUDGET=1 npx vitest run test/rankingRead.integration.test.ts -t "WI18"`
  -> **224, 175, 164 ms** against 5000 ms: PASS.

## 1. Tasks and commits

All paths under `app/` unless shown.

| Task | Commit | Files |
|---|---|---|
| S6.1 `readRanking.ts` part 1: derivations and the sort | f24c2519 | `src/services/ranking/readRanking.ts` (new), `test/rankingReadDerive.test.ts` (new) |
| S6.2 `readRanking.ts` part 2: `readRanking` and its deps | f577f7db | `src/services/ranking/readRanking.ts`, `test/rankingRead.test.ts` (new) |
| S6.3 `routes/rankings.ts` and its mount: rank, read, job | d8f5f783 | `src/routes/rankings.ts` (new), `src/routes/api.ts`, `test/rankingsApi.test.ts` (new) |
| S6.4 `routes/adminRankings.ts` and its mount: runs, run detail, cost | c5d107fd | `src/routes/adminRankings.ts` (new), `src/routes/api.ts`, `test/adminRankingsApi.test.ts` (new) |
| S6.5 WI18 read budget and WI11 invariants on DynamoDB Local (PIN) | d4fff389 | `test/rankingRead.integration.test.ts` (new) |
| S6.6 slice gates and this report | this commit | `docs/.../slices/S6-report.md` |

File ownership: `readRanking.ts`, `rankings.ts`, `adminRankings.ts` and
their mount in `routes/api.ts` are PR2's S6 list; the two `ApiRouterDeps`
seam fields (`rankings`, `adminRankings`) are PR27's S6 allowance. No other
source file was touched (`app.ts` is not in the diff: the locked middleware
order is unchanged). Slice diff 7c9b959a..d4fff389: 9 files, 2739
insertions, 0 deletions.

## 2. Gates

- `npm run typecheck` (bare, worktree root): exit 0 (app src + scripts +
  test, dashboard, e2e, fake-twilio, fake-twilio-web).
- eslint, bare, from the worktree root, on the plan's nine files
  (`readRanking.ts`, `rankings.ts`, `adminRankings.ts`, `api.ts` and the
  five test files): exit 0, no error and no warning in any file. `api.ts` is
  pre-existing and reports nothing, so no baseline comparison was needed. No
  S3 file was touched (no PR24 fix), so none was added to the list.
  Note: the S6.1 commit alone carried 16 `no-unused-vars` errors in
  `readRanking.ts` (the imports S6.2 first uses: `createMatchesRepo`,
  `assembleRanking`, `jobView`, `mapWithConcurrency`, ...), exactly as D6
  predicted ("S6.1 leaves imports S6.2 uses unused for one commit ... lint
  runs at S6.6"; the WL-S3-4 precedent). S6.2 cleared all 16.
- ASCII sweep: every NEW file prints 0 with
  `tr -d '\11\12\15\40-\176' < FILE | wc -c` (`readRanking.ts`,
  `rankings.ts`, `adminRankings.ts`, the five test files); `api.ts` (a
  pre-existing non-ASCII file, 279 such bytes, none ours) prints 0 on its
  ADDED lines over 7c9b959a..HEAD. This report prints 0.
- Tests: the app workspace suite (`cd app && npx vitest run`): 597 files
  passed; 12644 passed, 1 skipped (the pre-existing diagnostic "built
  dashboard identity tags", no dashboard build); 144.91 s; exit 0; 0
  `[dynamoAdmin]` lines (fixed-string grep of the captured output). Against
  S5's baseline (592 files / 12510 passed) that is +5 files and +134 cases,
  exactly this slice's new cases (40 + 24 + 17 + 41 + 12). The ERROR log
  lines in the captured output (ProvisionedThroughputExceededException,
  "boom") are other suites' injected failures, not failing tests. No re-run
  was needed. The ROOT `npm test` was NOT run: the brief makes it the
  orchestrator's gate (S6.6 Step 1 item 6 names it; the brief wins - S5's
  precedent). `env | grep -c '^AWS_'` printed 0, so no `env -u` prefix.

## 3. Test commands and counts (in order)

Command form: `cd W:/tmp/wp1-b2-ranking-engine/app && npx vitest run test/<file>`,
output captured to a scratch file and read after the command finished.
DynamoDB Local was up (G1); nothing was installed or restarted.

1. S6.1 RED (`rankingReadDerive`): 1 file failed, no tests - "Cannot find
   module '../src/services/ranking/readRanking.js'" (the stated reason; G4
   wording "Failed to load url ... Does the file exist?").
2. S6.1 GREEN: 1 file, 40 passed. `tsc -p tsconfig.json --noEmit` 0,
   `tsc -p tsconfig.test.json --noEmit` 0; eslint: the 16 unused imports
   (section 2).
3. S6.2 RED (`rankingRead`): 1 file failed, 24 failed (24), every case
   "TypeError: (0 , readRanking) is not a function". Type half
   (`tsc -p tsconfig.test.json`): TS2305 no exported member `readRanking`,
   TS2724 no exported member `RankingReadDeps` (plus the follow-on TS7006
   implicit-any lines). `RANKING_UNAVAILABLE_MESSAGE` is NOT reported
   missing - S6.1 already exports it (D6-2).
4. S6.2 GREEN (`rankingRead`, `rankingReadDerive`): 2 files, 64 passed. tsc
   src / test 0; eslint (3 files) 0.
5. S6.3 RED (`rankingsApi`, verbose): 1 file failed, 16 failed, 1 passed.
   The file LOADS (it imports `rankings.js` type-only); every route case
   fails on the missing mount ("expected 404 to be 202 / 200 / 400 / 409 /
   503", "expected {} to deeply equal ...", and the press cases see no
   press), and "401 without a session" passes (a PIN: requireAuth runs before
   any router). This is D6-1's restated RED, not the plan's "the file fails
   to load". Type half: TS2307 cannot find `../src/routes/rankings.js`,
   TS2353 `rankings` does not exist in `Omit<ApiRouterDeps, ...>`.
6. S6.3 GREEN: 1 file, 17 passed. tsc src / test 0; eslint (3 files) 0.
   The ASCII check on api.ts's added lines 0.
7. S6.3 neighbours - every app test that reads source files (21 found by
   `grep -l "readFileSync|readdirSync|globSync|import.meta.glob" test/*.test.ts`,
   `cloudfrontBehaviors`, `tenantMatchingInputsReaders`, `rankingWiring`,
   `staticSmoke` among them) plus `logCallSiteGuard`, `messageCatalogAscii`,
   `apiRoutes`: 24 files, 336 passed, 1 skipped (the dashboard identity
   diagnostic).
8. S6.4 RED (`adminRankingsApi`): 1 file failed, no tests - "Cannot find
   module '../src/routes/adminRankings.js'" (the stated reason). Type half:
   TS2307 the module, TS2353 `adminRankings` not in `ApiRouterDeps`.
9. S6.4 on the plan's VERBATIM `adminRankings.ts` (before WL-S6-4): 1 file,
   40 passed, 1 failed - the WL-S6-4 case, "expected 1 to be 2" (the plan's
   sequential loop never has two flag reads in flight). The RED for the
   WORKLIST item's reason.
10. S6.4 GREEN after WL-S6-4 (`adminRankingsApi`, `rankingsApi`): 2 files,
    58 passed (41 + 17). tsc src / test 0; eslint (3 files) 0.
11. S6.4 neighbours (`cloudfrontBehaviors`, `apiRoutes`, `aiRunsApi`): 3
    files, 108 passed.
12. S6.5 (`rankingRead.integration`, verbose): 1 file, 12 passed on the
    FIRST run (about 2.1 s; each case named, none skipped) - PIN. WI18
    printed `ms: 226, 169, 153` under the default 20 s ceiling.
13. S6.5 isolated budget (Step 3, run once):
    `RANKING_READ_BUDGET=1 npx vitest run test/rankingRead.integration.test.ts -t "WI18" --reporter=verbose`
    -> 1 passed, 11 skipped; `[WI18] 150-tenant property read, ms: 224, 175, 164`
    against 5000 ms: PASS.
14. S6.5 tsc test 0; eslint 0.
15. S6.6: root `npm run typecheck` 0; eslint (9 files) 0; ASCII sweep 0;
    the greps (section 4); the app workspace suite (section 2), where WI18
    printed `ms: 292, 245, 309` against the 20 s ceiling.

New cases in S6: 134 (derive 40, read 24, rankings API 17, admin API 41 -
the plan's 39 plus the WL-S6-4 case and its PIN - integration 12).

## 4. Watch items

- WI1 (readers, S6 share). BA8 call-site grep:
  `git grep -n -e "matches.getPairs(" -e "matches.listByUnit(" -e "matches.listByTenant(" -- app/src/services/ranking app/src/routes/rankings.ts app/src/routes/adminRankings.ts`
  -> exactly two lines:
  `app/src/routes/adminRankings.ts:259:          : await matches.getPairs(run.results.map((r) => keyOf(r.candidateId)), { requireComplete: true });`
  and `app/src/services/ranking/readRanking.ts:413:        : await deps.matches.getPairs(`.
  No `listByUnit` / `listByTenant` call anywhere in `app/src` outside
  `matchesRepo.ts` itself (its interface and implementation lines): no
  ranking reader uses the eventually consistent byUnit index. The read
  reads every pool member's pair by key with `{ requireComplete: true }`
  (rankingRead.test.ts "reads every pool member's pair by key with
  requireComplete"); a legacy row (no `schema: 2`) is ignored ("a legacy row
  ... is ignored: the member reads not ranked yet"). Writers re-checked:
  `git grep -n "putMatches(" -- app/src` -> the interface
  (`matchesRepo.ts:111`), the implementation (`:180`) and the one call
  (`runBatch.ts:285`). Holds.
- WI11 (S6 share). `rankingRead.integration.test.ts` through the REAL
  `assembleRanking` and `readRanking` on DynamoDB Local: six "changes
  nothing" cases (a bare new send; a re-send that re-orders; a ninth send
  that pushes an entry off the listed ones; the first send of a home a Notes
  line already names; a tour roster change - `roster`, `rosterVersion` and
  `groupThreadId`, WL-S6-3; an edit to a home with feedback only), four
  "card" cases (a decline, a tour, a feedback line on another property; an
  edit to a card field of a declined seen home) and one "pairHistory" case
  (a decline of the pair itself): 11/11 pass. A "changes nothing" case
  reading `[]` proves the match is present (`reasons.get` would be
  `undefined` for a row with no match). No fingerprint defect to report.
- WI12 (one card definition). `git grep -n -e "tenantCard(" -e "propertyCard(" -- app/src/services/ranking/readRanking.ts app/src/routes/rankings.ts app/src/routes/adminRankings.ts`:
  no output (exit 1). The read takes every card through `assembleRanking`
  (`createRankingReadDeps` binds it); the run detail renders the run's own
  stored `results[]` and reads current facts through S3's
  `loadPropertyFacts`. Holds.
- WI13 (one cap function). `git grep -n "capOf({" -- app/src/services/ranking/readRanking.ts app/src/routes`
  -> exactly `app/src/services/ranking/readRanking.ts:195:  const cap = capOf({`
  (`deriveMatch`). Across `app/src` the only other call is S5's
  `runLog.ts:74` (`cappedAtRun`). The run detail reads the stored
  `cappedAtRun`, never recomputes it. Holds.
- WI17 (roles). `rankingsApi.test.ts`: a VA ranks (202, "a VA can rank
  (WI17)"), an admin ranks (202), a VA reads (200, "a VA reads the ranking
  (WI17)"), a VA polls the job (200, "a VA polls the job"); 401 without a
  session. `adminRankingsApi.test.ts`: "403s a VA on %s" for
  `/api/admin/rankings/runs`, `/runs/run-1` and `/cost`; every other case
  there is an admin 200 (or the admin's 400 / 404). The rankings router adds
  no role gate (plain `requireAuth` from the `/api` mount); the admin router
  calls `router.use(requireRole('admin'))` first, as `aiRuns.ts`. The rank
  limiter is ONE `createUserRateLimit({ routeKey: 'ranking_rank', max:
  config.rateLimitRankPerMin, windowMs: 60_000 })` created with the router
  and placed ahead of the POST handler alone - the broadcast send limiter's
  shape (`broadcasts.ts:1158-1164`). "rate limits the press per user ... 429
  with Retry-After, no claim" (ceiling 2, the third press 429, another
  user's quota their own) and "reads and the job poll are not rate limited"
  (ceiling 1, four reads and four polls all 200). `app.ts` is untouched: the
  locked chain (correlation -> logger -> origin secret -> body parsers ->
  routes) is unchanged and both mounts sit in the route stage. Result: pass.
- WI18 (PR24). 150 tenants (3 sends each, a tour for every 4th, a Notes line
  for every 3rd, a stored match each) on DynamoDB Local, the real
  repositories, the real gatherer and the real read, three reads per run:
  - isolated (`RANKING_READ_BUDGET=1`, this file alone, `-t "WI18"`, run
    once): **224, 175, 164 ms** against 5000 ms: PASS;
  - the first plain run of the file: 226, 169, 153 ms against 20 000 ms;
  - inside the shared app workspace suite: 292, 245, 309 ms against
    20 000 ms.
  S3 files changed for the budget: none.
- Cameron's standing question (kept true): no prompt fingerprint feeds the
  out-of-date test. `outOfDateReasons` reads the card fingerprints
  (`tenantCard`, `unitCard`), `pairHistory`, the age (`computedAt` against
  RANKING_MAX_AGE_DAYS), the version (`rubricVersion`, `examplesVersion`,
  `model`), the last job's lists (`failedBatch`) and `unverified`;
  `git grep -n -i "promptFingerprint" -- app/src/services/ranking/readRanking.ts app/src/routes/rankings.ts app/src/routes/adminRankings.ts`
  prints nothing.

## 5. WORKLIST items

- G1: nothing installed or restarted; DynamoDB Local used as found.
- G2: every plan block was copied with `sed -n` (byte-exact). The one
  backslash escape in S6 (`adminRankings.ts`'s
  `const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;`) survived (fixed-string grep
  count 1, after the WL-S6-4 edits too). `cmp` against the plan: identical -
  `readRanking.ts` (part 1, one blank line, part 2), `rankings.ts`,
  `rankingReadDerive.test.ts`, `rankingRead.test.ts`, `rankingsApi.test.ts`;
  the api.ts insertions are the plan's text. The WORKLIST edits were made with
  the Edit tool and hold no backslash.
- G3: no S6 comment restates a superseded ruling (the plan's S6 text already
  speaks PR13 / PR17 / PR42's terms).
- G4: S6.3's RED is D6-1's restatement (route cases 404, the 401 case a PIN),
  S6.2's type RED is D6-2's (no `RANKING_UNAVAILABLE_MESSAGE`); both recorded
  in section 3; no test was altered to manufacture a RED.
- G5: S6 spells no `rankjobs#` / `rankings#global` literal in source; the
  runs list builds its key with S2's `rankingRunEntityKey()`. (The admin
  test's expected `'rankings#global'` and `'rankings#tenant#t-9'` are the
  plan's assertions of the built key.)
- G6: no `ANTHROPIC_*` value read or printed; every S6 test uses stubs or
  the config's local-endpoint `console` driver default (PR30: the
  integration config names its local `DYNAMODB_ENDPOINT`).
- G7: no command left running; the longest was the app suite (144.91 s,
  foreground, hard timeout).
- WL-S6-1: S6.5's prefix is `hc-test-rkread-<label>-<uuid8>-`, so
  `test/globalTeardown.ts`'s residue sweep (`/^hc-test-/`) covers an
  interrupted run; one comment line says so.
- WL-S6-2: S6.5's `batchPut` throws ("items for <table> still unprocessed
  after 10 attempts") when a chunk is not fully written after its 10
  attempts, and both `putMatches` calls assert `written.unwritten` equals
  `[]` (S2's `putMatches` never throws on a DynamoDB failure, PR37), so a
  seeding shortfall fails the setup, never a WI11 / WI18 case.
- WL-S6-3: the roster case's mutation is ONE UpdateCommand
  `SET groupThreadId = :g, rosterVersion = :v, #roster = :r` with
  `#roster` -> `roster` and a one-entry roster `[{ contactId }]`
  (`RosterEntry`, `lib/rosterResolution.ts:57`; `TourItem.roster` /
  `rosterVersion`, `toursRepo.ts:95-97`). Still "changes nothing".
- WL-S6-4: the run detail reads its properties' flags with S3's
  `mapWithConcurrency(unitIds, deps.config.rankingReadConcurrency, ...)` and
  concatenates in `unitIds` order (`flags = perUnit.flat()`), as the read
  does; any failed read still fails the whole list (`flagsUnavailable:
  true`, `flags: []`). Test "WL-S6-4: reads the properties' flags at most
  RANKING_READ_CONCURRENCY at a time, listed in result order"
  (RANKING_READ_CONCURRENCY 2, five properties, the first answering last:
  max in flight 2, flags in result order) - red on the plan's loop (section 3
  item 9), green after. A PIN "(PIN) a property flag read that fails says
  flagsUnavailable and lists no flag" covers the failure path the plan had
  no case for.

## 6. Contradictions (plan 10.1) and the decisions taken under the plan

- 1 / 2 / WI17: the limiter and the roles as section 4 WI17 says.
- 3: `router.use('/admin/rankings', ...)` beside `/ai-runs`; no other
  `/admin` mount exists; all three admin routes are GETs; the `/api` prefix
  already covers CloudFront (`cloudfrontBehaviors.test.ts` green).
- 4: the press's `requestId` is the correlation context's
  (`getContext()?.requestId`, else a new one) and its traceparent is
  `currentTraceparent()` (the inbound one when valid, else fresh) - "the
  press carries the request id and the inbound traceparent" and "without an
  inbound traceparent the press carries a fresh valid one".
- 5 / PR16 / BA3 / FB4: over the ceiling the read answers 200 with the anchor
  block (display from `PoolFailure.anchorRecord`, `anchorNotes`, `missing`
  from S3's `poolTooLargeMissing`), `cardChanged: false`, `rows: []`,
  `flags: []`, `poolTooLarge: { size, message }` with the pool's own
  `POOL_MESSAGES.poolTooLarge(size)` text, and computes no pair; a throw in
  `poolTooLargeMissing` (the anchor's own landlord read) is 503.
- 6 / PR17: a 503 comes from the anchor's own reads (the gatherer's
  `anchor_unreadable`; a property anchor's own flag read), plus the three
  kept cases - `org_list_failed`, an incomplete matches read, a failed job
  read - and a gatherer throw. PR17's text (the binding ruling) already
  confirms the three kept cases ("a failure that leaves the whole read
  without an answer still answers 503"), so nothing was left for the
  planner. A candidate's incomplete reads mark only its row `unverified`;
  with no facts every failed cap-eligible key counts as recorded and no flag
  as open; a candidate property whose flag read failed keeps its facts'
  recorded keys, counts no flag open, and reads `unverified`. No flag read
  is made for a property whose facts are unknown.
- 7 / PR14 / IR19: the run detail's names are S7's (section 8).
- 8 / IR20 / PR34 / R2B6: the cost groups by ISO week AND environment;
  `to` defaults to today (UTC), `from` to the Monday 11 weeks before `to`'s
  ISO-week Monday (12 ISO weeks); the list and the cost read S2's
  summary-only `listRuns` and carry `incomplete: true` from any page.
- 9 / PR24: the split ceiling (5 s under `RANKING_READ_BUDGET=1`, 20 s
  otherwise); numbers in section 4.
- 10 / IR29: the read's own reads are one consistent job read, the matches
  BatchGet and one flag query per property in view (a tenant anchor's bounded
  by RANKING_READ_CONCURRENCY via `mapWithConcurrency`); WL-S6-4 gives the
  run detail the same bound.
- 11 / FB19: the property-anchor tie order is S3's `sortRecencyAt` (an
  imported, never-heard tenant sorts by `created_at`).
- 12 / PR38 / PR43: no new read code - one test per anchor kind ("not
  scored - retry" rows and an older match `failedBatch`).
- 13 / PR30: the integration config names its local `DYNAMODB_ENDPOINT`.

## 7. Deviations from the plan text

All sanctioned by the WORKLIST or the brief; no behavior change beyond
WL-S6-4.

- `src/routes/adminRankings.ts`: WL-S6-4 - the flag loop becomes
  `mapWithConcurrency` (with a three-line comment) and the file imports
  `mapWithConcurrency` from `../services/ranking/pool.js` (13 diff lines
  against the plan block). Otherwise identical.
- `test/adminRankingsApi.test.ts`: WL-S6-4 - `config()` takes an optional
  env, `makeApp` gains `flagsFor` and `configEnv` options (the default flag
  read unchanged), and two cases (the WL-S6-4 case and the flagsUnavailable
  PIN) with a shared `tenantRun` / `openFlagOf` pair of builders. Every plan
  case is unchanged.
- `test/rankingRead.integration.test.ts`: WL-S6-1 (prefix), WL-S6-2
  (`batchPut` throws; two `unwritten` assertions), WL-S6-3 (the roster
  fields), each with a one-line comment. Every case and expectation is the
  plan's.
- S6.3 / S6.2 REDs: as D6-1 / D6-2 restate them (section 3), not as the plan
  words them.
- S6.6: the app workspace suite instead of the root `npm test` (the brief).
- Commit bodies add the WORKLIST and RED notes; every subject is the plan's.
- No one-value test fix: every hand-worked value held (the eight band
  boundaries, every cap and out-of-date case, the five sort orders, the
  admin pairs, the ISO weeks, the cost ranges and totals).

## 8. The wire contract S7 consumes (as built)

Types: `RankingRead*` from `app/src/services/ranking/readRanking.ts`,
`RankingJobView` from `app/src/services/ranking/job.ts`.

- `POST /api/rankings/:anchorKind/:anchorId/rank`, body
  `{ includeOlder?: boolean }` (admin and va): 202 `{ job: RankingJobView,
  joined: boolean }`; 400 `{ error: 'invalid_anchor_kind' |
  'invalid_anchor_id' | 'invalid_include_older' }` (`anchorKind` is `unit` |
  `tenant`; the id is trimmed, blank is 400); 404 `{ error:
  'anchor_not_found' }` (PR21); 409 `{ error: 'ranking_running', message:
  'A ranking is running for this record. Try again when it finishes.' }`;
  429 `{ error: 'rate_limited' }` with an integer `Retry-After` header. The
  limiter counts every POST (400s included), per user. A tenant anchor's
  `includeOlder` is forced false by the claim (it always joins a live job).
- `GET /api/rankings/:anchorKind/:anchorId?includeOlder=true|false` (admin
  and va; absent or empty = false; anything else 400 `invalid_include_older`):
  200 `{ anchor, job, rows, flags, poolWindowDays, poolTooLarge? }` where
  - `anchor`: `{ kind, id, display, anchorNotes: ('not_searching' |
    'not_sendable' | 'not_available')[], missing: { key, label }[],
    cardChanged: boolean }`;
  - `job`: `RankingJobView | null`;
  - `rows`: `RankingReadRow[]`, SORTED (charter 9.2; unranked last in pool
    order);
  - `flags`: `{ unitId, field, reason, runId, raisedAt }[]` - the OPEN
    unlawful flags of the properties in view (the anchor unit, or each
    candidate property);
  - `poolWindowDays`: RANKING_POOL_WINDOW_DAYS (PR26: "Include tenants not
    heard from in N days");
  - `poolTooLarge?: { size, message }` (PR16; then `rows: []`, `flags: []`,
    `cardChanged: false`, and `anchor.missing` IS populated - check it
    first).
  404 `{ error: 'anchor_not_found' }`; 503 `{ error: 'ranking_unavailable',
  message }` (the message is the gatherer's when it gave one, else
  'The ranking could not be read. Try again.').
- `RankingReadRow`: `{ candidateId, tenantId, unitId, display, hasConsent?
  (tenant rows), priority? (property rows), notRankedYet: boolean,
  notScored: boolean, match: RankingReadMatch | null }`. `notScored` = no
  match AND the anchor's last job listed the candidate (`failedBatches` or
  `notScored`, PR13) - "not scored - retry"; `notRankedYet` = no match and
  not listed.
- `RankingReadMatch`: `{ score, band: 'strong' | 'good' | 'possible' |
  'weak' (Weak when capped), capped, capReason: 'requirement not met' |
  null, for: { text, source }[], against: { text, source }[], missing: {
  key?, text }[], failedRequirements: string[], fairHousingFlags: { kind:
  'unlawful' | 'accommodation', field }[], computedAt, model, runId,
  outOfDate: ('card' | 'pairHistory' | 'age' | 'version' | 'failedBatch' |
  'unverified')[] }` (reasons in that fixed order; `[]` = current).
- `RankingJobView` (S5 `jobView`): `{ status: 'queued' | 'running' | 'done'
  | 'failed' | 'expired', generation, includeOlder, requestedAt,
  startedAt?, finishedAt?, poolSize?, batchCount (0 until built),
  batchesDone: number[], failedBatches: { index, candidateIds, failure }[],
  notScored: { candidateId, reason: 'omitted' | 'unreadable' }[], message? }`
  (`expired` is derived for a queued record past its expiry, with
  'The ranking was not picked up. Press Rank again.').
- `GET /api/rankings/:anchorKind/:anchorId/job` (admin and va; what the page
  polls; unmetered): 200 `{ job: RankingJobView | null }`; 400 on a bad
  anchor.
- `GET /api/admin/rankings/runs?from&to&anchorKind&anchorId&cursor&limit`
  (admin only; anchor both or neither; `from` / `to` are YYYY-MM-DD real
  dates; limit default 25, max 100): 200 `{ runs, nextCursor?, incomplete?:
  true }`; a live row `{ runId, expired: false, startedAt, finishedAt,
  anchorKind, anchorId, anchorDisplay (always a string; the id when nothing
  resolves), direction, batchIndex, candidateCount, driver, model, costUsd,
  latencyMs, outcome: 'scored' | 'failed', failure?, environment }`; an
  expired or unread run's row `{ runId, expired: true }`; 400 `{ error:
  'invalid_from' | 'invalid_to' | 'invalid_anchor' }`.
- `GET /api/admin/rankings/runs/:runId` (admin only): 200 `{ run,
  anchorDisplay, input: string | null, pairs, flags, currentUnavailable?:
  true, flagsUnavailable?: true }`; `run` is the stored record less
  `itemId`, `inputGzip`, `handles`, `results` (so `rawText`, `usage`,
  `matchesWritten: { count, at }`, `inputOmitted?` ride along); a pair is
  `{ candidateId, handle, display, returned, score?, band? (bandOf; 'weak'
  when cappedAtRun; both absent when not returned), cappedAtRun: boolean,
  capReason, for, against, missing (the MERGED list), unknowns,
  failedRequirements, fairHousingFlags, currentRunId: string | null,
  sinceRescored: boolean }`; `flags` as the read's; 404 `{ error:
  'run_not_found' }`.
- `GET /api/admin/rankings/cost?from&to` (admin only): 200 `{ environment
  (this deployment's appEnv), weeks: { week: 'YYYY-Www', environment, runs,
  inputTokens, outputTokens, costUsd }[] (week desc, then environment asc),
  totalUsd, truncated: boolean, incomplete?: true }`; a missing `to` =
  today (UTC); a missing `from` = 12 ISO weeks ending with `to`'s week; 400
  `invalid_from` / `invalid_to`.
- Errors: the read GET never throws (503 instead). A repository throw in the
  rank POST, the job GET or an admin route reaches the app's generic Express
  5 error handler (`createExpressErrorHandler`, a 500) - the plan's design;
  S7's page should treat any non-2xx as "try again".

## 9. QUESTIONS

None.

## 10. For S7 - what S6 shipped

- Exports (exact names). `services/ranking/readRanking.ts`:
  `OutOfDateReason`, `PriorityStrength`, `RANKING_UNAVAILABLE_MESSAGE`,
  `RankingReadMatch`, `RankingReadRow`, `RankingReadFlag`,
  `RankingReadAnchor`, `RankingRead` (`{ kind: 'ok', ... } | { kind:
  'not_found' } | { kind: 'unavailable', message }` - the route strips
  `kind`), `RowContext`, `currentRankingModel`, `inLastJob`,
  `outOfDateReasons`, `buildRow`, `sortRows`, `anchorDisplayOf`,
  `RankingReadDeps`, `readRanking`, `createRankingReadDeps({ config, logger,
  env?, doc? })`. `routes/rankings.ts`: `RankingsRouterDeps`,
  `createRankingsRouter`. `routes/adminRankings.ts`:
  `AdminRankingsRouterDeps`, `createAdminRankingsRouter`, `isoWeekOf`,
  `COST_DEFAULT_WEEKS` (12), `costRange`, `defaultCostRange`.
- Test seams: `buildApp({ api: { rankings: { claim?, read?, getJob?, now?,
  contactsRepo?, unitsRepo? }, adminRankings: { runsRepo?, matchesRepo?,
  contactsRepo?, unitsRepo?, propertyFacts?, now? } } })`.
- The hermetic lane raises RATE_LIMIT_RANK_PER_MIN to 100000 (S5,
  WL-S5-6); the 429 is proven at route level here (`rankingsApi.test.ts`,
  its own ceiling of 2). An e2e spec that wants a 429 must set the env var
  itself.
- The page polls `GET .../job` (unmetered); reads are unmetered too.
- Sorting is server side: render `rows` in the order given. Band and cap
  are derived on every read (a threshold or setting change needs no
  re-rank).
- The cost and runs list may say `incomplete: true` ("Some runs could not be
  read; totals may be low", PR34); the run detail may say
  `currentUnavailable` (the current-match lookup failed: every
  `currentRunId` is null, NOT "nothing re-scored") or `flagsUnavailable`.
- The read's integration world (`test/rankingRead.integration.test.ts`)
  shows a complete fixture set on DynamoDB Local (prefix `hc-test-rkread-`)
  if an S7 or S8 test needs one.

## 11. Untrimmed input

None new untrimmed. The rank, read and job routes trim the anchor id
(`parseAnchor`); the admin routes trim `runId`, `anchorKind`, `anchorId`,
`cursor`, `from` and `to` (`optionalString`); `includeOlder` is a strict
boolean (body) or a strict `true` / `false` (query); the anchor kind is
compared exactly (`unit` / `tenant`, case-sensitive - a code, not typed
text; the page sends it).
