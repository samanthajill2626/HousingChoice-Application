# Tour list (All tab) - design review adjudications

Spec: `docs/superpowers/specs/2026-10-06-tour-list-design.md`.
Planner rulings. ACCEPT = the spec changes; REJECT = no change, reason given;
PARTIAL = the finding stands, the fix differs from the one proposed.
"Decision changed" = the ruling altered what gets built (the round-loop signal),
assigned by the planner after adjudication - never the reviewer's severity.

## Round 1 (spec draft 1 @3bf77856; reviewers A and B, opus, independent)

Reports: `spec-r1-a.md` (15 findings), `spec-r1-b.md` (14 findings). Merged
below into 17 items; reviewer references in brackets.

### R1-1 [A1, B2] The cursor cannot express "start of the next phase/status" - ACCEPT
Verified: 5.4's budget stop can land on the Query that exhausts phase D or a
phase-U status (no LastEvaluatedKey; possibly zero Items), and 5.5 required `k`.
Spec 5.4/5.5 now: `k` is absent exactly when the next request starts phase U at
status `i`; every legal (ph, i, k) combination is enumerated per `when`; `k`'s
hash value must match the phase (`_schedPartition` = 'tours'; `status` =
the i-th phase-U status); `i` indexes the FIXED status order and must name a
status in the request's set; a phase the request skips is refused; a DynamoDB
ValidationException maps to 400 only on a request that carried a cursor. A page
that ends on the last row of the final phase answers `nextCursor: null` (no
phantom Load more). Route tests for both boundaries added to 9.
Decision changed: YES (cursor model).

### R1-2 [A2, B7] Seeds break I2; PATCH propagates it - PARTIAL
Verified: the cast requested tour (`cast.ts:547-561`), the cast toured tour
(`cast.ts:799-812`) and the matrix requested tours (`matrix.ts:940-946`) carry
no `_schedPartition`; `seedMatrixCoherence.test.ts:410-417` REQUIRES its absence
on requested tours; PATCH adds `scheduledAt` without stamping it
(`toursRepo.ts:168-170, 439+`). So a seeded request that gets booked leaves every
date read. ACCEPT the seed fix: every seeded tour row carries `_schedPartition`
= 'tours' exactly as the repo's create writes it (`toursRepo.ts:355-364`), the
matrix test's assertion is inverted (GSI membership needs BOTH attributes, so a
requested tour stays off the index by having no date), and a new pin asserts
every seeded tour carries it. 3.6 and I2 corrected (PATCH named as the
propagating surface). REJECT the alternative "PATCH stamps `_schedPartition`
when it writes a date": production rows are written by the repo's create,
which has stamped every tour since its first commit (reviewer A, 1acb89a4), tours
are never imported (`airtableSource.ts:189-195`, reviewer B), and the seeds were
the only gap - a writer change for a state production cannot reach.
Decision changed: YES (seed surfaces added).

### R1-3 [A3, B5] "Never an empty page above Load more" is false at the cap; phase U re-reads - ACCEPT
Verified against 5.3/5.4: phase U finds undated tours by re-evaluating every
dated toured / no-show / canceled / closed tour, and closed grows without bound.
Decision taken: the default Any time view still reaches its undated tail (the
All tab exists to show every tour), but honestly: requested tours come first in
phase U (no waste - every requested tour is undated), empty pages are followed
automatically up to 10 in a row with "Checking more tours..." in the count
line, and a capped state has copy and a "Keep checking" button. "Never" is
gone. 6 states the read cost precisely.
Decision changed: YES (follow rule, UI state).

### R1-4 [A4, B6] Date range with both bounds empty has no valid request - ACCEPT
`when=range` with neither bound now means every DATED tour (phase D, whole
partition) - a valid request, consistent with P6 (range = dated only).
Decision changed: YES (server contract).

### R1-5 [A5, B6, A13] Day-to-instant conversion, From after To, hidden bounds, canonical strings - ACCEPT
From = the start of the local From day, To = the end of the local To day
(next local midnight minus 1 ms), by calendar arithmetic as
`pastToursDateRange` does (`useTours.ts:175-185`); an input value is parsed by
its components, never `new Date('YYYY-MM-DD')` (UTC). From after To shows an
inline message and sends no request. `from`/`to` are read and written only
under Date range; the server answers 400 for a bound sent with any other
`when`, and canonicalizes both bounds with `toISOString()` before the key
condition, the comparison and the fingerprint (`tours.ts:136-140, 383-387`
compares raw strings today). Boundary test added (a 6 pm tour on the To day is
in).
Decision changed: YES.

### R1-6 [A6, B3] `state.back` from the committed URL drops an unsaved search - ACCEPT
`state.back` is now built at click time from the view's LOCAL selection,
search text included (#1 builds its current-tab target the same way,
`ListingsList.tsx:293-296`). The e2e back step searches first.
Decision changed: YES.

### R1-7 [A7, B8] An undated no_show is reachable through the API - PARTIAL
Verified: `tours.ts:1051-1106` refuses only requested -> no_show; requested ->
canceled -> no_show and requested -> toured (undated) -> no_show pass. The
dashboard offers Mark no-show only on scheduled tours (`TourDetail.tsx:319`).
ACCEPT: 3.4 / D4 / I1 corrected; phase U covers every status except `scheduled`
(requested, toured, no_show, canceled, closed), relying on its not-exists
filter, so such a tour shows under Any time. Needs booking stays `requested`
only (D4's set as the dashboard can produce it). REJECT adding a PATCH guard
(no_show requires a date) in this change - a writer change for an API-only
state; filed as `tour-no-show-without-date` instead.
Decision changed: YES (phase U statuses).

### R1-8 [A8, B9] Cost statements do not match the read mechanism; over-read; walk cap - ACCEPT
Only When (a key condition) narrows what the server READS; status and type
narrow what is SENT. Phase U re-reads. A Query now asks for the rows still
needed when no FilterExpression applies (no 4x over-read on unfiltered pages),
and `QUERY_PAGE_LIMIT` only when one does. The search walk is capped in
REQUESTS (50), not rows; a capped search says so - a deliberate departure from
`paging.ts:20-26`'s no-flag rule (that rule is about whole-list walks feeding
code; a user-facing search presented as complete would be the very silent
truncation the module exists to forbid). A capped search can miss the undated
tail; the copy points at narrowing the filters.
Decision changed: YES.

### R1-9 [A9] All's Upcoming/Past differ from Active's Upcoming and the Past tab - ACCEPT
Recorded as planner call P13 (deliberate: All splits by date at the pinned
instant across every status; Active's Upcoming and the Past tab are curated
work lists). D1's rationale reworded: All holds every tour, the other three are
subsets (the "widest to narrowest" slogan is gone - Closed is unbounded).
Decision changed: NO (documentation).

### R1-10 [A10, B12] Label inventory - ACCEPT
Verified: Past and Today read `pastState` (`ToursPage.tsx:208`, `Today.tsx:199`);
TourDetail prints "Not booked" for every undated tour (`TourDetail.tsx:312`);
the Active list is named "Unbooked tour requests" (`ToursPage.tsx:766`). The
filter is now named "Needs booking" - the Active tab's existing name for the
same tours - instead of introducing "Not scheduled yet"; the All date column
reads "Not booked" for a requested tour (the tour page's word) and "Undated"
for any other undated tour (the Past tab's word). GLOSSARY records every label.
Flagged for the spec gate (Cameron described the set as "not scheduled yet").
Decision changed: YES (label).

### R1-11 [A11] The current-tab rule inverts #1's - ACCEPT
Re-clicking the All tab while on it no longer navigates (it keeps the filters
and an unsaved search). #1 keeps filters on a re-click too
(`ListingsList.tsx:321-324`); here the tab strip lives in the parent, which
cannot see the child's local state, so doing nothing is the faithful version.
Decision changed: YES (small).

### R1-12 [A12] The row's accessible name omits the status - ACCEPT
The name now ends with the status label and, on a closed row, the outcome (the
Past tab ruling, `ToursPage.tsx:231-234`).
Decision changed: NO (precision).

### R1-13 [A14, B14] Typed harness fakes and the range-read page-size seam - ACCEPT
Named in 5.6/7/9: `twilioWebhookHarness.ts:2690` (UnitsRepo) and `:3470`
(ToursRepo) implement the new methods; `listByScheduledRange` gains an optional
test-only page size; the list's budget constants are injectable.
Decision changed: NO (precision).

### R1-14 [A15, B11] perf cannot catch a walk refetch; stale ledger citations - ACCEPT
A dashboard test pins "the walks run once across Active -> Past -> Closed";
the `CONTRACT_SOURCE_LEDGER` citations for `/tours` and `/tours/closed` (and the
App.tsx resolver citation) are refreshed in the same change.
Decision changed: NO (precision).

### R1-15 [B1] A search restored from the URL has no walk trigger - ACCEPT
The walk starts on ANY adoption of a non-empty search (mount, browser Back,
the back arrow), immediately, as well as 300 ms after typing. D2 now reads: the
first screen of an UNSEARCHED list never loads every tour; a search is D3's
explicit exception.
Decision changed: YES.

### R1-16 [B4] Returning from a tour resets the list to page 1 - ACCEPT (planner call P14, flagged)
Returning by the back arrow or browser Back reloads the list to the depth
already loaded (fresh reads, never a stale cache) and brings the opened row
back into view with focus on it; any other arrival starts at page 1. The
cheaper alternative - state the loss - is offered at the spec gate.
Decision changed: YES.

### R1-17 [B10, B13, B14] Today's cap warning, walk lifecycle, minor misdescriptions - ACCEPT
- today.ts's `warnIfCapped('tours_today', ...)` (`today.ts:551`) can only raise
  a false alarm once the read pages; it is removed in the same change.
- Walk lifecycle: Load more is hidden while a walk runs; clearing the search
  aborts the walk (loaded rows and the last completed page's cursor stay); on a
  duplicate tourId the later copy's data replaces the earlier row in place;
  rows whose names did not load cannot match a search (best-effort names) -
  stated as a limit.
- 3.2 caller list completed (`useContactFile.ts:162, 172`, `useToday.ts:65`);
  5.2 no longer promises "no claim internals" (`convertedPlacementId` can hold
  the `pending:` sentinel, as `GET /api/tours` already returns); the e2e creates
  its own uniquely named tenant and property per run and asserts through a
  search (which walks the whole list), not page depth.
Decision changed: YES (today.ts).

Round 1 changed decisions: YES -> round 2 with reviewer A continued (15
accepted vs 14; it receives reviewer B's report).

## Round 2 (spec draft 2 @0775dbd4; reviewer A continued, with B's round-1 report)

Report: `spec-r2-a.md` (7 findings, 2 concessions).

### R2-1 [A-r2 1] The restore has no anchor once the user acted on the tour - ACCEPT
Verified the surfaces cited (mark toured / no-show, reschedule, record outcome,
cancel all change the field a filtered list keys on). The restore record now
also keeps the opened row's 0-based POSITION; when the opened row has left the
list, the view lands on the row now at that position - the next one to work
on, which is exactly the follow-up loop P14 serves. Test added.
Decision changed: YES.

### R2-2 [A-r2 2] Restore trigger scope, no cap, D2/D3 wording, no test seam - ACCEPT (redesigned)
Took the reviewer's suggested shape: the restore record lives in HISTORY STATE,
not module memory - written into the list entry's own state by the stamped
REPLACE that opening a row now always makes, and carried by the row link and
the tour page's back arrow. So it is per history entry (Back/Forward-correct),
an arrival without a record starts at page 1, and there is no module state to
reset between tests. The restore is capped at 10 requests. D2 and D3 reworded
(a fresh unsearched visit loads one page; a search is the one thing that loads a
whole list on its own; Load more, Keep checking and a capped restore load
further only on the user's own history).
Decision changed: YES (mechanism).

### R2-3 [A-r2 3] "No phantom Load more" is false for unfiltered phases - ACCEPT (peek)
DynamoDB returns a LastEvaluatedKey whenever it stops at Limit. Unfiltered
Queries now ask for the rows still needed PLUS ONE; the peek row proves more
exist and is never sent, so an unfiltered final phase never leaves a phantom.
The guarantee is narrowed to that case; filtered phases and a phase boundary
whose successor is empty can still cost one empty page, which 4.5 absorbs.
Decision changed: YES (small).

### R2-4 [A-r2 4] Paging state machine gaps - ACCEPT
One loader at a time (Load more, Keep checking, the walk, the restore); a search
typed during a restore takes over its cursor; Keep checking is shown INSTEAD of
Load more; a 400 on a cursor-bearing request restarts the list at page 1 ("The
list was refreshed.") instead of offering a Retry that cannot succeed; P15
suppresses only an unmodified primary click.
Decision changed: YES (small).

### R2-5 [A-r2 5] Cost statements; the requested partition over-reads - ACCEPT
Cost wording corrected (the status set chooses phases and partitions; filters
within a phase narrow only what is sent). The requested partition drops its
not-exists filter (I1 + P10 make it a no-op; client de-duplication absorbs a
violation), so with no type filter it is an unfiltered, peek-limited Query; the
phase-D status filter is omitted when every dated status is pressed.
Decision changed: YES (small).

### R2-6 [A-r2 6] e2e steps still depend on page depth - ACCEPT
Every e2e step now searches for the unique tenant name.
Decision changed: NO (test precision).

### R2-7 [A-r2 7] "Undated" on the All row vs "Not booked" on the tour page - ACCEPT
Decided: the tour page's facts line keeps "Not booked" for a requested tour and
reads "Undated" for any other undated tour (`TourDetail.tsx:312`), matching the
All and Past rows; GLOSSARY records both words.
Decision changed: YES (small, a tour-page copy change).

### Contested - both rejections stand
R1-2 (PATCH stamping) and R1-7 (PATCH no-show guard): conceded by the reviewer
with evidence (`toursRepo.ts:355-364`, `airtableSource.ts:189-196`,
`tours.ts:146`, `TourDetail.tsx:319`).

Round 2 changed decisions: YES -> round 3 (reviewer A continued). Round 4 is the
hard cap.

## Round 3 (spec draft 3 @7a8ac2f3; reviewer A continued)

Report: `spec-r3-a.md` (5 findings). The reviewer confirmed the history-state
record survives react-router 7.18's declarative BrowserRouter
(`main.tsx:15-19`; synchronous `replaceState`/`pushState` into
`history.state.usr`), that the extra REPLACE per row open is far inside
WebKit's budget, and that the own-write stamp and adoption rules do not
collide with it.

### R3-1 [A-r3 1] The anchor can steal focus from a user who is already typing or scrolling - ACCEPT
The anchor is dropped if the user types, clicks or scrolls anywhere on the page
before the load ends; a test types into the search box during a slow walk.
Decision changed: NO (a guard on an existing action).

### R3-2 [A-r3 2] The always-on row-open write - ACCEPT
The pending-navigation skip wins (that entry then has no record; the back
arrow's copy remains); only an unmodified primary click writes a record;
every write replaces the whole history state, so a filter change or a blur save
drops the record (stated in 4.7 and 4.9); a reload of an entry with a record
restores too.
Decision changed: NO (precision).

### R3-3 [A-r3 3] Anchor terms under a search and at the cap - ACCEPT
`openedIndex` and "still in the list" count VISIBLE rows (the matches under a
search); a capped restore that stopped short of `depth` anchors only on the
opened row itself, never on a position.
Decision changed: NO (precision).

### R3-4 [A-r3 4] The "Undated" rule misses three tour lists - ACCEPT (scope narrowed)
Verified: `TenantFile.tsx:337`, `LandlordFile.tsx:217`, `ListingDetail.tsx:1084`
print "Not booked" for every undated tour, as does `TourDetail.tsx:312` (and
`:783`). Rather than spread a copy change across four surfaces outside the All
tab, draft 4 REVERTS round 2's tour-page change: the All rows follow the Past
tab ("Not booked" for a request, "Undated" otherwise), the four other surfaces
are unchanged, the GLOSSARY names which surfaces use which word, and the
alignment is filed (`docs/issues/undated-tour-wording.md`) and offered to
Cameron at the spec gate as a one-line-per-surface addition.
Decision changed: YES (a surface removed from the build).

### R3-5 [A-r3 5] The cursor-400 restart can loop; a search typed during Load more - ACCEPT
At most one automatic restart per list (a second cursor 400 shows the error and
stops any walk or restore); a search typed while Load more, Keep checking or
the empty-page follow has a request in flight lets it finish, then walks on
from its cursor.
Decision changed: NO (precision).

Round 3 changed one decision (R3-4, a scope reduction) -> round 4, the hard
cap: if it changes a decision, the open findings go to Cameron as a decision.
