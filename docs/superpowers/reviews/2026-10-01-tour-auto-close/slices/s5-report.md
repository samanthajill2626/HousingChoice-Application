# Slice report - S5 (the auto-close sweep)

- Date: 2026-10-02. Implementer: Claude Opus 5.5 (child of the build
  orchestrator). Branch `feat/tour-auto-close`, worktree `W:\tmp\tour-auto-close`,
  starting HEAD 880bd64c (S3-S4 report commit).
- Sources followed: plan sections 0, 1, S5 (Tasks 5.1-5.4); spec 6 (all), 7.4
  step 2, 10.1, 12; the S1-S2 and S3-S4 contracts (`slices/s1-s2-report.md`
  section 6, `slices/s3-s4-report.md` section 7); the binding corrections in
  `research/drift-s3-s7-routes-jobs.md` (6, 7, 8, 9, 15, Confirmations, flags
  R1/R3), `research/drift-s9-s10-e2e-docs.md` correction 13, and the
  orchestrator rulings F3, D-e, D-f, D-g in `research/worklist.md`.
- Scope held: exactly the twelve files the brief allowed (listed under
  "Files"). No spec, plan or other docs edits besides this report. Nothing in
  `routes/tours.ts` (S6 owns it).

## 1. Commits

| hash | task | one-liner |
|---|---|---|
| 3ad64af6 | 5.1 | feat(tours): clearRelayCloseNagOnReopen - clear the nag on a reopened tour's own group |
| 8abdaec8 | 5.2 | feat(tours): runTourAutoClose - the silent two-week auto-close sweep |
| 594f0def | 5.3 | feat(worker): start the tour auto-close poll on its own 15-minute interval |
| 003c1a7c | 5.4 | feat(dev): POST /__dev/tour-auto-close/tick - the hermetic auto-close seam |
| (this) | records | docs(records): tour auto-close S5 slice report |

Every commit: bare `git status` read first in its own call, MERGE_HEAD checked
absent (`git rev-parse --git-path MERGE_HEAD`; `.git` is a file in a
worktree), explicit paths staged, ASCII message, `Co-Authored-By: Claude Opus
5.5` trailer, committed through Bash with a heredoc. No survivor-pin commit
was needed (section 5).

Files: `app/src/services/relayCloseNag.ts`, new
`app/test/relayCloseNagClear.test.ts`, new `app/src/jobs/tourAutoClose.ts`,
new `app/test/tourAutoClose.test.ts`, `app/src/worker.ts`,
`app/src/jobs/pollLoop.ts` (comments only), `app/src/lib/config.ts` (comment
only), `app/src/routes/dev.ts`, new `app/test/devTourAutoCloseTick.test.ts`,
`e2e/support/selectors.md` (one table row), `e2e/README.md` (the tick list),
`app/src/lib/events.ts` (doc comment only).

## 2. Per task: RED reason, GREEN result

Baseline before any edit: `npx eslint` on the six pre-existing files to be
touched (relayCloseNag.ts, worker.ts, pollLoop.ts, config.ts, dev.ts,
events.ts) exit 0 - no pre-existing lint error to name.

| task | RED (run, confirmed reason) | GREEN |
|---|---|---|
| 5.1 | 11 failed, every one `(0 , clearRelayCloseNagOnReopen) is not a function` | relayCloseNagClear 11 passed |
| 5.2 | suite failed to load: `Cannot find module '../src/jobs/tourAutoClose.js'` (no tests ran) | tourAutoClose 15 passed |
| 5.3 | none by design: worker.ts self-executes on import and no test pins the poll list (drift #9) - COVERED BY TYPECHECK ONLY | typecheck exit 0; sanity pollLoop 6 + jobQueueWiring 5 passed (comment-only edits to pollLoop.ts) |
| 5.4 | 6 failed `expected 404 to be 200` / `expected 404 to be 400` (route absent); 1 PIN passed on unchanged code ("is absent when the dev router is not mounted") | devTourAutoCloseTick 7 passed; neighbours devGating 41, devJournalSweepTick 6, toursApi 214 |

Final run on the clean tree after the mutant check - 8 files, 305 passed,
exit 0: relayCloseNagClear 11, tourAutoClose 15, devTourAutoCloseTick 7,
devGating 41, devJournalSweepTick 6, toursApi 214, pollLoop 6,
jobQueueWiring 5. No `[dynamoAdmin]` line appeared in any run.

## 3. Gates run (scope: touched files + typecheck, per the brief)

- `npm run typecheck`: exit 0 after 5.1, 5.2, 5.3, 5.4 and on the final
  committed state.
- `npx eslint app/src/services/relayCloseNag.ts app/test/relayCloseNagClear.test.ts
  app/src/jobs/tourAutoClose.ts app/test/tourAutoClose.test.ts app/src/worker.ts
  app/src/jobs/pollLoop.ts app/src/lib/config.ts app/src/routes/dev.ts
  app/test/devTourAutoCloseTick.test.ts app/src/lib/events.ts`: exit 0 (also
  exit 0 per task on that task's files). No pre-existing errors in these files.
- ASCII: after every edit `git diff -U0 -- <file> | grep '^+' | grep -P
  '[^\x00-\x7F]'` printed nothing; the four new files have 0 non-ASCII bytes
  (`tr` check); a final scan of the added lines of `git diff -U0
  880bd64c..HEAD` printed nothing. Untouched non-ASCII lines remain (e.g.
  dev.ts route comments with em dashes, config.ts :590, worker.ts header) -
  the ratchet allows them.
- NOT run (outside this brief): `npm test`, `npm run smoke`, `npm run e2e`.
  Note for S11: worker.ts gained `import type { TourAutoCloseDeps }` (erased
  by tsc, so the OTel-first rule and the compiled import graph are
  unchanged); tourAutoClose.ts value-imports `node:crypto`,
  `../lib/toursModel.js`, `../lib/logger.js`, `../lib/tourEvents.js`,
  `../services/relayCloseNag.js` - plain file imports with `.js`, which is
  what the smoke gate resolves.

## 4. Divergences from the plan, and why

Binding corrections applied:

1. F3 (Task 5.1) - getOwner WAS used. `getOwner(conv)` is an exported function
   (`conversationsRepo.ts:385`), so the helper calls it directly; the value
   import joins the existing one (`relayCloseNag.ts:25` already imported
   `CLOSE_NAG_INTERVAL_MS` from the same module - no new edge, no cycle).
   Rule: clear only when `getOwner(conversation).type === null` or it is
   `{ type: 'tour', id: tourId }`. Test case added: legacy `placementId` only,
   no `owner` -> NOT cleared. Consequence versus the plan's literal rule (not
   pinned, consistent with every other getOwner reader): a malformed
   `owner: { type: 'tour' }` with no id resolves to `{ type: null }` and IS
   cleared, where the literal rule would have skipped it.
2. D-e (Task 5.1): the deps type is the ruling's shape as a named exported
   interface, `ClearRelayCloseNagDeps { conversationsRepo:
   Pick<ConversationsRepo, 'getById' | 'setCloseNagNextAt'>; logger?: Logger }`
   (`relayCloseNag.ts:71-74`), so the test's two-spy repo typechecks without
   a cast and S6 can pass the full repo.
3. Drift #6 (Task 5.1): the header is `:1-16`; it was extended (arm trigger
   list names the auto-close sweep; a new CLEAR ON REOPEN paragraph) in
   ASCII. New file `app/test/relayCloseNagClear.test.ts` (no unit test of the
   service existed).
4. D-f / drift #8 (Task 5.2): `events: world.events`, asserted on
   `world.emitted`; the CLOCK TRAP is handled by a `seedTour` helper that
   pins `world.toursMap.get(id)!.updatedAt` (to the case's intended last
   change, default its `createdAt`) after EVERY create, and every case's
   `now` derives from those values.
5. Drift #9 (Task 5.3): no test pins the poll list, so nothing to extend.
   Comment-only refreshes: worker.ts wrapper comment (six shared-cadence
   call sites; the auto-close poll calls startPollLoop directly),
   pollLoop.ts header (one sentence: the journal sweep and the auto-close
   poll joined, seven loops today; the "same lesson" sentence made
   count-free) and the `intervalMs` doc, config.ts's WORKER_POLL_INTERVAL_MS
   comment. That comment said FIVE; the shared-cadence polls were already
   SIX (the journal sweep was missing) - it now says SIX and names the
   auto-close exception.
6. D-g / drift #7 (Task 5.4): the tick test uses the devGating world-fake
   shape (`createDevRouter({ config, logger, tourAutoCloseDeps: { ...world } })`
   then `makeWebhookHarness({ world, devRouter })`), not the journal-sweep
   stub shape.
7. Drift s9-s10 #13 (Task 5.4): `e2e/support/selectors.md` got one
   `| Dev seam | ... |` TABLE row right after the roster-actions tick row
   (now `:109`), text from the reference draft; `e2e/README.md` tick list
   `:588-590` (rewrapped to three lines). The pre-existing omission of the
   journal-sweep seam in both lists was left alone.
8. Drift #15: the TourUpdatedEvent doc (`events.ts:231-241`) now names POST
   /api/tours/:tourId/reopen (S6 - not built yet) and the auto-close sweep
   (worker poll, bridged, and the dev tick) as emitters.

Chosen within the plan's latitude:

9. Task 5.3 placement: the plan says "after the tour-reminder poll block"; the
   block is LAST instead (after the journal sweep, `worker.ts:526-570`).
   Right after the tour-reminder block, the roster block's comment "the same
   stateless 60s cadence as the two polls above" would have become wrong
   (three polls above, one on its own cadence). Last, every neighbour comment
   stays true except the guardrail block's "Same shared poll as every other
   block", which a differently-cadenced poll falsifies wherever it sits - it
   now reads "Same shared poll as the blocks above" (comment-only, same file).
10. Typed deps literals (Tasks 5.3, 5.4): the worker's literal is annotated
    `const tourAutoCloseDeps: TourAutoCloseDeps` (type-only import at
    `worker.ts:16`, beside the existing `import type { SqsJobConsumer }`),
    and the dev tick's lazy `??=` literal gets the same check from its typed
    variable. An extra field such as `adapter` in either literal is a TS2353
    error (mutants f, g) - "exactly the eight deps" is enforced at both
    construction sites, not just by review.
11. Task 5.2 tests beyond the plan's 11 cases (all additive, none dropped):
    constants pin (900000 ms, exact label); the info lines (one per close
    with `tourId` + `from`, the run summary only when closed or failed > 0);
    `autoClosedAt` / `updatedAt` are wall clock and the pointer is a fresh
    UUID; the non-candidate case also runs through the `tourIds` path
    (scanned 7, due 0 - requested / canceled / closed are read and refused);
    a failing reminder sweep is its own case (the plan's case 9 keeps the
    audit failure); a COMPILE-TIME pin that `keyof TourAutoCloseDeps` is
    exactly the eight names (`expectTypeOf`; verified - adding
    `adapter?: unknown` fails typecheck with TS2344); the `tourIds` reads are
    consistent and `listByStatus` is not called; an unparseable `now`
    rejects.
12. Task 5.4 tests beyond the plan: exactly 50 ids accepted (the cap is
    inclusive; with the 51-id 400 it kills mutant e); the wall-clock default
    `now`; `null`, an object and a bare string as `tourIds`; no sends on the
    tick; the not-mounted 404 PIN.
13. Tick placement: right after the tour-reminders tick (`dev.ts:432-484`),
    before the placement-nudges block, so the tour-reminders comment's "the
    placement-nudge tick below" stays true.
14. Otherwise the plan's code is verbatim: the job module (the
    `recordTourEvent` deps are the plan's `{ activityEvents, units, audit, log }`,
    which is exactly `TourEventDeps` with `activityEvents` REQUIRED), the
    tick handler, and the nag-clear body except the owner resolution.

No STOP condition was hit: no unexpected importer (only worker.ts and dev.ts
import the job; only tests import the new helper), no import cycle, no
contract mismatch with the S1-S4 reports or the reference quotes, no
unpredicted red in an existing test.

## 5. Mutant check (applied with Edit, reverted with Edit; `git diff --quiet` clean after each)

| id | mutant | result |
|---|---|---|
| a | job: `isAutoCloseDue(tour, nowMs)` -> `autoCloseDueAtMs(tour) <= nowMs` (the JS null trap) | KILLED by "skips every non-candidate": `{ due: 2, lost: 2 }` for `{ due: 0, lost: 0 }` (the decided and `pending:` tours reached the write; the repo's own refusal still kept them open) |
| b | job: `summary.lost += 1; continue;` removed (as specified) | KILLED by the lost-write case - the run rejects with `TypeError: Cannot read properties of undefined (reading 'tourId')` (afterClose on the undefined write result) |
| b2 (extra) | job: a lost write counted lost AND closed, `afterClose(closed ?? tour)` | KILLED by the lost-write case (`closed: 1` for 0) |
| b3 (extra) | job: counters right, but a lost write still runs `afterClose(tour)` | KILLED by the lost-write case (two `tour_auto_closed` pins for none). Note: the case's reminder assertion alone cannot see this - the lost write never rotated the pointer, so the sweep's pointer guard deletes nothing; the pins / audit / events / nag assertions carry it |
| c1 | job: `loadCandidates` ignores `tourIds` | KILLED by 3: non-candidate case (tourIds run scanned 4 for 7), the job's tourIds case, the tick's scoping case |
| c2 (extra) | tick: always passes `{}` | KILLED by the tick's scoping case |
| d | helper: owner check removed | KILLED by 3: placement-owned, another tour's, legacy placementId |
| d2 (extra) | helper: the plan's literal `conversation.owner` test (pre-F3) | KILLED by 1: the legacy placementId case (pins F3) |
| e | tick: `ids.length > 50` removed | KILLED by the malformed-tourIds case (51 ids -> 200 for 400) |
| f (extra) | worker: `adapter: undefined` added to the deps literal | KILLED by typecheck: `worker.ts(563,5): error TS2353` |
| g (extra) | dev tick: `adapter: undefined` added to the lazy deps literal | KILLED by typecheck: `dev.ts(454,7): error TS2353` |
| h (extra) | job: `tourIds` reads without `{ consistentRead: true }` | KILLED by the job's tourIds case |
| i (extra) | job: run summary logged unconditionally | KILLED by the non-candidate case |
| j (extra) | job: no `scheduled.updated` emit | KILLED by 2: the close case, the sweep-failure case |
| k (extra) | tick: `now` not normalized | KILLED by 3 tick cases (`...00Z` for `...00.000Z`) |
| l (extra) | helper: no "has a pending nag" check | KILLED by the closed / non-relay / no-nag case |
| p (extra, probe in 5.2) | `TourAutoCloseDeps` gains `adapter?: unknown` | KILLED by typecheck: `tourAutoClose.test.ts(374,7): error TS2344` |

Totals: 17 mutants (5 required + 12 extra), 17 killed, 0 survivors. After the
last revert: tree clean, the 8 files green (305), typecheck exit 0, eslint
exit 0.

## 6. Contracts the downstream slices consume (final, as committed)

`app/src/jobs/tourAutoClose.ts`:

```ts
export const TOUR_AUTO_CLOSE_INTERVAL_MS = 15 * 60 * 1000;                     // :32 (900000)
export const TOUR_AUTO_CLOSED_LABEL =
  'Tour closed automatically: no outcome recorded after two weeks';             // :35
export interface TourAutoCloseDeps {                                            // :37-49
  toursRepo: ToursRepo;
  tourRemindersRepo: TourRemindersRepo;
  conversationsRepo: ConversationsRepo;
  unitsRepo: UnitsRepo;
  auditRepo: AuditRepo;
  activityEventsRepo: ActivityEventsRepo;   // REQUIRED
  events: EventBus;
  logger?: Logger;
}
export interface TourAutoCloseOptions { tourIds?: readonly string[]; }         // :51-54
export interface TourAutoCloseSummary {                                         // :56-62
  scanned: number; due: number; closed: number; lost: number; failed: number;
}
export async function runTourAutoClose(                                         // :73
  nowIso: string,
  deps: TourAutoCloseDeps,
  opts: TourAutoCloseOptions = {},
): Promise<TourAutoCloseSummary>;
```

Behavior: rejects (`runTourAutoClose: now must be an ISO 8601 instant`) when
`nowIso` does not parse. Candidates: with `tourIds`, each id read with
`get(id, { consistentRead: true })` in parallel, missing ones dropped
(`scanned` = tours FOUND; duplicates are not deduped - a repeated id is read
twice and its second write loses); without, `listByStatus` for `scheduled`,
`toured`, `no_show` (each pages to exhaustion). Due = `isAutoCloseDue(tour,
nowMs)`. Per due tour: one `toursRepo.autoCloseIf(tour, randomUUID())`;
`undefined` -> `lost` (no side effect); a throw -> `failed` (error log
`tour auto-close write failed` `{ err, tourId }`), the run continues. A won
close logs info `tour closed automatically (no outcome after two weeks)`
`{ tourId, from }`, then, each best-effort: `deleteSupersededForTour(tourId,
rotation)` (error `tour auto-close: reminder sweep failed (rows stay refused
by the rotated pointer)`), `recordTourEvent(..., 'tour_auto_closed',
'tour_auto_closed', TOUR_AUTO_CLOSED_LABEL)`, `armRelayCloseNagIfOpen(...,
groupThreadId, 'tour')`, emit `tour.updated { tourId, status: 'closed' }`
then `scheduled.updated { contactId: tenantId }`. Run summary at info
(`tour auto-close run`, the five counters) ONLY when closed > 0 or
failed > 0. Ids only in logs. All stamps are wall clock.

`app/src/services/relayCloseNag.ts` (S6 calls it):

```ts
export interface ClearRelayCloseNagDeps {                                       // :71-74
  conversationsRepo: Pick<ConversationsRepo, 'getById' | 'setCloseNagNextAt'>;
  logger?: Logger;
}
export async function clearRelayCloseNagOnReopen(                               // :84
  deps: ClearRelayCloseNagDeps,
  groupThreadId: string | undefined,
  tourId: string,
): Promise<void>;
```

Never throws. No-op without a non-empty `groupThreadId` (no read), or when
the conversation is missing / not `relay_group` / not `open` / has no
`close_nag_next_at`, or when `getOwner(conv)` names a placement (including a
legacy `placementId`-only group) or another tour. Otherwise
`setCloseNagNextAt(groupThreadId, null)` and info `relay close-nag cleared on
tour reopen` `{ conversationId }`; a failure logs error `relay close-nag clear
failed (best-effort)` `{ err, conversationId }`. S6 call, beside the
existing `armRelayCloseNagIfOpen` import in tours.ts (`:124`):
`await clearRelayCloseNagOnReopen({ conversationsRepo: conversations, logger: log }, reopened.groupThreadId, tourId);`

The dev tick (S9 drives it): `POST /__dev/tour-auto-close/tick`
(`dev.ts:432-484`; hermetic-only like every /__dev route; mounted before the
origin gate, so no secret or cookie; `json()` scoped to the route).

- Body (JSON, both optional): `now` - a string `Date.parse` accepts,
  normalized with `new Date(now).toISOString()`; absent -> wall clock.
  `tourIds` - an array of 1..50 entries, each a non-empty string.
- 400 (checked first): `{ "error": "now must be a valid ISO 8601 datetime" }`
  - `now` not a string or unparseable.
- 400: `{ "error": "tourIds must be a non-empty array of at most 50 tour ids" }`
  - `tourIds` present but not an array (including `null`, a string, an
  object), empty, more than 50, or any entry `''` or not a string.
- 200: `{ "ok": true, "now": "<normalized ISO>", "scanned": n, "due": n,
  "closed": n, "lost": n, "failed": n }`.
- A store failure surfaces as the app's 500, like the sibling ticks.
- Default deps (lazy, first tick): exactly the worker's eight fields, every
  repo `({ logger: log })`, `events: appEvents` (the APP bus).
  `DevRouterDeps.tourAutoCloseDeps?: TourAutoCloseDeps` (`dev.ts:134-136`)
  injects them in tests.

Worker: poll `'tour auto-close'`, `startPollLoop(..., { logger, intervalMs:
TOUR_AUTO_CLOSE_INTERVAL_MS, baseContext: bootContext })` at
`worker.ts:565`; the first tick fires one interval (15 minutes) after boot.

## 7. Heads-ups for later slices

- S6: `routes/tours.ts` was not touched; its S3-S4 anchors are unchanged.
  The TourUpdatedEvent doc already names the reopen route as an emitter.
- S9: every tick should pass `tourIds` (the selectors row says so); a tour
  created during a run is due at creation + 14 days, so tick at
  `Date.now() + 15 days`. The real lane worker's first auto-close tick lands
  15 minutes into the run with the wall clock and finds nothing due (F12).
- S10: e2e/README and selectors.md already carry the seam. RUNBOOK.md
  `:1119` still omits the journal-sweep poll (pre-existing, drift #13).
- Observation (no action): `tourIds` duplicates are not deduped (plan code
  kept); harmless - exactly-once by the conditional write, only `scanned` /
  `lost` count the repeat.
