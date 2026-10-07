# Tour list (All tab) - adversarial design review, round 1, reviewer A

Spec: `docs/superpowers/specs/2026-10-06-tour-list-design.md` (DRAFT 1, commit
3bf77856 on `feat/tour-list`, cut from main @d839494a). Repository read-only;
every claim about current behavior below cites code read at that commit.
Anything not verified in code is marked UNVERIFIED.

Verified correct (no finding): 3.1 load inventory (`ToursPage.tsx:621-627`,
`useTours.ts:121-153, 293-340`), the tab-order pin (`ToursPage.test.tsx:507-511`),
3.2 GET /api/tours priority and unpaged response (`tours.ts:363-403`), GSI shapes
and ALL projection (`tables.ts:14-16, 526-551`), the single-Query range read and
its two callers (`toursRepo.ts:399-416`, `tours.ts:387`, `today.ts:550`), the
placements cursor precedent (`placements.ts:172-221, 509-572`), the contacts
batch read (`contactsRepo.ts:636, 849-904`), no BatchGet in `unitsRepo.ts`,
units and contacts soft-delete only, 3.3 back targets (`TourDetail.tsx:113-124`),
3.5's description of #1 (`ListingsList.tsx:7-36, 209-287`), the cast
`TOUR_TOURED` defect (`cast.ts:799-817`, raw PutCommand at `seed/index.ts:149-157`),
the perf route pin (`routes.test.ts:376-385`), and the repo stamping
`_schedPartition` since its first commit (1acb89a4), so prod rows written through
the repo carry it (no other prod writer found; historical prod data UNVERIFIED).

---

## 1. [HIGH] The cursor cannot say "start the next phase"; a budget that runs out exactly where a phase ends has no legal cursor

**What is wrong.** 5.4 defines three stop cases: page full mid-batch (cursor =
last returned row's key), budget spent (cursor = "the last Query's
LastEvaluatedKey"), everything exhausted (null). 5.5 makes `k` MANDATORY
("exactly the attribute names of that phase's index plus tourId") and says
"Anything else -> 400 invalid cursor". There is a fourth, reachable stop: the
call budget is spent on the very call that EXHAUSTS a phase (or one of phase
U's statuses) while later phases remain. That Query returns no
LastEvaluatedKey (DynamoDB ends a Query with no key when its key range runs out
before Limit - the repo's own walker relies on exactly this,
`dynamoPaging.ts:45-49`), and under a FilterExpression it can return zero Items,
so there is no row key to synthesize either. The next request must start "phase
U, status i, from the beginning" - a cursor with no `k`, which 5.5 forbids.

**Evidence.** Spec 5.3 (D then U; U walks requested, toured, canceled, closed in
turn), 5.4 (three cases only, `MAX_QUERY_CALLS` = 5), 5.5 (`{ v, f, n, ph, i?, k }`,
`k` required, strict validation). Worked case: `when=any&status=canceled` over
~800-1,000 dated tours - phase D's filtered walk ends on call 5 of a request with
a partial page and no LastEvaluatedKey; the next page must begin phase U at
`canceled` with no start key. The same thing happens at every U status boundary
(requested -> toured -> canceled -> closed), roughly one boundary in five under
any sparse filter, and in the search walk (section 6) on every sparse list.

**What it implies.** A literal build has three options, all bad: return
`nextCursor: null` (silently drops every remaining phase - under Any time that is
the whole undated tail, including every open request), overspend the budget
(violates 5.4), or invent a k-less cursor its own validator then 400s. Fix in
the spec: `k` optional, absent meaning "start of phase `ph` / status `i`";
enumerate the legal (`ph`, `i`, `k?`) combinations per `when`; add route tests
for "budget exhausted exactly at the D->U boundary" and "at a U status
boundary". Also state the benign corollary: a page that fills on the last row of
the final phase carries a cursor whose next page is empty (one phantom Load
more), unless the server peeks.

---

## 2. [MEDIUM] I2's writer list is wrong: seeded requested tours carry no `_schedPartition`, PATCH never stamps it, and a booked one vanishes from every view including All

**What is wrong.** 3.6 says "Every other tours writer stamps it: the repo's
create and the live, matrix and performance seeds"; 8/I2 lists "PATCH and the
other updates (never remove it)" as writers that preserve it. But:
- The matrix seed's `requested` tours are written WITHOUT `_schedPartition`
  (`matrix.ts:940-946`; only the dated branch stamps it, `matrix.ts:998`), and a
  test REQUIRES its absence (`seedMatrixCoherence.test.ts:410-417`, "must not be
  on the scheduled GSI").
- The cast's requested tour `TOUR_SEARCHING` has none either (`cast.ts:547-561`).
- Both go in by raw PutCommand (`seed/index.ts:127-132, 149-157`), unlike the repo, which
  stamps every tour including requested ones (`toursRepo.ts:355-364`).
- PATCH is the writer that ADDS `scheduledAt` (booking, `tours.ts:1134-1149`;
  "already toured" with a date, `tours.ts:1067-1083`) and it never writes
  `_schedPartition` (`toursRepo.ts:439-492` SETs only supplied fields).
`byScheduledAt` indexes an item only when both `_schedPartition` and
`scheduledAt` exist (`tables.ts:537-542`).

**What it implies.** In the full-profile world, booking (or marking toured with
a date) any of those three seeded requested tours produces a dated tour that is
in no date read (Active Upcoming, Past, Today, phase D) AND is excluded from
phase U by `attribute_not_exists(scheduledAt)` (5.3) - absent from every All
view. P10 fixes only `TOUR_TOURED`, so the defect class the spec set out to close
stays open, and any self-QA of this feature in the demo world that books a
seeded request will see the tour disappear. Fix: stamp `_schedPartition` on every
seeded tour row (and invert `seedMatrixCoherence.test.ts:415`), or have PATCH
stamp `_schedPartition: 'tours'` whenever it writes `scheduledAt` - a writer
change the spec currently rules out ("it changes no writer", section 8). Correct
3.6 and I2 either way.

---

## 3. [MEDIUM] "Never an empty page above Load more" is false by the spec's own 5-follow cap, the resulting state has no copy, and phase U makes it the default view's steady state at scale

**What is wrong.** 4.5: an empty page with a cursor "is followed automatically,
up to 5 in a row, so the list never shows an empty page above a Load more
button." After the fifth empty follow the list does exactly that. 4.5 defines
copy only for a failure and for an empty COMPLETE list ("No tours match these
filters."); "0 (or N) rows, incomplete, follow cap reached" is undefined (and P8
would print "Showing 0 tours").

**Evidence.** Budget 5 calls x 200 items = 1,000 items evaluated per request
(5.4); 1 + 5 follows = 6,000 items evaluated with no match before the cap.
Phase U on Any time - the DEFAULT view (P2) - walks the byStatus partitions for
toured, canceled and closed with `attribute_not_exists(scheduledAt)`, i.e. it
re-evaluates every DATED tour of those statuses to find the few undated ones.
Auto-close moves every undecided scheduled/toured/no-show tour to `closed`
(`toursModel.ts:162-166`), and section 10 itself says the closed+canceled list
"only grows". Sparse filters hit the same wall sooner, e.g. Past + Scheduled
with Earliest first (scheduled-and-past tours exist only in the last two weeks
before auto-close, so D scans every older tour first).

**What it implies.** Past roughly 6,000 closed+canceled tours, scrolling the
default view beyond the dated rows lands on empty "Load more" pages, then a
stuck state with no words for it. D2 says the server paging is built for exactly
that future. The spec must define the capped state (copy, Load more behavior)
and decide whether the default Any time view should pay a full re-read of the
closed partition to reach its undated tail at all.

---

## 4. [MEDIUM] Date range with both dates empty contradicts the server contract

**What is wrong.** 4.3: under Date range "either may be left empty ...; with
both empty the range filters nothing." 5.1: `range` "needs at least one of them"
(else 400). P6: "Upcoming, Past and Date range list dated tours only." 4.3: the
Requested chip is hidden and pruned under Date range.

**What it implies.** The first thing a user does with Date range - select it,
before typing a date - has no valid request. Sending `when=range` with no bounds
returns 400, which 4.5 renders as "We couldn't load tours. Please try again."
with a Retry that cannot succeed. Mapping it to `when=any` lists undated tours
(violating P6) and shows requested rows while the Requested chip is hidden and
pruned. There is no server mode for "dated, unbounded". The spec must pick one
(e.g. keep the previous list until a bound is entered, or add an unbounded dated
mode to 5.1/5.3) and say what the URL holds meanwhile.

---

## 5. [MEDIUM] Date range: the day-to-instant conversion and from > to are unspecified

**What is wrong.** 4.3 and 4.7 say From/To are local calendar days
(`YYYY-MM-DD`); 5.1 says the browser sends ISO instants. Nothing says To means
the END of the To day, and nothing says how the client handles From after To.

**Evidence.** The house precedent is `pastToursDateRange`: start of the local
day, and the end as the next local midnight minus 1 ms, by calendar arithmetic
for DST (`useTours.ts:175-185`). The trap is concrete: an `<input type="date">`
value parsed with `new Date('2026-10-06')` is UTC midnight (ECMAScript date-only
form), i.e. the previous evening in Atlanta. 5.1 makes `from > to` a 400, which
4.5 again renders as a generic error with a futile Retry. Section 9 has no test
that pins "a tour at 6 pm on the To day is included".

**What it implies.** A silent off-by-one-day filter (the To day excluded, or both
ends shifted by the UTC offset) in the one filter Sam asked for by name. State the
conversion (cite `pastToursDateRange`), give from > to a client-side rule (swap,
or an inline message, never a 400), and add the boundary test.

---

## 6. [MEDIUM] `state.back` taken from "the current URL" drops the search text

**What is wrong.** 4.4: the row link carries `state.back` "set to the current
/tours/all URL". 4.7: the search text reaches the URL only on blur and on row
open - a REPLACE through `setSearchParams` that react-router 7 applies inside a
transition (`ListingsList.tsx:7-12`; row-open save at `ListingsList.tsx:114-116,
271-279`). The row's Link `state` prop was rendered from the pre-write location,
so the click carries a back pointer without `q`. TourDetail's back arrow is a
plain Link to that pointer (`TourDetail.tsx:271, 683`).

**What it implies.** Search, open a row, press "Back to tours": the filters come
back, the search does not - while the browser's Back button (POP to the replaced
entry) does restore it. #1 itself builds its current-tab target from LOCAL state,
"typed text included", not from the URL (`ListingsList.tsx:293-296`). The spec
should say `state.back` is computed from the local selection (filters + q) at
click time, and the e2e row-open/back step should include a search.

---

## 7. [LOW] An undated `no_show` is reachable through the API; 3.4, D4 and I1 are false and phase U never reads `no_show`

**What is wrong.** 3.4: "`no_show` is refused from requested (`tours.ts:1084-1087`),
so it always had one." The guard refuses only the direct edge. PATCH allows
requested -> canceled and requested -> toured with no date
(`tours.ts:1067-1083`), and then canceled -> no_show or toured -> no_show pass
every guard in `tours.ts:1051-1106` - none requires a date for `no_show` (only
`scheduled` does, `tours.ts:1096-1105`). The dashboard offers Mark no-show only
on `scheduled` (`TourDetail.tsx:319`), so this is API-only today.

**What it implies.** D4's "exactly the requested tours" and I1's "no_show always
[has a date]" do not hold for the server contract the spec builds on. Phase U
walks requested, toured, canceled and closed only (5.3), so such a tour is on no
All view until auto-close makes it an undated `closed`, and is invisible again if
reopened (`toursModel.ts:253-259` returns it to `no_show`). Cheap fixes: add
`no_show` to phase U (its partition is small - auto-close drains it), or refuse
`no_show` without a date in PATCH (a writer change). Either way correct the claims.

---

## 8. [LOW] Search walk: the page cap is not a row cap, every cap cuts the open requests first, and "loads every tour once" understates the server read

**What is wrong.** Section 6 caps the walk "at 50 pages (5,000 rows)", but 5.4's
budget stops return partial or empty pages, so 50 pages can be far fewer rows.
P6 puts every undated tour after every dated tour, so this cap (and the 5-follow
cap, finding 3) always truncates the undated tail first - the requested tours,
the same work queue the Active tab calls Needs booking. "A search with no other
filter loads every tour once" is true of what the browser receives; the server
evaluates every dated toured/canceled/closed tour twice (once in D, again in U's
not-exists scan). And 4.9 says the hook reuses `fetchAllPages`' conventions
while 6's "covered only the first rows" copy is the incomplete-list notice that
`paging.ts:20-26` records the house deciding against.

**What it implies.** State the cap in rows evaluated or pages, not as an
equivalence; say plainly that a capped search can miss open requests; own the
departure from `paging.ts`' convention rather than claim to reuse it.

---

## 9. [LOW] "Upcoming" and "Past" on the All tab mean something else than on the Active and Past tabs, unacknowledged

**What is wrong.** All's Upcoming = `scheduledAt >= N` (a server instant), every
status by default (P2, P4, 5.3). Active's Upcoming is status `scheduled` only,
from the start of the local day - the filter added after "the leak Cameron
caught 2026-07-15", when canceled and closed tours showed under Upcoming
(`useTours.ts:1-7, 45-54, 76-80`). The Past tab is 90 days of needs-a-decision
statuses with local-day boundaries (`useTours.ts:159-212`). So a canceled tour
next week shows under All > Upcoming; a tour at 9 am today is "Past" on All, in
Active's Today group, and deliberately NOT on the Past tab. D1's rationale "the
tabs read from the widest set to the narrowest" is also false: Closed holds every
closed and canceled tour ever (`useTours.ts:117-153`) and grows without bound.

**What it implies.** Two different "Upcoming" lists and two different "Past"
lists on one page. The spec should record the divergence as a decision (or rename
the When options) and drop the ordering slogan.

---

## 10. [LOW] The label inventory is wrong: Past and Today do not use `tourStatusLabel`, and P12 misses "Not booked"

**What is wrong.** Section 8 calls `tourStatusLabel` / `TOUR_OUTCOME_LABELS` "the
shared readers every other tour list uses". The Past tab and Today read
`pastState` (`ToursPage.tsx:208`, `Today.tsx:199`): the same tour reads "Not
marked" there and "Scheduled" on All, "Needs outcome" there and "Toured - needs
outcome" on All. P12 says a requested tour has three staff labels, but P7 adds a
fourth ("Not booked" in the All date column), and `TourDetail.tsx:312` already
prints "Not booked" for EVERY undated tour - so an undated toured tour reads
"Undated" on its All row (P7) and "Not booked" on its own page. The GLOSSARY has
no entry for any of these (grep of `documentation/GLOSSARY.md`).

**What it implies.** The GLOSSARY entry P12 promises would be incomplete on
arrival; decide whether TourDetail aligns with P7 and list every label.

---

## 11. [LOW] Claims #1's URL model but inverts its current-tab rule

**What is wrong.** 4.7: "The state model is #1's (3.5)", yet "the All tab link
clicked while filtered is a PUSH to bare /tours/all and resets the filters". In
#1 only the OTHER tab is bare; the current tab carries the query, so re-clicking
it keeps the filters (`ListingsList.tsx:321-324`). Here the tab strip lives in
`ToursPage` (`ToursPage.tsx:708-719`) while the filters live in the child (4.7),
so the parent cannot carry them without lifting state.

**What it implies.** A builder copying #1 either implements #1's rule
(contradicting 4.7) or the reset (contradicting "#1's model"). State it as a
deliberate divergence, or lift the selection so the current tab can carry it.

---

## 12. [LOW] The row's accessible name omits the status

**What is wrong.** 4.4: "Tour for <tenant> at <property>, <date column>". The
aria-label replaces the link's content as its name; the Past tab's adversarial
review ruled that the state chip must therefore ride in it, or a screen reader
cannot tell the rows apart (`ToursPage.tsx:231-234`). On the All list status
varies per row and is the main filter axis.

**What it implies.** Include the status label (and the outcome on a closed row)
in the name; the e2e "Past + No show" check can then assert it by role.

---

## 13. [LOW] "The same contract as GET /api/tours?from&to" is a raw lexicographic compare

**What is wrong.** 5.1 adopts the existing from/to contract. That contract accepts
anything `Date.parse` accepts (`tours.ts:136-140`) and passes the RAW strings into
the BETWEEN (`tours.ts:383-387`), while every write canonicalizes to
`toISOString()` because the GSI compares strings (`tours.ts:303-315, 1130-1137`).
5.1 also compares `from <= to` and 5.5 fingerprints from/to.

**What it implies.** Say the new route canonicalizes (`new Date(x).toISOString()`)
before the key condition, the comparison and the fingerprint; an offset-bearing
or date-only value otherwise mis-buckets silently.

---

## 14. [LOW] Unenumerated surfaces: the typed harness fakes and the range-read page-size seam

**What is wrong.** `app/test/helpers/twilioWebhookHarness.ts` declares
`const unitsRepo: UnitsRepo` (line 2690) and `const toursRepo: ToursRepo`
(line 3470). 5.6 adds `UnitsRepo.getDisplaysByIds`; 5.4's paged phase reads need
a repo surface; section 7's test "forces a small page size" through
`listByScheduledRange(from, to)`, which has no page-size parameter
(`toursRepo.ts:206, 399-416`). Section 9 names none of these.

**What it implies.** The typecheck gate fails until the fakes implement the new
methods, and any harness test that drives the route needs a fake that honors
Limit-before-filter and ExclusiveStartKey. List them so the plan budgets them.

---

## 15. [LOW] perf:pages cannot protect 4.2's "no refetch on Active/Past/Closed", and nothing else does

**What is wrong.** 4.10 cites the GET contracts, but the contract that actually
encodes "one mounted component" is the WARM classification for `/tours/closed`
(`e2e/performance/routes.ts:748-756`). In warm mode every contract except the
status read is downgraded to conditional (`routes.ts:886-891`), and
`assertObservedGets` flags only missing-required and undeclared shapes
(`routes.ts:896+`), so a remount that re-fires all four walks still passes.
Section 9 has no dashboard test for "switching among Active, Past and Closed
does not refetch the walks". The source ledger cites `ToursPage.tsx` line ranges
that 4.2 moves (`routes.ts:724-725, 754, 778-779`); its test checks the citation
FORMAT only (`routes.test.ts:422-427`).

**What it implies.** Add a dashboard test that mounts `/tours`, switches to
`/tours/past` and `/tours/closed`, and asserts the walks ran once; update the
ledger citations in the same change.
