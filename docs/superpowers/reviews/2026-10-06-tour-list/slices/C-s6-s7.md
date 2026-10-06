# Slice C report - S6, S7 (implementer C)

Implementer: Claude Opus 5.5, 2026-10-06 (17:47-18:05 EDT). Worktree
`W:\tmp\tour-list`, branch `feat/tour-list`, started at HEAD 4299c797, ended at
db467e66 (plus this report's commit). Inputs: plan v3 sections 0, 1, S6 and S7;
`build-research/app-worklist.md` (Task 6.1, 6.2, 7.1 items 16-20, G5, G7);
`build-research/README.md` rulings A-4, A-5, A-6; slice B's report (the fake's
tie guard and out-of-bounds text); spec 5.1-5.7 and 9.

Every task ran strict TDD: test written, run RED and read for the stated
reason (6.2: see below), implementation, run GREEN, one commit. DynamoDB Local
was up throughout and was never restarted, stopped or removed. Every run's
output was captured to a file and swept for `[dynamoAdmin]`: 0 hits.

## Commits

| task | commit | message |
|---|---|---|
| 6.1 | b52329a3 | feat(app): tour list paging engine |
| 6.2 | afbe5d3b | test(app): the tour list engine over DynamoDB Local |
| 7.1 | db467e66 | feat(app): GET /api/tours/list - the All tab's paged read |

## Task 6.1 - listTourPage

- Files: NEW `app/src/services/tourListPage.ts` (the plan's GREEN code
  verbatim), NEW `app/test/tourListPage.test.ts`.
- RED: the file failed to load - `Cannot find module
  '../src/services/tourListPage.js'` (no tests ran): the module did not exist.
- GREEN: 13/13 (the plan's 12 cases + one addition).
- The recorder wraps `queryListPhaseFromItems` and records every call's
  `{ kind, index, limit, startKey, forward }` (absent keys absent, so the call
  lists compare with `toStrictEqual`). Phases come from `planTourListPhases`,
  fingerprints from `tourListFingerprint`. Every fixture row has
  `_schedPartition: 'tours'`, a full toISOString() `scheduledAt` when dated,
  and a file-unique createdAt (no ties anywhere in the file).
- Every resume goes through the cursor's WIRE form: encode -> decode ->
  `locateTourListCursor`, so each cursor the engine emits is also proven to
  decode and to fit its own plan.

## Task 6.2 - the engine over DynamoDB Local

- File: `app/test/toursRepo.integration.test.ts` - the line-18 import widened
  (isUnfilteredPhase, locateTourListCursor, planTourListPhases,
  tourListFingerprint, type TourListFilters), one new import line
  (listTourPage, type TourListPageResult), and a NEW top-level describe at the
  end with its own `hc-test-${randomUUID().slice(0, 8)}-` prefix (per-describe
  setup only - worklist item 9).
- Fixture: 7 dated rows (scheduled, toured, no_show, canceled, closed,
  scheduled, closed - two DATED closed), 2 requests, 1 undated toured, no
  undated closed; scheduledAt `2028-02-0NT10:00:00.000Z`, createdAt
  `2028-01-NNT09:00:00.000Z`, all distinct, all canonical (A-4).
- Walks (`when: 'any'`, `limit: 2`, `{ queryPageLimit: 2, maxQueryCalls: 1 }`,
  at most 50 pages, decode-free via `locateTourListCursor`): latest, earliest,
  and `statuses: ['no_show']`.
- Asserted: every id exactly once and in order (dated latest/earliest first,
  then r2/r1 or r1/r2, then the undated toured - spec 9's undated-after-dated
  in BOTH directions); a budget-stop EMPTY page with a non-null cursor; a
  k-less `u` cursor; no `d` cursor without k; one Query per page; the sparse
  walk reaches its one no-show through empty `d`-cursor pages and ends null.
  Ruling A-6: on every page whose Queries all read an UNFILTERED phase D,
  `evaluated <= returned + 1` (non-vacuous: at least 3 such pages per walk).
- RED: GREEN on its first run, 77/77 (74 existing + 3 new) - exactly what the
  plan predicts ("nothing new if 6.1 is right"). Teeth shown with two
  TEMPORARY engine mutants, each reverted with the Edit tool and confirmed by
  an empty `git diff -- app/src/services/tourListPage.ts`:
  - A: resume a full page from the batch's lastEvaluatedKey instead of the
    last row SENT -> 7 red: 6.1 cases 1, 5, 8, 10, 12 and BOTH DynamoDB walks
    (rows skipped: the walk's sorted ids lacked tour-lp-d2).
  - B: the peek over-reads (`needed + 2`) -> 7 red: 6.1 cases 1, 2, 5, 6, 11
    and both DynamoDB walks on A-6 ("latest unfiltered-D page 0: expected 4
    to be less than or equal to 3").
- GREEN after the reverts: 90/90 over both engine files.
- 6.2 NEVER disagreed with 6.1: the shared fake model and its mirror test were
  not touched.

## Task 7.1 - GET /api/tours/list

- Files: `app/src/routes/tours.ts` (imports after the toursRepo import; the
  header route-table line as a NEW line after line 7; the `now` doc comment
  rewritten in ASCII; module-level `toTourListRow` after `parseActivityLimit`;
  the route after `router.get('/')` - now :398 / :440 / :532 for '/', '/list',
  '/:tourId'); `app/test/toursApi.test.ts` (`vi` added to the vitest import,
  three new import lines, a NEW `describe('GET /api/tours/list')` at the end).
  The route and toTourListRow are the plan's code verbatim.
- RED: 10/10 new cases failed, each because 'list' fell through to
  `GET /:tourId` - `404 {"error":"tour_not_found"}` against an expected 200 or
  400; the 214 existing cases were skipped by the `-t` filter.
- GREEN: 224/224 (214 existing + 10 new) - no existing toursApi test broke.
- Route teeth: two TEMPORARY route mutants, each reverted with Edit (the final
  diff shows only the intended lines): ignoring the cursor's `n` -> case 3 red
  (`400 invalid cursor` on page 2 - the model rejects the start key, as
  DynamoDB does); dropping the canonicalization -> case 3 red (the cursor's
  `n` read '2026-10-06T16:00:00Z').
- Typecheck after the commit: `npm run typecheck` exit 0, all five workspaces.

## Divergences from the plan and the worklist

1. Worklist item 18 quoted the 500's log line as 'unhandled error while
   handling request: GET /api/tours/list'. The real line is
   'unhandled error while handling request: GET /list' - by the time the
   error unwinds to the app-level handler Express has restored `req.baseUrl`
   to '', so `routeLabel` (errors.ts:155-159) yields the router's leaf
   template. Case 9 pins the real text, with a comment. Pre-existing for every
   router; not changed here (out of scope).
2. 6.1 case 12 is two things: the `page()` helper asserts "a d cursor carries
   k" on EVERY page of cases 1-11 (the plan's form), and case 12 itself is a
   self-contained sweep - 6 filter sets x 4 limits x 4 budgets = 96 walks to
   null, each compared to an oracle of the complete list (dated by
   scheduledAt, then each picked U_ORDER status's undated rows by createdAt),
   counting the cursors it saw (> 20 d, > 5 k-less u) so it is not vacuous.
3. 6.1 addition: case 13 pins the route defaults (QUERY_PAGE_LIMIT 200,
   MAX_QUERY_CALLS 5 when nothing is injected; a filtered call asks 200).
4. 6.1 case 7 injects `maxQueryCalls: 2` (the plan's "3 unless stated"): the
   case needs requested exhausted ON the last budget call. Its resume also
   checks that `i: 1` (U_ORDER index) maps to PHASE index 2.
5. 6.2's query function wraps `tours.queryListPhase` to record which phase
   each Query read (A-6 needs "unfiltered-D page"); it still calls the real
   repo once per Query, unchanged.
6. 7.1 additions inside the plan's cases: case 1 adds `to` alone without
   range, `limit=101` and `limit=2.5`; case 2's projection checks every row's
   keys are a subset of the 12 spec fields, and the fixture carries roster,
   rosterVersion, currentLadderId, conversionClaimedAt, lastMarkedAt (item 19)
   and autoClosedFrom, each asserted absent; case 3 asserts the decoded
   cursor `n` (canonical in both walks) and walks `when=past` at the advanced
   clock; case 4 proves phase D skipped for `status=requested` through the
   log line (`calls: 1, phases: 1`); case 8 spies `world.toursRepo.get` (never
   called); case 9 proves its cursor pages (200) BEFORE injecting the throw,
   via `vi.spyOn(...).mockRejectedValue` + `mockRestore` (item 18's first
   option); case 10 also checks the line holds no name or phone.
7. ASCII/G7: the header line was anchored on the ASCII line 7 (activity), so
   no arrow line was re-emitted; the `now` doc comment's em-dash line and the
   line after it were rewritten (both ASCII); the route lands above the
   em-dash comment of `GET /:tourId` without touching it. Added lines of both
   edited files: 0 non-ASCII bytes; both new files: 0.

## Surprises

- `when=any` with every status plans SIX phases (D + 5 U) against a budget of
  FIVE Queries, so a first page that does not fill can never finish such a
  list in one request: even an EMPTY table answers page 1 with
  `{ tours: [], nextCursor: <u, i: 4, no k> }` and page 2 with null; a small
  world shows every row except the undated closed ones on page 1, plus a
  cursor. Spec-consistent (5.4's budget; 4.5's empty-page follow absorbs it),
  but S11/S12 and the e2e walk should expect it: every unfilled when=any
  first page carries a cursor.
- The 500 log label (divergence 1).
- 6.2 needed no fix: the shared model held on DynamoDB Local for every page
  of the three walks.

## Gates run here

- App `tsc -p tsconfig.test.json --noEmit`: exit 0 before each of the three
  commits.
- `npm run typecheck` after the 7.1 commit (db467e66): exit 0.
- Gate-5 form on this slice's files (`git diff --name-only --diff-filter=d
  4299c797..HEAD -- '*.ts' ...` = tours.ts, tourListPage.ts,
  tourListPage.test.ts, toursApi.test.ts, toursRepo.integration.test.ts):
  `npx eslint <files>` exit 0, no output.
- Final targeted run: tourListQuery 25, tourListPage 13,
  dynamoAccessKeyGuard 15 (the new table-creating describe passes the guard),
  tourListIndexFakeMirror 8, toursRepo.integration 77, toursApi 224 -
  362/362.
- Not run, per the brief: full `npm test`, `npm run e2e`, `npm run smoke`.

## Left undone

- Nothing in S6-S7.
- For the orchestrator (not filed): the leaf-only error label above may be
  worth a low issue - a 500 on any router logs `GET /list`-style labels that
  do not name the mount.
