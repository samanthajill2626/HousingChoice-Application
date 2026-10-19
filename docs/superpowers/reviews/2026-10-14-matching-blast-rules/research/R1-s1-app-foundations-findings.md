# R1 - S1 App foundations - research findings

Reader R1. Slice S1 = plan section 5 (plan lines 662-3930, Tasks 1.1-1.5),
checked against the live tree `W:/tmp/matching-blast-rules` @01782138 (code ==
main @a2b3d80d). The byte-exact backing (anchor table, fact table, importer
and invariant tables, cross-slice contract, baseline runs) is in the gitignored
`.superpowers/sdd/R1-s1-app-foundations-reference.md`.

Result in one line: all 21 old_string anchors are FOUND byte-exact and UNIQUE
at base; every "Facts the tasks rely on" bullet holds; no importer, writer or
reader of a stored `audience_filter` is left uncovered; the S1 -> S2/S3
contract matches binding 2.1-2.6. Two instruction corrections and three notes
follow. No BLOCKING item, no GAP.

Severity counts: BLOCKING 0, CORRECTION 2, GAP 0, NOTE 3.

---

## R1-1 - CORRECTION - Task 1.2 Step 7 still says "stop and ask the human" for DynamoDB Local

- Plan location: section 5, Task 1.2 Step 7, plan lines 1928-1930 ("if it
  reports SKIPPED, DynamoDB Local is down - stop and ask the human").
- Ruling: AR2 + AR29 (section 4.1) - "START it if it is not up; never RESTART
  it. An unattended build must not stall on this." AR29 names only "S1's
  preflight" (plan lines 854-855), so the second instance of the same
  instruction in Task 1.2 Step 7 is not covered by any ruling text.
- Live evidence: a down DynamoDB Local makes the per-file run FAIL in
  globalSetup (`app/test/globalSetup.ts:14-17` and its fetch/catch near
  `:65-80`), unless `ALLOW_SKIP_DYNAMO_TESTS=1` is set; only then does
  `toursRepo.integration` print its SKIPPED banner and skip
  (`app/test/toursRepo.integration.test.ts:45`, `:50` `describe.skipIf(!reachable)`).
- Correction: replace the clause with "if globalSetup fails on an unreachable
  endpoint, or `toursRepo.integration` reports SKIPPED, run `npm run db:start`
  (a start - never restart the shared container) and re-run; never run this
  step with `ALLOW_SKIP_DYNAMO_TESTS=1`". Apply the same reading to the
  preflight (AR29) and to every later "needs DynamoDB Local" run in S1.
  (Related, no change needed: AR1 makes the preflight `npm ci` a check - the
  deps are installed, `node_modules/.package-lock.json` dated 2026-10-14;
  re-running `npm ci` would only delete and reinstall them.)

## R1-2 - CORRECTION - Task 1.3 Step 3 states a wrong RED reason for the leaky-index case

- Plan location: section 5, Task 1.3 Step 3, plan lines 2529-2530 ("the
  leaky-fence case returns `c-placing` and duplicates").
- Live evidence: the old resolver makes ONE un-narrowed walk
  (`app/src/services/audienceResolution.ts:133-191`, a single
  `listByType('tenant', { limit, exclusiveStartKey })` loop with no status).
  The leaky fake answers all five rows once with no cursor, the type fence
  (`:159`) drops the partner and the landlord, so the case gets
  `['c-s', 'c-o', 'c-placing']` - no duplicate. It is red, but only because
  `c-placing` (status `placing`) is resolved.
- Correction: read the expected RED as "the leaky-fence case returns
  `c-placing` (no status fence)". Duplicates are what the AR4 belt prevents in
  the NEW two-partition walk; they never appear on the old code. (An
  implementer checking "red for the stated reason" should not stop on this.)

## R1-3 - NOTE - AR3's ruled parse edge cases have no test

- Plan location: section 4 AR3; section 5 Task 1.4 Step 2 (the new describe,
  plan lines 2975-3133) and Step 5 (parser code, plan lines 3217-3267).
- Live evidence: the Task 1.4 code implements all three AR3 rules - `null`
  reads as absent for both keys, the legacy key keeps
  `audience_filter.housing_authority must be a non-empty string`, and the
  both-keys 400 is decided before either value's shape - but no Task 1.4 test
  pins any of them, and no existing app test pins the legacy message either
  (grep `non-empty string` in `app/test/broadcastApi.test.ts`: no hit).
- Suggestion (optional, no change required): one table-driven case in the
  Task 1.4 describe - `{ housing_authorities: null, housing_authority: 'atlanta_housing' }`
  -> 201 stored `['Atlanta Housing Authority']`; `{ housing_authority: '  ' }`
  and `{ housing_authority: 7 }` -> 400 with the legacy message;
  `{ housing_authorities: 'x', housing_authority: 'y' }` -> 400
  `audience_filter: use housing_authorities only`.

## R1-4 - NOTE - the results and list projections now dereference the stored filter

- Plan location: section 5, Task 1.5 Step 5 (plan lines 3673-3706) and the
  binding `wireAudienceFilter(filter: AudienceFilter)` (2.1).
- Live evidence: today `toBroadcastResults` / `toBroadcastSummary` pass
  `b.audience_filter` through untouched (`app/src/routes/broadcasts.ts:393`,
  `:421`); after Task 1.5 every row goes through `wireAudienceFilter`, which
  reads `filter.bedroomSize` / `filter.excludeOptedOut`, so a row WITHOUT an
  `audience_filter` would throw and 500 the whole `GET /api/broadcasts` page.
- Reachability: none found. Every writer sets the field - the create route's
  parse always returns a full filter (`broadcasts.ts:592`, even for `{}`), the
  repo create requires it (`app/src/repos/broadcastsRepo.ts:386`, stored at
  `:729`), both seeds carry one (`app/src/lib/seed/matrix.ts:1224`, `:1257`;
  `app/src/lib/seed/performance.ts:1039`), no job, script, import or dev seam
  writes a broadcast row, and the byCreated GSI projects ALL
  (`app/src/lib/tables.ts:14`). Recorded so a reviewer does not re-derive it;
  no change required.

## R1-5 - NOTE - S2's "Notes for other slices" is stale about S1's footprint (harmless)

- Plan location: section 6 (S2) "Notes for other slices", about plan lines
  6402-6408 ("S1 should not touch broadcasts.ts lines 652-705 (estimate,
  create, 201)"; "S1 owns the 'Organization names' paragraph (20-28); S2 owns
  lines 6-8 and the 'Audience:' paragraph").
- Live evidence: S1 Task 1.4 Step 7 does edit the 201 echo
  (`broadcasts.ts:697-699`), and AR9 gives S1 Task 1.5 the whole `:14-28`
  header (S2 only ADDS a sentence). Checked for collisions: no S2 old_string
  contains `:697-699` - S2 I-Edit 4 anchors `estimatedCount: estimatedAudience,`
  + the log line and I-Edit 5 anchors `status: 'draft',` +
  `estimatedCount: estimatedAudience,` (`:695-696`), both byte-identical after
  S1. The S1 import S2's I-Edit 1 merges into is
  `import { authoritiesOfFilter, MAX_FILTER_AUTHORITIES, wireAudienceFilter } from '../lib/blastAudienceRules.js';`
  (added after `broadcasts.ts:82`).
- No change required; the orchestrator should hand S2 the AR9 split, not the
  note's.
