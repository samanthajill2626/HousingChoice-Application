# Code review r1 - adversarial (feat/tour-list @ 38695b70, base d839494a)

Reviewer: adversarial, design-blind (no spec, plan or prior review read).
Inputs: `.superpowers/review/diff-package.md` and the whole repository. The
gate-4 e2e marker appeared mid-review (exit=0); no existing file was modified
at any point. Two throwaway tests were run and then deleted (named below).

## The behavior I inferred

The Tours page gains an "All" tab at `/tours/all` (listed first; `/tours` stays
Active). It shows every tour, server-filtered by When (any / upcoming / past /
date range), status chips (`requested` reads "Needs booking" and only shows
under Any time), tour type and sort, and server-paged through
`GET /api/tours/list`. The server plans ordered "phases": one dated phase (D)
on the sparse `byScheduledAt` GSI, then - for Any time only - one undated phase
(U) per status on `byStatus` (`requested` unfiltered; the others filtered by
`attribute_not_exists(scheduledAt)`), and pages through them with an opaque
base64url cursor `{v, f (filter fingerprint), n (pinned now), ph, i, k}`, a
peek row for unfiltered phases, a 200-item evaluated limit for filtered ones
and a 6-Query budget per request, so a page may come back short or EMPTY with
a cursor. The client hook keeps ONE loader at a time: first page (50), Load
more (50), and one derived automatic mode - walk (search non-empty, 100/page,
50-request cap per walk session), restore (back to the depth recorded when a
row was opened, 10-request cap) or follow (auto-follow empty pages, 10 in a
row). A cursor 400 restarts the list once, then kills it (Start over). The view
keeps filters in local state, persists them with stamped REPLACE writes
(skipped while a navigation is pending), adopts the URL on POP / foreign
navigations, searches loaded rows client-side, and on return (browser Back via
the list entry's history state, or the tour page's back arrow, which hands the
record back) loads to the recorded depth and focuses the opened row unless the
user acted first. Separately: the date-range repo read now walks every page,
seeds stamp `_schedPartition` on every tour, `unitsRepo.getDisplaysByIds` was
added, Today's tours cap warning was dropped, the undated wording became
"Needs booking" (requests) / "Undated" (everything else) everywhere, and the
property page sorts only requests first.

## Findings

Severity count: HIGH 0, MEDIUM 0, LOW 3, PLAUSIBLE 2.

I looked hard for a HIGH or MEDIUM and did not find one that survives proof:
the paging engine, the phase plan, the cursor checks and the hook's one-loader
state machine hold under every interleaving I could construct (listed under
"Checked and found sound"). The three LOW items are real and proven; none is a
wrong answer today.

### AD-1 (LOW) - The cursor-400 mapping is per REQUEST, not per Query: any ValidationException on a cursor page - including one no client key could cause - becomes a silent 400 'invalid cursor'

**Claim.** `app/src/routes/tours.ts:475-493` answers 400 `invalid cursor`
whenever `rawCursor !== undefined` and the engine throws an error NAMED
`ValidationException` - while its own comment (`tours.ts:485-487`) says "any
other ValidationException is a defect in the query (500 via the app's error
handler)"; the code never makes that distinction. A cursor page runs up to 6 Queries
(`app/src/services/tourListPage.ts:94-97`), and only the FIRST carries the
client's key (`tourListPage.ts:63`); every later Query uses a server-made
`lastEvaluatedKey` or no start key at all, and a k-less `{ph:'u', i}` cursor
carries no key even on Query 1. So a ValidationException from Query 2..6 (or
from Query 1 of a k-less cursor) is necessarily a SERVER defect (an
expression, a placeholder, a limit) - yet it is reported as the client's bad
cursor, with no warn or error line. The client then treats it as a cursor
rejection (`dashboard/src/routes/tours/useAllTours.ts:146-148, 189-197`):
restart to page 1 ("The list was refreshed."), and on the next Load more the
same defect kills the list ("We couldn't load more tours." + Start over). The
undated phases are typically reached only on cursor pages, so a defect in a
U-phase expression would never produce a 500 or an error log at all.

**Evidence.** Throwaway `app/test/zz-review-adv-route.test.ts` (harness, deleted
after the run): three tours (two dated, one request), page 1 at `limit=1`
gives a D cursor; `queryListPhase` spied to delegate call 1 and throw an
`Error` named `ValidationException` ("Invalid FilterExpression ...") on call 2.
Result, `GET /api/tours/list?limit=2&cursor=...`:
queries `[{"kind":"d","startKey":true},{"kind":"u","startKey":false}]`,
status 400 `{"error":"invalid cursor"}`, new warn lines 0, new error lines 0
(the only trace is the request logger's `request completed 400`). Route test
9 (`app/test/toursApi.test.ts:5898`) pins the 400 only for a throw on every
call, so it does not distinguish the two.

**Blast radius.** Observability only, today: no current code path throws a
non-key ValidationException. It turns any future query defect in the U phases
(or a DynamoDB-side limit) into user-visible refresh-then-dead loops that no
alarm sees.

**Smallest fix.** Map to 400 only when the throw came from Query 1 AND that
Query carried the client's start key (for example: the route wraps the
`queryListPhase` it passes in, counting calls, and tags the error; or
`listTourPage` rethrows a typed `CursorRefusedError` only for call 1 with
`input.start.startKey`). Everything else rethrows (500 + error log). Optionally
also log a WARN with `{ name, phase kind }` on the 400 path.
**Regression test** (fails today): the throwaway above with the expectation
flipped to 500 and one error line; route test 9 stays green.

### AD-2 (LOW) - The date-range read now walks up to 100 pages on CLIENT-SUPPLIED windows that have no span bound

**Claim.** `toursRepo.listByScheduledRange` (`app/src/repos/toursRepo.ts:417-425`)
now runs `queryAll` (cap `DEFAULT_MAX_PAGES = 100`,
`app/src/lib/dynamoPaging.ts:20`). Both callers take the window from the
query string with no span limit: `GET /api/today?toursFrom&toursTo`
(`app/src/routes/today.ts:287-304` checks only from < to) feeding
`today.ts:550`, and `GET /api/tours?from&to` (`app/src/routes/tours.ts:414-418`
checks only that each parses). Before the diff, the accidental one-page read
capped a request at <= 1 MB; now one request can read the whole
`byScheduledAt` partition (up to 100 Queries / ~100 MB) and, on `/api/tours`,
return every full tour item (rosters included) in one JSON body. Today then
does per-tour contact lookups for every `scheduled` tour in the window
(`today.ts:552-555`, cached per contact).

**Evidence.** Code walk of the two parse paths and `queryAll`; the dashboard
itself always sends one day (Today), 30 days (Active) or 90 days (Past), so
nothing in the app is wrong - the exposure is a hand-made request. Aside,
pre-existing and unchanged by the diff: `GET /api/tours?from=<later>&to=<earlier>`
reaches DynamoDB as `BETWEEN` with lower > upper, a ValidationException, so a
500 (the harness fake returns `[]`, so no route test can see it).

**Blast radius.** Authenticated staff only; `listByStatus` (`?status=`)
already walks a whole status partition unbounded, so this is not a new class -
it removes an accidental bound on two more endpoints.

**Smallest fix.** Reject windows longer than a fixed span (e.g. 400 days) and
`from > to` with a 400 in both parsers, or pass a small `maxPages` for these
two callers. **Regression test** (fails today): `GET /api/today?toursFrom=
0001-01-01T00:00:00.000Z&toursTo=9999-12-31T00:00:00.000Z` expects 400.

### AD-3 (LOW) - The `_schedPartition` invariant is enforced only at create, assumed by every date read and both All-tab phase kinds - and the two test fakes of the same GSI disagree about it

**Claim.** Only `toursRepo.create` stamps `_schedPartition: 'tours'`
(`app/src/repos/toursRepo.ts:376`); `patch` (`toursRepo.ts:449+`) SETs only
the supplied fields and never writes it, although PATCH is the writer that
ADDS a date (booking a request). A row that lacks the partition and gains a
date is invisible to the All tab twice over: not on the sparse
`byScheduledAt` (phase D), and excluded from its U phase by
`attribute_not_exists(scheduledAt)` (`toursRepo.ts:871`). The diff fixes
the pure seeds and pins them (`app/test/seedTourPartition.test.ts`), but the
rule itself stays create-only. Separately, the harness fake of the same GSI,
`listByScheduledRange` (`app/test/helpers/twilioWebhookHarness.ts:3521-3526`),
admits rows WITHOUT the partition, while the new All-tab fake requires it
(`app/test/helpers/tourListIndexFake.ts:91`): in the harness world the same
row is on Today and the Active/Past tabs but not on the All tab.

**Evidence.** Code walk (grep: `_schedPartition` is written only at
`toursRepo.ts:376` and in the seed builders). No current app writer omits it;
the live exposure is local DynamoDB stacks seeded before `fa24547b` (deployed
environments are never seeded, RUNBOOK.md:213), where a booked seeded request
is missing from every date read - now including the "every tour" tab.

**Blast radius.** Latent. Any future raw writer (an import, a migration, a new
seed) silently drops tours from the All tab and every date view; the harness
divergence means route tests on Today / `GET /api/tours?from&to` would not
catch it.

**Smallest fix.** In `patch`, when `scheduledAt` is SET, also
`SET _schedPartition = if_not_exists(_schedPartition, :tours)`; make the
harness `listByScheduledRange` require `_schedPartition === 'tours'` like the
All-tab fake. **Regression test** (fails today): repo integration - raw `Put`
of a requested row without the partition, `patch({ scheduledAt })`, expect it
from `listByScheduledRange` and from `queryListPhase` D.

### AD-4 (PLAUSIBLE) - On AWS, a crafted cursor key may fail with an error that is not named ValidationException (a 500, not a 400)

**Claim.** The route maps only the NAME `ValidationException`. Measured on
DynamoDB Local with throwaway `app/test/zz-review-adv-cursor.integration.test.ts`
(deleted): every crafted start key that passes `decodeTourListCursor` and
`locateTourListCursor` - a 1,100-byte range key, a 2,100-byte `tourId`, a
lone-surrogate `tourId` (`a\ud800b` survives the base64url/JSON wire form and
the plan check), a NUL, an arbitrary U `createdAt` - was ACCEPTED (resumed by
key position, no error). AWS enforces key size limits (2,048 / 1,024 bytes)
and strict UTF-8; if it refuses with a ValidationException the route answers
400 (fine), but a different name (e.g. a serialization error) would be a 500
and an error log per crafted request.
**What would prove it:** one probe against hosted dev with those five keys,
recording `err.name`. **Smallest fix if it bites:** in
`decodeTourListCursor` (`app/src/lib/tourListQuery.ts`), cap every key value
(e.g. 1,024 bytes) and require well-formed UTF-16 (`String.prototype.isWellFormed`).

### AD-5 (PLAUSIBLE) - A trackpad swipe-back can cancel its own return anchor

**Claim.** The anchor is cancelled by any `wheel` event after mount
(`dashboard/src/routes/tours/AllToursView.tsx:394`). Chrome on macOS turns a
two-finger horizontal swipe into Back (overscroll history navigation) and
keeps delivering momentum-phase `wheel` events after the `popstate`; if any
lands after the All view mounts, `userActed` is set and the row is never
focused - for exactly the gesture that brought the user back.
**What would prove it:** a real-browser trace (macOS Chrome, swipe back from a
tour page) logging `wheel` events and their timestamps against the view's
mount. **Smallest fix if it bites:** ignore `wheel` events whose `deltaX`
dominates (or all `wheel` within ~300 ms of mount).

## Charter item 4 - sweep

| Touched thing | Every other consumer found | Verdict |
|---|---|---|
| `toursRepo.listByScheduledRange` (one page -> `queryAll`, `opts.pageLimit`) | `routes/tours.ts:418` (`GET /api/tours?from&to`: Active 30 d, Past 90 d, Today past-tours via `useTours`), `routes/today.ts:550` (tours_today), `test/performanceSeed.integration.test.ts:301`, `toursRepo.integration.test.ts` (3 sites), harness fake `twilioWebhookHarness.ts:3521` (ignores `pageLimit`, fine) | Correct and now complete (the old read dropped the NEWEST tours of a window). Cost unbounded on hand-made windows: AD-2 |
| Today's `warnIfCapped('tours_today')` removed | `GROUP_FETCH_LIMIT` / `warnIfCapped` still used by 3 groups (`today.ts:438-593`); no infra metric filter or alarm keyed on "hit the cap" (grep `infra/`, `scripts/`) | Holds |
| Seeds: `_schedPartition` on requested (cast, matrix) and the cast toured tour | `seedMatrixCoherence.test.ts` (flipped), `seedTourPartition.test.ts` (new), `seedLive.test.ts` (pinned), `performance.ts:655` and `live.ts:366-391` (already stamped), e2e lean world seeds no tours; cast `TOUR_TOURED` (2026-05-10) now joins `byScheduledAt` - outside every 90-day window | Holds for fresh seeds; old local stacks need a reseed (AD-3) |
| `UnitsRepo.getDisplaysByIds` (new, interface-required) | only `routes/tours.ts:499`; harness fake implements it; `as unknown as UnitsRepo` fakes (`placementNudges.test.ts:176`) never reach it | Holds |
| `ToursRepo.queryListPhase` (new) | only the route; harness fake delegates to `tourListIndexFake.ts`, pinned by the mirror integration test | Holds |
| Tours page split (`AllToursView` vs `TourListsView`) | e2e `tours-page.spec.ts`, `tours-past.spec.ts`, `tours-all.spec.ts`, `scenarios/tours.spec.ts`; perf `routes.ts` rows `/tours`, `/tours/closed`, `/tours/:tourId` and the ledger citations (updated); `ToursPage.test.tsx`, `ToursPage.walks.test.tsx`; `AllToursView` tests mock `listTours` | Holds: react-router does not key `RenderedRoute`, so `ToursPage` and its `TourListsView` child stay mounted across Active/Past/Closed and the profiler's warm `/tours/closed` contract (only the closed read is passive work) still holds; leaving for All remounts the four contact/unit walks (intended, tested) |
| Retired "Not booked" | zero hits left in `app/src`, `dashboard/src`, `e2e`, `scripts`; `e2e/scenarios/steps.ts:1176,1856` and `tours-page.spec.ts:242` updated; e2e gate exit 0 | Holds |
| `undatedTourLabel` adoption | `LandlordFile`, `TenantFile`, `ListingDetail`, `Today`, `TourDetail`, `ToursPage`, `AllToursView`; their tests updated | Holds |
| `sortToursForPanel` (only requests first, other undated last) | only `useListing.ts:199` (property page); tenant/landlord files keep API order (pre-existing difference, not new) | Holds |
| `TourDetail` back arrow (`/tours/all?...` accepted, restore handed back) | router-state senders: Past rows (`BACK_TO_PAST`), `Today.tsx:206` (`{ back: '/' }`), All rows; every other link into `/tours/:id` (`Card.tsx:206`, `TenantFile`, `LandlordFile`, `ListingDetail`, `PlacementDetail`, `ConversationDetail`, `Timeline`, `ScheduleTourForm`) passes none -> `/tours`; `?outcome=1` strip keeps `location.state` (`TourDetail.tsx:306`); profiler terminal `link 'Back to tours'` still matches (`backLabel`) | Holds; fixed path, so no open redirect from client state |
| Tab order (All first) | all e2e and unit selectors pick tabs by name; perf picks `/tours/closed` by href; no index-based selector | Holds |
| History-state stamps `tourListFilterWrite` / `restore` | readers: `AllToursView`, `TourDetail`; `ImageViewerProvider` merges/strips only its own marker; `ListingsList` uses its own `unitListFilterWrite`; no global replace on `/tours/all` | Holds |
| Route `tours/all` vs `tours/:tourId`; `GET /list` vs `/:tourId` | static path ranks first; tour ids are `tour-<uuid>`; `/list` registered before `/:tourId` (`tours.ts:440` vs `:532`), `/list/activity` -> 404 | Holds |

## Checked and found sound

- Engine stop rules (`tourListPage.ts`): a page never enters a phase full, so the "resume after the last row SENT" key is always from the current phase; peek row, LEK-on-Limit phantom, budget-at-top and k-less `u` cursors all resume exactly once (walked by hand for each exit).
- `planTourListPhases`: D's status filter is dropped only when all five dated statuses are picked; requested never has a date (PATCH refuses `-> requested`, booking auto-advances to scheduled), scheduled always has one, so no row is in two phases or none.
- Cursor shape checks: exact key sets, non-empty strings, `__proto__` rejected as an extra key, canonical `n`, `i` bounds, D partition and U status re-checked against the plan; fingerprint is unkeyed but only gates the caller's own read.
- Out-of-range D start keys: DynamoDB Local refuses with a ValidationException (mirror test), mapped to 400; crafted in-range keys only reposition the caller's own list (measured, AD-4 for AWS).
- `parseTourListQuery`: repeated/nested params 400; non-ISO `Date.parse` forms and 5-digit years are accepted but only reshape the caller's own list (client never sends them; `ymdParts` requires 4-digit years).
- Name maps: soft-deleted contacts/units answer, consistent with the named views (which already load every live and deleted contact, phones included); `deleted_at` is not forwarded; the one log line is counts plus `when` only; the request logger logs the path without the query.
- `unitsRepo.getDisplaysByIds`: dedupes keys (BatchGet rejects duplicates), 100-key chunks, bounded retries, per-chunk failure degrades to a missing label, counts-only WARN.
- GSI projections are `ALL` (`dynamoAdmin.ts:57`, `infra/modules/dynamodb/main.tf:57`), so the status/type/`attribute_not_exists` filters evaluate full items.
- Hook one-loader invariant: Load more is a no-op while any automatic mode runs; every mode change and list change aborts its request in effect cleanup; landing updaters re-check `forKey` (and `cursor` for automatic pages); aborted answers never write.
- Hook interleavings walked: follow -> typed search (abort, same cursor), Load more in flight -> walk waits, restore -> walk, cursor 400 on Load more / follow / walk (restart once, then dead), list change racing a 400 (aborted first, or the restart lands on the old listId and is harmless), A -> B -> A lists (new generation), Start over (fresh allowance), double click (React flushes sync work between discrete events and hides the button).
- View history: own writes are stamped REPLACEs; the pending-navigation guard compares `history.state.idx` with the idx recorded in a layout effect; the row-open REPLACE runs in `onClick` before the Link's synchronous `pushState` under `BrowserRouter`, so the list entry keeps the record; blur-then-click ordering keeps the record; the restore record is bound to the list key it was adopted for.
- Pruned-but-remembered hidden status chip follows the house model of `ListingsList` (`chosen` vs pruned `selection`); the URL and `back` always carry the pruned form.
- Lifecycle: listeners, debounce timer and abort controllers are all released on unmount; no React Compiler in this build, so render-scoped closures are read fresh.
- Throwaway files run and deleted by exact name: `app/test/zz-review-adv-route.test.ts`, `app/test/zz-review-adv-cursor.integration.test.ts`.
