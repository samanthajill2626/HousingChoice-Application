# Share sent outcome (Branch B) - build slice 3 report (T8-T12)

Date: 2026-09-28. Implementer: slice-3 child (Claude Opus 5.5), dispatched by
the build orchestrator. Worktree `W:\tmp\share-sent-outcome`, branch
`feat/share-sent-outcome`, base `53bece54` (the slice-2 report). Plan:
`docs/superpowers/plans/2026-09-28-share-sent-outcome.md` v5, Tasks 8-12 in
that order. Every `file:line` below is at `417b16d6` (the T12 commit) unless
it says "at HEAD" of an older commit or names an old pin number.

## Status

DONE - five task commits, one per task, in order. No STOP condition was hit:
no importer the plan does not name, both router deps shapes took the new
repos the way `contactsRepo` is forwarded, the slice-1 and slice-2 contracts
held (one sketch/interface disagreement resolved toward the interface, T9
item 1), no red outside the named pins, and no dashboard type seam beyond the
named files.

| Commit | What |
|---|---|
| `56681acc` | T8 - the composer's "Already sent" flag reads the SAFE state (`priorRecipientKeys`); the repo rule and its harness mirror deleted |
| `cbc84296` | T9 - results/list carry promise facts and the true `retry_pending`; `?view=stats` |
| `ab48caf0` | T10 - dashboard: label table, Retrying chip, badge reason, row hint, server-clock ticker recount, hook merges, finished-share stats refetch |
| `b335a54e` | T11 - "Sent to N tenants" recounts at read time (property card, landlord timeline); "No tenants reached" |
| `417b16d6` | T12 - the tenant "Property sent" milestone reads its words from the ledger |

Gates NOT run, per the mission: the full `npm test`, `npm run e2e`,
`npm run smoke`. Every command ran bare from the worktree; output went to
`.superpowers/sdd/logs/s3-*.log` (gitignored) and was read after. No
`[dynamoAdmin]` line appeared in any slice-3 log.

Final verification (after T12): app - `npx vitest run` over 13 suites
(broadcastApi, broadcastsRepo.integration,
twilioWebhookHarnessRepoAdditions.integration, unitsApiActivity,
contactTimeline, contactEmailReaders, contactsBatchReads,
contactsBatchIncomplete, listingSendsApi, shareRecipientState,
broadcastFanOut, sendReconcile, twilioStatusWebhook) - "Test Files 13 passed
(13) / Tests 636 passed (636)". Dashboard - `npx vitest run
src/routes/broadcasts src/api src/routes/listing` - "Test Files 32 passed (32)
/ Tests 477 passed (477)". Informational: `npx eslint` over the 26 TypeScript
files this slice touched (`53bece54..HEAD`) - EXIT=0 (gate 5 stays the
orchestrator's).

## Task 8 - `56681acc`

Files: `app/src/routes/broadcasts.ts` (deps `:90`, `:95`; defaults
`:393-394`; the preview's prior set `:602`), `app/src/routes/api.ts`
(`:1050-1051`, forwarded exactly as `contactsRepo` is - conditional on
`deps.*`), `app/src/repos/broadcastsRepo.ts` (`priorRecipientContactIds`
interface entry and impl deleted; the `listByUnit` doc `:428` now names the
service), `app/test/helpers/twilioWebhookHarness.ts` (mirror deleted; comment
at the double's `listByUnit` `:3429`), `app/test/broadcastApi.test.ts`,
`app/test/broadcastsRepo.integration.test.ts`.

Runs (from `app/`):

- RED: `npx vitest run test/broadcastApi.test.ts` - "Test Files 1 failed (1)
  / Tests 5 failed | 66 passed (71)": the five new cases (`expected false to
  be true` x3, `expected true to be false` on the 30007 slot, `expected
  "getByTsMsgIdConsistent" to be called at least once`).
- GREEN: `npx vitest run test/broadcastApi.test.ts
  test/broadcastsRepo.integration.test.ts
  test/twilioWebhookHarnessRepoAdditions.integration.test.ts` - "Test Files 3
  passed (3) / Tests 130 passed (130)" (broadcastsRepo.integration 36,
  harness parity 23, broadcastApi 71).
- `npm run typecheck` (repo root): EXIT=0. `npx eslint` on the six files:
  EXIT=0. Added lines ASCII: 0 in all six.
- `grep -rn priorRecipientContactIds app dashboard e2e` (source, not the
  gitignored `app/dist`): only the wire field - `broadcasts.ts:561` and
  `:623` (comments naming the field), `:648` (the response), the route pins
  in `broadcastApi.test.ts`, and the dashboard's `types.ts:3145`/`:3155`,
  `RecipientPreview.tsx:105-106`/`:175` and its tests.

Divergences:

1. The `:1088` pin (now `broadcastApi.test.ts:1168`) is EXTENDED (tenants c-3
   delivered in another share, c-4 queued in a `sending` share; c-1 still
   flagged by the prior API send, c-2 not) and was green before the change:
   the old and new rules agree on reached and in-flight-in-sending, so it is a
   regression pin; the five new cases carried the reds.
2. `:1183` (now `:1273`) keeps its body and assertions byte-identical; a
   two-line comment says it holds as the STRANDED case. Its title still says
   "(only sent/sending)" (historical wording, left so the pin stays findable).
3. `:1207` is REPLACED by the final-failure case (`:1340`), which also keeps
   the old skipped-slot assertion (share-skip-fix D5) and the hand-add
   annotation assertion (`priorRecipientContactIds` equals exactly the
   unconfirmed tenant).
4. "A failed row read never empties the set" (`:1393`) seeds a LAPSED row, so
   only the safe direction of a failed read can flag the tenant; it uses
   `vi.spyOn(...).mockRejectedValue` rather than property assignment, and
   also asserts the service's WARN.
5. `broadcastsRepo.integration.test.ts`: the "describe block" was three `it`
   cases inside the file's top-level describe (`:298`, `:347`, `:359` at
   `53bece54`, through the closing brace at `:385`); all three deleted (89
   lines).
   `priorRecipientKeys` keeps its own coverage in
   `shareRecipientState.test.ts` (slice 1).
6. Behavior change named: the old repo method degraded a failed byUnit page to
   an EMPTY set; `priorRecipientKeys` returns what it resolved (the slice-1
   contract, never throws). The route comment (`broadcasts.ts:589-599`) says so.
7. File-local test helpers added to `broadcastApi.test.ts` (`attemptKeyAgo`,
   `isoFromNow`, `seedAttemptRow`, `seedShare` - which stamps
   `_listPartition` like `create()` so seeded shares list -, and
   `SEED_ATTEMPT_FACTS`); records are seeded through
   `world.sendAttemptsRepo.claim` (the fan-out suite's idiom).

## Task 9 - `cbc84296`

Files: `app/src/routes/broadcasts.ts` (`EnrichedRecipient` `:225`;
`promiseFields` `:235`; `statsWithStates` `:251`; `enrichRecipients` gains
`states?`; `toBroadcastResults(b, recipients, stats)` `:338`;
`toBroadcastStatsView` `:365`; `toBroadcastSummary(b, stats)` `:370`; the
results route's `invalid_view` check `:872` and state resolution `:884`; the
list loop `:938-940`; the header route list gains the `?view=stats` line),
`app/test/broadcastApi.test.ts`.

Runs (from `app/`):

- RED: `npx vitest run test/broadcastApi.test.ts` - "Tests 7 failed | 71
  passed (78)": the rewritten `:1271-1282` pin (no `retry_pending`) and six
  new cases. "Results and list read NO send-attempt records" (`:1548`) was
  green before the change (nothing read records then either) - a regression
  pin.
- GREEN: same command - "Tests 78 passed (78)". Neighbors: `npx vitest run
  test/contactsBatchReads.test.ts test/contactsBatchIncomplete.test.ts
  test/shareRecipientState.test.ts` - "Tests 35 passed (35)".
- `npm run typecheck`: EXIT=0. `npx eslint` on the two files: EXIT=0. Added
  lines ASCII: 0.

Divergences:

1. THE ONE SKETCH LINE THAT CONTRADICTED THE INTERFACE. The sketch asserted
   `recipients['c-1'].retryDueAt` undefined for a chain that ended unresolved
   (withdrawn sentinel + `retry_outcome`). The slice-1 contract carries the
   row's value through (`ClassifiedRecipient.retryDueAt` = the epoch sentinel,
   pinned by `shareRecipientState.test.ts:166`), and the plan's T9 interface
   says the wire fields come "from the state map". I followed the interface
   and I5/D3 (the row is the one source; the page judges liveness): the route
   passes the sentinel through, and the test (`broadcastApi.test.ts:1508`)
   asserts "no LIVE promise" (`isRetryPromiseLive` false) and no
   `retryPending` instead of an absent field.
2. `latestAttempt` already rides the slot (`BroadcastRecipient.latestAttempt`,
   slice 1); `promiseFields` re-states the same value from the state map.
3. The view check runs BEFORE the 404 (the sketch's order): `?view=bad` on a
   missing share is 400, not 404. A repeated `view` param is an array and is
   400 too.
4. The list resolves rows one after another (never `Promise.all`), so reads
   stay 8 in flight across the page.
5. Cases added beyond the sketch: a pending recipient whose row read FAILED
   carries `retryPending: true` and no `retryDueAt` and is counted (`:1534`);
   the `?view=stats` body's key set is exact (`:1560`); the list case also
   pins the Not-confirmed re-bucketing, a draft's `retry_pending: 0`, and
   that only the two young failed-30003 slots cost a row read (`:1588`).

## Task 10 - `ab48caf0`

Files: `dashboard/src/api/types.ts` (`BroadcastStats.retry_pending?` `:2993`
and the sum comment; wire `BroadcastRecipient` gains `latestAttempt?`
`:3051`, `retryDueAt?`, `retryOutcome?: RetryOutcome` `:3059`,
`retryPending?` `:3063`; new `BroadcastStatsView` `:3069`;
`BroadcastRecipientView` gains `tsMsgId?`, `latestAttempt?` `:3117`,
`retryDueAt?`, `retryOutcome?` `:3119`, `retryPending?` `:3120`;
`BroadcastUpdatedEvent` doc), `dashboard/src/api/endpoints.ts`
(`getBroadcastStats` `:1892`), `broadcastFormat.ts` (`presentShareLabel`
`:108`; `RecipientReasonOptions` `:183`; `shareRecipientReason` `:188`;
`toRecipientViews` keeps the ids and facts `:247`), `DeliveryBadge.tsx`
(props `:40`; the call `:54`), `StatChips.tsx` (`:45-46`, class `:57`) and
`StatChips.module.css` (`.progress` `:49`), `BroadcastResults.tsx` (tick
period `:42`; `pendingRetryCount` `:47`; hint rule `:90`; ASCII hint copy
`:117`; `serverNow` snapshot `:154`; ticker `:175`; `showLastError` `:216`;
pill and chips on `liveStats` `:228`, `:246`), `useBroadcastResults.ts`
(`recount` state `:74`; cleared on fetch success `:105` and on load `:135`;
the overlay merge `:169`, rows-behind `:175`, count-carrying clear `:176`;
`recountRetryPending` `:208`; `liveStats` `:212`), `useBroadcastsList.ts`
(debounce `:43`; `rowsRef` `:54`; `scheduleStatsRefetch` `:138`; the merge
`:188`; the refetch trigger `:202`), and the tests `broadcastFormat.test.ts`,
NEW `DeliveryBadge.test.tsx`, `StatChips.test.tsx`,
`BroadcastResults.test.tsx`, `useBroadcastResults.test.tsx`,
`BroadcastsList.test.tsx`.

Runs (from `dashboard/`):

- RED: `npx vitest run src/routes/broadcasts src/api` - "Test Files 6 failed
  | 16 passed (22) / Tests 30 failed | 290 passed (320)" - every new case and
  flipped pin (broadcastFormat 5, StatChips 5, DeliveryBadge 2,
  BroadcastResults 12, useBroadcastResults 1, BroadcastsList 5).
- GREEN: same command - "Test Files 22 passed (22) / Tests 320 passed (320)".
- Mutation check: with the rows-behind guard (`useBroadcastResults.ts:209`)
  removed, `npx vitest run src/routes/broadcasts/BroadcastResults.test.tsx` -
  "Tests 1 failed | 22 passed (23)" (the case at `BroadcastResults.test.tsx:513`);
  restored, the full run was 320/320 again.
- `npm run typecheck`: EXIT=0. `npx eslint` on the 14 TypeScript files:
  EXIT=0. Added lines ASCII: 0 in all 14 modified files and the new file.
  The `BroadcastResults.tsx` hint glyph is gone (no match in the file or its
  tests).

Pins flipped as named: `broadcastFormat.test.ts` `:224`, `:228` (Not sent /
danger), `:242` (Not confirmed / danger), `:226` (Not sent / danger); the
`:185` 30003 pin keeps its no-options assertion with a rewritten comment and a
new case for the three promise readings; `StatChips.test.tsx:77` order gains
`Retrying`; the `:177-181` badge case moved to `DeliveryBadge.test.tsx:19`;
`BroadcastResults.test.tsx:139` flipped to NO hint (`:164`). Kept green:
`broadcastFormat.test.ts` `:223`, `:225`, `:227`, `:229`;
`BroadcastResults.test.tsx` `:160` (now `:252`) and `:227` (now `:319`).

Divergences:

1. ORDER, stated honestly: I edited the types, the endpoint and
   `presentShareLabel` before writing the tests. Before running anything I
   set `broadcastFormat.ts` back to HEAD, wrote every test, watched the 30
   reds, then restored the change. During the mutation check a `git checkout
   --` reverted the uncommitted hook file; it was restored from a copy taken
   first and the full suite re-run (320/320) before the commit.
2. The tick override lives in `useBroadcastResults` (`recount`,
   `recountRetryPending`, `liveStats`), not in the component: the two events
   that clear it (a successful fetch, a count-carrying overlay) live in the
   hook. The component owns the ticker, the `serverNow` snapshot and
   `rowsRef`, as sketched.
3. Added: a ROWS-BEHIND guard. From any SSE overlay until the next
   successful fetch, a tick's recount is ignored - the plan's "never before
   the first refetch" read as "between an event and its refetch the event's
   count stands" (otherwise a tick landing inside the 400 ms debounce would
   recount the stale rows and flash Not sent). Pinned by the mutation check.
4. The ticker is ALWAYS armed while the page is mounted (60 s,
   visibility-gated, plus the Timeline's focus listener), with no arming
   predicate - one render a minute, and the snapshot is never older than a
   tick. The Timeline's arming memo was not copied.
5. `BroadcastsList.tsx` needed NO change (the pill already passes
   `row.stats`, which now carries the merged count), so it is not in the
   commit though the plan's `git add` list names it.
6. The Retrying chip's `progress` class applies only above zero (as `danger`
   does); its colours are the lifecycle pill's progress tokens.
7. The list's stats refetch keeps one entry per row (timer + AbortController):
   a new schedule clears the prior timer and aborts the prior request, a
   result applies only if not aborted, and unmount clears everything.
8. `DeliveryBadge` ignores `retryDueAt`/`retryOutcome` without `serverNowMs`
   (the sketch): a live stamp with no clock promises nothing (pinned,
   `DeliveryBadge.test.tsx:54`).
9. NOT edited (not in the task's file list) and now stale: the
   `DeliveryReasonOptions` doc in `dashboard/src/routes/contact/deliveryStatus.ts`
   (the `retryScheduled`/`retryUnconfirmed` notes say the property-send
   results row omits the options; it now passes them), and
   `BroadcastStatusPill.tsx`'s header comment (names only the D6 all-skipped
   case). Task 15 material.
10. No `endpoints.test.ts` case for `getBroadcastStats` (file not named): the
    query string rides `request`'s `query` option; the app route tests cover
    the server side and Task 14's e2e will cover the wire.

## Task 11 - `b335a54e`

Files: `app/src/routes/units.ts` (deps gain `broadcastsRepo?`; default
`:298`; the recount after the audit read, guarded, `:1282-1286`; the stale
NOTE above the route re-worded in ASCII), `app/src/routes/contactTimeline.ts`
(deps gain `broadcastsRepo?`; default `:1252`; `sentToLabel` `:695`; the
landlord relabel after the merge and slice `:1461-1480`), `app/src/routes/api.ts`
(`broadcastsRepo` forwarded to the timeline router `:871` and the units router
`:928`, conditional like the broadcasts router's), `dashboard/src/routes/listing/listingFormat.ts`
(`:136`), and the tests `app/test/unitsApiActivity.test.ts`,
`app/test/contactTimeline.test.ts`, `dashboard/src/routes/listing/listingFormat.test.ts`.

Runs:

- RED (from `app/`): `npx vitest run test/unitsApiActivity.test.ts
  test/contactTimeline.test.ts` - "Tests 4 failed | 67 passed (71)"
  (`expected 4 to be 2`; the two ERROR counts `expected [] to have a length of
  1`; the landlord labels). "A page with no broadcast_sent row reads no share"
  was green before (a regression pin). RED (from `dashboard/`): `npx vitest
  run src/routes/listing/listingFormat.test.ts` - "Tests 1 failed | 25 passed
  (26)".
- GREEN: the same app command - "Test Files 2 passed (2) / Tests 71 passed
  (71)" (unitsApiActivity 11, contactTimeline 60); the dashboard command -
  "Tests 26 passed (26)".
- `npm run typecheck`: EXIT=0. `npx eslint` on the seven files: EXIT=0. Added
  lines ASCII: 0.

Kept green as named: `unitsApiActivity.test.ts:158` (now `:181`; share `b9`
absent -> the stored 3) and `contactTimeline.test.ts:1048` (now `:1073`; share `b1` absent ->
the stored "4"). The `listingFormat.test.ts:180-192` pin flipped ("Sent to 0
tenants" -> "No tenants reached", now `:199`, with the share link kept).

Divergences:

1. `unitAuditToMilestone` did NOT gain the `reached?` parameter: the sketch
   relabels after the slice, so it would be dead code. The stored label
   (including "Sent to 0 tenants" for a missing share whose stored count is
   0) stays the stored words, as D5 says.
2. The units route post-processes the projected events (a `broadcast_sent`
   event with a found share takes `reachedCount`) instead of threading the
   map into `toUnitActivityEvent` - same result.
3. The landlord relabel identifies its pins by the plan's rule (landlord,
   `listing_sent`, `refType === 'broadcast'`, a `refId`) AND a label starting
   `Sent to ` - only pins the audit mapping produced.
4. Cases added: the singular "Sent to 1 tenant" on the landlord timeline; ONE
   batch read with `{ projection: 'stats' }` pinned on both surfaces; a page
   with no `broadcast_sent` row reads no share; a tenant's `refType:
   'broadcast'` (unit-less share) pin is never relabeled and costs no share
   read. The ERROR lines carry ids and counts (`unitId`/`contactId`, `count`).
5. Cosmetic asymmetry, named: for a MISSING share with a stored count of 0,
   the property card now reads "No tenants reached" (the dashboard composes
   from the count) while the landlord timeline keeps "Sent to 0 tenants" (the
   server keeps stored words). A finished share cannot be deleted, so the
   shape should not occur.

## Task 12 - `417b16d6`

Files: `app/src/routes/contactTimeline.ts` (deps gain `listingSendsRepo?`;
default `:1253`; `propertySentWords` `:713`; the pins kept beside their wire
items `:1370`; ONE `getByKeys` `:1388`; the guarded ERROR `:1398`),
`app/src/routes/api.ts` (`listingSendsRepo: listingSends` to the timeline
router `:875` - the resolved local the contacts and units routers read;
`messagesRepo` was already forwarded), `app/test/contactTimeline.test.ts`
(new describe `:1352`).

Runs (from `app/`):

- RED: `npx vitest run test/contactTimeline.test.ts` - "Tests 4 failed | 60
  passed (64)".
- GREEN: same command - "Tests 64 passed (64)". Neighbors: `npx vitest run
  test/contactEmailReaders.test.ts test/contactTimeline.test.ts
  test/unitsApiActivity.test.ts test/broadcastApi.test.ts
  test/listingSendsApi.test.ts` - "Test Files 5 passed (5) / Tests 174 passed
  (174)".
- `npm run typecheck`: EXIT=0 (run twice, before and after the ASCII fix
  below). `npx eslint` on the three files: EXIT=0. Added lines ASCII: 0 after
  the fix.

Divergences:

1. ASCII slip caught before the commit: the new describe title copied the
   file's em dash; re-worded to ` - `, then re-ran (64/64) and typecheck (0).
2. The re-wording keeps each pin's wire item beside its event at gather time
   instead of `candidates.find` by key (same effect, no scan).
3. It runs over the gathered `limit + 1` events before the merge (the plan's
   placement), so at most one pin the page drops costs its pair's read.
4. No contact-type guard (as sketched): any contact's `refType: 'unit'` pins
   re-word from their own (unit, contact) pair.
5. `propertySentWords` is verbatim, including no row-less handling: a pending
   entry never names a row-less key (only an `unresolved` outcome writes one,
   and it writes an `unconfirmed` entry).
6. Test shapes: the eight-milestone case (`:1421`) makes b5's attempt 16
   minutes old - past the 15-minute window, inside the 24-minute bound - with a
   refreshed live promise, and pins the four row reads by tsMsgId; the
   pair-rule case (`:1474`) seeds a LEGACY row straight into `world.listingSends`
   (no `shares`, no `counted`) and adds a pin WITH a share id whose entry was
   never written; an extra case (`:1515`) pins ONE `getByKeys` over the distinct
   pairs and a no-row pin keeping its stored words.

## The contract shipped (what Slice 4 and the e2e consume)

Preview - `POST /api/broadcasts/:id/preview`: shape unchanged.
`candidates[].alreadySentThisProperty` (matched on contactId OR
`phone#<E164>`) and `priorRecipientContactIds: string[]` (contactKeys) now
carry D1's SAFE reading over EVERY share of the unit, whatever its stored
status: reached, pending a live retry, Not confirmed, or in flight (a queued
slot of a finished share with a live send-attempt record). A final failure, a
skip and a strand never flag. This is the ONLY route that reads send-attempt
records.

Results - `GET /api/broadcasts/:id/results`: top-level shape unchanged;
`stats` ALWAYS carries `retry_pending` (a number, a sub-bucket of `failed`),
and a slot whose newest attempt's row says its chain ended unresolved counts
in `stats.unconfirmed`, not `failed`. Each `recipients[key]` is the slot
(`status`, `conversationId?`, `tsMsgId?`, `errorCode?`, `carrierSentAt?`,
`latestAttempt?`) plus identity (`firstName?`, `lastName?`, `phone?`) plus,
for a failed-30003 slot whose newest attempt is at most 24 minutes old:
`retryDueAt?` (that row's `retry_due_at` AS STORED - a withdrawn promise is
the epoch sentinel `1970-01-01T00:00:00.000Z`, never live), `retryOutcome?`
(`'unconfirmed'`), and `retryPending: true` when the D1 state is pending (a
live promise, or a row read that failed - then no `retryDueAt`). No record
reads.

Stats view - `GET /api/broadcasts/:id/results?view=stats`: `{ broadcastId,
status, unitId (null when unit-less), stats (with retry_pending), created_at
}` - no `recipients`, no `audience_filter`, no `last_error`, no contact
reads. Any other `view` value (or a repeated one) is 400 `{ error:
'invalid_view' }`, checked before the 404.

List - `GET /api/broadcasts`: each summary's `stats` carries `retry_pending`
and the same Not-confirmed re-bucketing; one state resolution per row, rows
in sequence, no record reads; a row with no young failed-30003 slot reads
nothing.

Dashboard client - `getBroadcastStats(broadcastId, signal?)`
(`endpoints.ts:1892`) = GET `/api/broadcasts/:id/results?view=stats` ->
`BroadcastStatsView`.

`presentShareLabel(status, stats?)` as built (`broadcastFormat.ts:108`):

| stored status | stats | label | tone |
|---|---|---|---|
| draft | any | Draft | neutral |
| sending | any | Sending | progress |
| sent / failed | absent | Sent / Failed (stored) | positive / danger |
| sent / failed | delivered + sent + sending > 0 | Sent | positive |
| sent / failed | else retry_pending > 0 | Sending | progress |
| sent / failed | else unconfirmed > 0 | Not confirmed | danger |
| sent / failed | else audience > 0 and every recipient skipped | Not sent | neutral |
| sent / failed | else | Not sent | danger |

Hook merge rules as built:

- `useBroadcastResults`: an overlay takes the event's status and stats and
  KEEPS the previous `retry_pending` when the event omits it; every overlay
  marks the rows as behind the stats; an overlay that CARRIES a count clears
  the tick override. A successful fetch (initial load, 2 s poll while
  sending, the 400 ms debounced refetch, manual Refresh) replaces the
  results, clears the override and the rows-behind mark. The page's 60 s tick
  calls `recountRetryPending(count)` - count = rows with `retryPending ===
  true` and (`retryDueAt` absent or live on the server clock) - which is
  IGNORED while the rows are behind. `liveStats` = `results.stats` with the
  override as `retry_pending`; the pill, the chips and the `last_error` gate
  read it.
- `useBroadcastsList`: a patch takes the event's status and stats and keeps
  the row's `retry_pending` when the event omits it. When the event omits the
  count, the row's LAST count is above 0, and the event's status is `sent` or
  `failed`, ONE per-row 400 ms debounced `getBroadcastStats` runs and its
  result replaces that row's `status` and `stats` (a row no longer on the page
  is ignored; a failed read keeps the row). A `sending` share never
  refetches; an event carrying a count replaces it with no fetch.

Timeline and card words (app-composed except the card): tenant `listing_sent`
pins with `refType: 'unit'` read `Property sent` / `Property sent - not
confirmed` / `Property text failed`; landlord `broadcast_sent` pins read
`Sent to N tenants` / `Sent to 1 tenant` / `No tenants reached`; the property
Activity card composes the same three from the recounted `tenantCount`.

## For the e2e author (Task 14)

- Pill: `statusPill(page, label)` (`e2e/support/broadcastSelectors.ts:41`,
  scoped to the results header) - `Sent`, `Sending`, `Not confirmed`, `Not
  sent`. "Sending" and "Not confirmed" are ALSO chip `<dt>` labels, and "Not
  confirmed" is also a row badge label - keep the header scoping. On the list,
  scope to the row (`Property sends` list item) as `share-skip-fix.spec.ts:239`
  does.
- Chips: `statValue(page, 'Retrying')` - a new `<dt>Retrying</dt>` right
  after `Failed` in `<dl aria-label="Delivery stats">`; `Failed` now reads
  `failed - retry_pending`.
- Hint: `getByRole('list', { name: 'Recipients' }).getByRole('link', { name:
  /open conversation to retry/ })` - the glyph is gone, the text is plain
  `open conversation to retry`. It appears only on a failed row with a
  message id (`tsMsgId` or `latestAttempt`), not `send_unconfirmed`, not
  `retryOutcome` unconfirmed, and with no live promise.
- Row badge copy (the badge renders `<status label>` then the reason after a
  pre-existing em dash separator - assert with `toContainText` on the
  reason): `Phone unreachable - will retry (error 30003)` while live,
  `Phone unreachable - retry not confirmed (error 30003)` for an unresolved
  chain, `Phone unreachable (error 30003)` otherwise.
- `last_error` (the header's `role="alert"`) renders under `Not sent` only.
- Timing: a promise is live until `retry_due_at` + 2 min on the server clock.
  With no event, a lapse moves the results page only at the next 60 s tick;
  any fetch (Refresh, an SSE-driven refetch, a reload) reads the route's
  truth at once - prefer reload or Refresh over waiting on the ticker. The
  list turns Sending -> Not sent through the stats refetch 400 ms after a
  finished share's event that omits the count, or on reload.
- "Already sent": unchanged markup - `row.getByText('Already sent')` on the
  review row (`broadcasts.spec.ts:174`, `share-skip-fix.spec.ts:210`).
- Milestone words: the tenant timeline pin reads `Property sent`, `Property
  sent - not confirmed` or `Property text failed`; the landlord pin and the
  property Activity link read `Sent to N tenants` / `Sent to 1 tenant` / `No
  tenants reached`.
- E2E pins this slice flips (Task 14 owns them, untouched here):
  `send-outcome-reconcile.spec.ts:464` (the 21211 rejection has no message
  row -> no hint), `:534` (the all-unconfirmed share's pill is now `Not
  confirmed`, not `Failed`), `:535-537` (its `last_error` alert no longer
  renders); `share-skip-fix.spec.ts:250` (a 30007 FAILED recipient is no
  longer "Already sent"; header `:16-22` goes stale). Expected to hold:
  `broadcasts.spec.ts:96`, `listing-activity.spec.ts:143`,
  `landlord-activity.spec.ts:122` (both recipients delivered -> "Sent to 2
  tenants").

## Sub-threshold worries (for the orchestrator's eye)

1. A pending-by-unreadable-row recipient (`retryPending`, no `retryDueAt`)
   shows BOTH a Retrying count and the hint: the verbatim hint rule has no
   `retryPending` clause. Needs a failed DynamoDB read at request time.
2. If the refetch after an overlay FAILS, the rows-behind mark stays set and
   the ticker cannot recount until the next successful fetch (Refresh, poll,
   or event): a lapsed promise could read Sending until then.
3. The results page's clock snapshot is taken at mount and on ticks, not on a
   refetch: a promise row arriving after a long idle is judged against a
   snapshot up to 60 s old (the Timeline's "plus one ticker interval" bound).
4. The composer flag walks EVERY share of the unit with record reads (the
   plan's rule): cost grows with a unit's share history, bounded by the 30-day
   record life (one read per queued slot of a finished share) and the 24-minute
   row bound (one read per young failed-30003 slot).
5. The wire `retryDueAt` of a withdrawn promise is the epoch sentinel: any
   future surface that RENDERS the value instead of judging it must treat it
   as "no promise".
6. The api.ts forwards are conditional on `deps.*` (as instructed), so in
   production the broadcasts, units and timeline routers each default-construct
   their own repo instances (cheap; no network at construction).
7. The tenant re-wording reads a pending entry's row sequentially per pin
   (pending entries inside the bound are transient and rare).
