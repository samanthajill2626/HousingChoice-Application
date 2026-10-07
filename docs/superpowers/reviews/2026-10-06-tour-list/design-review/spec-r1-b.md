# Tour list (All tab) - adversarial design review, round 1, reviewer B

Spec under review: `docs/superpowers/specs/2026-10-06-tour-list-design.md`
(DRAFT 1, commit 3bf77856 on `feat/tour-list`, cut from main @d839494a).
Method: every claim about current behavior was checked in the code at that
commit; citations are `file:line` as read. Nothing was run. Spec citations are
by section (and by spec line where useful).

Verified as stated (no finding): 3.1 (App.tsx:240-242, ToursPage.tsx:589-593,
621-627, 660-674, PastToursView at 348), 3.2's GSI shapes, the single-page
`listByScheduledRange` (toursRepo.ts:399-416), the placements cursor
precedent (placements.ts:172-221, 509-572), `getDisplaysByIds`
(contactsRepo.ts:636, 849-904), no batch read in unitsRepo, 3.3
(TourDetail.tsx:113-124), 3.5 (ListingsList.tsx:7-36, 209-287), the cast
TOURED tour lacking `_schedPartition` (cast.ts:799-817), the lean world having
no tours, the perf pin and its exclusion set (routes.test.ts:287-301,
348-391), all GSIs projecting ALL (tables.ts:14, 60) so phase U's
not-exists filter and the type filter are evaluable on the indexes.

---

## 1. [HIGH] A search restored from the URL has no defined walk trigger

**What is wrong.** Section 6 starts the "load the REST" walk only "300 ms after
typing stops". Section 4.7 persists `q` in the URL (written on blur and on row
open) and adopts the URL on mount; 4.8 sends the back arrow to that URL; the
browser Back button lands on the same history entry. So the most common way a
search reaches the list - returning from a tour the user opened out of a
search - is a MOUNT with `q` already set and no typing at all. The spec never
says whether a mount-time `q` starts the walk.

**Evidence.** Spec 6 (the trigger), 4.7 (q in URL, adoption on mount and on
POP), 4.8 (back arrow returns to the URL with "any query string"), 9 (the e2e
step "search; a row opened and the back arrow returning to the same filtered
URL" exercises exactly this path). TourDetail's back arrow is a PUSH `<Link>`
(TourDetail.tsx:270-271, 683), and the All view is a fresh mount on return
(TourDetail is a different route element, App.tsx:245).

**What it implies.** The builder must guess, and both guesses break a stated
guarantee:
- Walk does not start on mount: the search covers page 1 only (50 rows) while
  the count line - which the spec defines only for "Searching..." during a
  walk and "N matches" after it - most plausibly reads "N matches", i.e. a
  short list presented as a complete one. That is the exact silent-truncation
  class `dashboard/src/api/paging.ts:3-26` exists to forbid.
- Walk starts on mount: D2's "Showing the first screen must never load every
  tour" is violated on every back-navigation, reload or shared link that
  carries `q`, and the full walk (up to 50 requests) is repeated once per row
  the user opens.
The spec must name the trigger (and, if it is mount, reconcile it with D2).

---

## 2. [HIGH] The cursor cannot represent the position the budget rule must emit

**What is wrong.** 5.4's stop rule says that when the call budget is spent
"the cursor holds the last Query's LastEvaluatedKey". But the last Query can
have NO LastEvaluatedKey: it was the final page of phase D, or of one phase-U
status, while later phases/statuses still remain. The next position is then
"phase U (or the next U status) from its start" - and 5.5 makes `k`
mandatory (`{ v: 1, f, n, ph, i?, k }`, "`k`: the exclusive start key -
exactly the attribute names of that phase's index plus tourId", "Anything else
-> 400 invalid cursor"). The only position the server can be forced to stop
at between phases is not representable, and the spec's own validator rejects
any encoding of it.

**Evidence.** Spec 5.4 (three stop cases; none covers "budget spent exactly
at a phase/status boundary"), 5.5 (k required, everything else 400). It is
reachable with ordinary filters: "Any time" + Status = Canceled walks the whole
dated partition at QUERY_PAGE_LIMIT 200 x MAX_QUERY_CALLS 5 = 1,000 items per
request; whenever a request's 5th Query is the last page of phase D (or of the
`requested` / `toured` partition inside U, which is walked status by status),
the request ends on the boundary. The phase-U walk across four partitions
makes such boundaries routine as data grows.

**What it implies.** A literal build does one of: emit `nextCursor: null`
(silently drops every undated tour - all requested tours under Any time - and
shows "N tours" as complete), emit a `k`-less cursor that its own validator
400s on Load more (a permanent "We couldn't load tours" at that point of the
list), or spend a 6th call (breaks the stated budget). The spec must define a
"start of phase/status i" cursor form and its validation.

Related validation gaps in the same model, worth closing in the same edit:
- Nothing requires `k`'s hash value to match the phase being resumed
  (`k._schedPartition === 'tours'`; `k.status` equal to the i-th U status).
  The house already records that a wrong-partition start key can "silently
  return a wrong-but-plausible page" (conversationsRepo.ts:446-451), which is
  why its group cursor is tagged.
- `i` is "the index into phase U's status order" without saying whether that is
  the fixed 4-list or the list filtered by the status set, and `ph: u` is
  accepted for `any` even when the status set skips phase U.
- "A DynamoDB ValidationException on a start key is also answered 400 invalid
  cursor" - unless scoped to requests that carried a cursor, a code defect in
  the key/filter expressions would surface as a client 400 instead of a 500.

---

## 3. [MEDIUM] `state.back` built from the committed URL drops an unsaved search

**What is wrong.** 4.4 sets the row link's `state.back` to "the current
`/tours/all` URL"; 4.7 writes the search text to the URL only on blur and on
row open. In #1's model the row-open write is the row link's own `onClick`
(ListingsList.tsx:114-116, 271-279): a stamped REPLACE whose React commit runs
inside a transition, while the `<Link state>` prop was bound at the previous
render. A user who types a search and clicks a row therefore gets a
`state.back` without `q` (unless a re-render happened to commit between the
blur on mousedown and the click).

**Evidence.** Spec 4.4, 4.7, 4.8; ListingsList.tsx:7-36 (react-router 7 applies
URL changes in a transition), 114-116, 271-279; TourDetail.tsx:121-124, 683
(the back arrow PUSHes whatever `state.back` holds).

**What it implies.** The in-app back arrow returns to the list without the
search while the browser Back button (which POPs to the REPLACEd entry)
returns with it - the two back paths disagree, and the e2e "back arrow
returning to the same filtered URL" is timing-dependent if it types a search
first. The spec should say `state.back` is built from the view's LOCAL filter
state (search text included) at click time, not from `location`.

---

## 4. [MEDIUM] Returning from a tour resets the paged list to page 1

**What is wrong.** The stated purpose (spec 1) is working through tours to
follow up - open one, text or call, come back, open the next. The All view is
a fresh mount on every return (4.2, 4.7, 4.8), and the only state that
survives is what is in the URL. Rows loaded by Load more, the auto-followed
pages, any completed search walk and the scroll position are all gone; the
user lands on the first 50 rows at the top and must click Load more again to
get back to where they were, every time.

**Evidence.** Spec 4.5 (paging state lives in the hook), 4.7 (URL carries
filters only), 4.8 (back arrow to the URL), 4.9 (`useAllTours` owns rows and
cursor). TourDetail.tsx:683 is a PUSH, so this is a remount, not a POP to a
preserved tree. Today's tabs also remount, but they load whole lists, so only
the scroll position is lost there; paging makes the loss structural.

**What it implies.** The spec treats "return to the same filtered URL" as the
whole return contract (9, e2e). Either the spec states that depth is not
restored (a conscious trade-off for the spec gate) or it defines how the
loaded pages / cursor survive the row round trip.

---

## 5. [MEDIUM] "Never an empty page above Load more" - the mechanism caps at 5

**What is wrong.** 4.5: an empty page with a cursor "is followed automatically,
up to 5 in a row, so the list never shows an empty page above a Load more
button". After the 5th empty follow the mechanism stops, and the list then
shows exactly what the guarantee says it never shows. No UI is defined for
that state: the empty-state copy is only for "An empty complete list", and the
P8 count line has no wording for zero rows with more to come.

**Evidence.** Spec 4.5, 5.4 (each request evaluates at most 1,000 items), P8.
With a sparse status filter over a large dated partition (or the undated tail
of phase U, which reads every dated toured / canceled / closed tour to find the
undated ones), six requests can evaluate ~6,000 items and match nothing.

**What it implies.** Either drop "never" or define the capped state (count
line copy for "0 shown, more to read", whether Load more shows, what the first
screen says when it is the first page that came back empty).

---

## 6. [MEDIUM] Date range edge inputs contradict each other or dead-end

**What is wrong.**
- 4.3: under Date range "either may be left empty; with both empty the range
  filters nothing". 5.1: `range` "needs at least one of them" (else 400). P6:
  "Upcoming, Past and Date range list dated tours only". The client cannot
  send `when=range` with neither bound, so "filters nothing" must mean sending
  `when=any` - which lists the undated tours, contradicting P6 - and it does so
  while the Requested chip is hidden (4.3), so requested rows appear in a list
  whose status control cannot select or exclude them.
- From later than To: 5.1 answers 400. The UI has no rule for it, so the user
  gets the generic first-page error "We couldn't load tours. Please try
  again." with a Retry that can never succeed.
- `from`/`to` left in the URL while When is not Date range are invisible (the
  inputs show only under Date range) but are not in 4.3's pruning list; 5.1
  says they are "used only by range" yet also "Any invalid value -> 400", so
  whether a stale hidden bound is ignored or breaks the request is undefined.
- The To day's conversion is unstated. BETWEEN is inclusive; sending the START
  of the To day drops every tour on that day. The house precedent converts to
  the end of the local day (useTours.ts:181-185); the spec should say so.

**Evidence.** Spec 4.3, 4.5, 4.7, 5.1, P6; tours.ts:383-387 (the existing
range route accepts any parseable ISO and compares strings, so canonical
`toISOString()` bounds matter too).

**What it implies.** The builder must invent the behavior for four reachable
inputs; the "filters -> request parameters" tests in 9 cannot be written
from the spec as it stands.

---

## 7. [MEDIUM] I2 is broken by more seed rows than P10 fixes, through a writer 8 does not list

**What is wrong.** 3.6 says "Every other tours writer stamps it: the repo's
create ... and the live, matrix and performance seeds." False for the
REQUESTED seed tours: the cast requested tour (cast.ts:547-561) and both matrix
requested tours (matrix.ts:940-946, `{ tourId, tenantId, unitId, status,
tourType, createdAt, updatedAt }`) carry no `_schedPartition`. Seeds are raw
PutCommands (seed/index.ts:149-155), so nothing adds it. Harmless while they
are undated - but PATCH, the writer that dates a tour (booking, "Mark already
toured" with a date, tours.ts:1134-1149), never sets `_schedPartition`
(PatchTourInput omits it, toursRepo.ts:168-170). Section 8 lists PATCH under
I2 only as "never remove it".

**Evidence.** Above, plus phase U's `attribute_not_exists(scheduledAt)` filter
(spec 5.3) and phase R reading `status = requested` only.

**What it implies.** In the full-profile demo world, booking (or recording as
toured with a date) any of the three seeded requested tours produces a tour
that is in NO All-tab phase: not D (unindexed), not U (it now has a date), not
R (no longer requested) - plus it drops out of Active, Today and Past as today.
P10 should stamp `_schedPartition` on every seed tour (the repo's create
stamps it on undated tours too, toursRepo.ts:355-359), and section 8 should
name PATCH as the surface that would propagate an unstamped row. Production is
unaffected (every API tour goes through create; tours are not imported,
airtableSource.ts:189-195).

---

## 8. [LOW] An undated `no_show` is reachable and is in no All-tab phase

**What is wrong.** 3.4: "`no_show` is refused from requested (tours.ts:1084-1087),
so it always had one." The route refuses only requested -> no_show. It accepts
canceled -> no_show and toured -> no_show (no guard in tours.ts:1051-1106), so
requested -> canceled -> no_show, or requested -> toured (undated) -> no_show,
yields an undated no_show. D4's "exactly the requested tours" and I1's
"no_show always has one" rest on the same misreading (the model's transition
comment lists only scheduled -> no_show, toursModel.ts:13).

**Evidence.** tours.ts:1051-1106; the dashboard offers Mark no-show only on a
scheduled tour (TourDetail.tsx:319), so only API callers reach it today.

**What it implies.** Phase U walks requested, toured, canceled, closed only
(5.3), so such a tour is missing from Any time and from Status = No show. Low
because the UI cannot produce it; the robust fix is cheap (let phase U cover
every status in the set except `scheduled`, relying on the not-exists filter
it already has), or correct 3.4 / D4 / I1 and say why it is excluded.

---

## 9. [LOW] The cost statements do not match the read mechanism

**What is wrong.**
- Section 6: "Any other filter shrinks what the walk reads." Status and type
  are FilterExpressions (5.3); DynamoDB evaluates (and bills) every item in
  the key range before a filter. Only When (a key condition) shrinks what is
  read; status and type shrink what is RETURNED. Phase U additionally re-reads
  every dated toured / canceled / closed tour to find the undated ones.
- 5.4 fixes `QUERY_PAGE_LIMIT` at 200 for every Query. On an unfiltered list a
  50-row page evaluates 200 items and the "page full mid-batch" cursor resumes
  at row 51, so the next page re-reads 150 of them: about 4x the reads per
  default page and 2x per walk page. Capping the Limit at the rows still
  needed when no filter is active removes it.

**Evidence.** Spec 5.3, 5.4, 6 ("explained to Cameron 2026-10-06" - D3's cost
model was presented with the first claim).

**What it implies.** Cheap at today's volume; the cost story given at the spec
gate should be accurate.

---

## 10. [LOW] D5 turns today.ts's tours_today cap warning into a false alarm

**What is wrong.** today.ts:550-551 reads `listByScheduledRange` and calls
`warnIfCapped('tours_today', todayTours.length, GROUP_FETCH_LIMIT)` (100,
today.ts:174), which logs "group fetch hit the cap - results truncated" when
the count reaches 100 (today.ts:412-415). Once section 7 pages the read to
completion it can never be truncated, so that reader disagrees with the new
rule. Section 7 says the two callers "are unchanged".

**What it implies.** Remove or re-word that call in the same change; it is the
only reader that still assumes the old single-page shape.

---

## 11. [LOW] The 4.2 split strands the perf contract ledger's citations

**What is wrong.** 4.10 keeps the `/tours` and `/tours/closed` GET contracts
but does not mention the ledger that justifies them:
`CONTRACT_SOURCE_LEDGER` cites `ToursPage.tsx:643-647`, `643-660` and `720-818`
(e2e/performance/routes.ts:724-725, 753-755, 778-779) and `App.tsx:117-249`
(the static resolver). 4.2 moves that code into a new component. The pin test
checks only the citation FORMAT (routes.test.ts:422-455), so it stays green
while every one of those citations points at the wrong lines.
perf-pages-tours-past-surface.md already lists "refresh the routes.ts citation
ledgers" as part of touching these surfaces.

---

## 12. [LOW] P12's GLOSSARY entry undercounts the requested tour's labels

**What is wrong.** P12 says a requested tour "now has three staff labels"
(Requested, Needs booking, Not scheduled yet). P7 adds a fourth on the same
page, "Not booked" in the date column, and the Active tab already names the
list "Unbooked tour requests" (ToursPage.tsx:763-766). On the All tab the filter
says "Not scheduled yet" while the rows it returns say "Not booked".

**What it implies.** Either align the two All-tab words or record all of them;
AGENTS.md requires the GLOSSARY to be updated with every domain-noun drift.

---

## 13. [LOW] Search-walk lifecycle is under-specified

- Load more while a walk is running: both advance the same cursor; the spec
  does not say Load more is hidden or disabled during a walk.
- "Clearing the search keeps every loaded row and the Load more state" does not
  say whether clearing ABORTS a walk still in flight (if not, it keeps loading
  up to 5,000 rows for a search nobody is running).
- 4.5 de-duplicates by tourId on append but not which copy wins (the first
  copy is the stale position/status of a tour that moved).
- A row whose name map entry is missing renders the raw id (4.4, 5.6
  best-effort), so a search by that tenant's name silently misses it and the
  count line still reads complete.

---

## 14. [LOW] Minor misdescriptions

- 3.2 "Callers: the tenant file, the property page, and the Tours tabs" omits
  the landlord file's per-unit read (useContactFile.ts:172) and Today's
  fallback range read (useToday.ts:65).
- 5.2 includes `convertedPlacementId` in `TourListRow` while promising "never
  ... claim internals"; during a conversion claim that field holds the
  `pending:<uuid>` sentinel (placements.ts:714). Harmless (tourStatusLabel
  needs it, and GET /api/tours already returns it) but the promise is wrong.
- 9 (e2e): "creates its own uniquely named tours" - tours have no names; the
  rows are named by tenant and property, so the spec must create unique
  contacts/units (or reseed) for its row scoping and search steps to be sound.
  It should also say it reseeds or loads to completion before asserting "Any
  time listing the undated after the dated": undated rows sort after EVERY
  dated tour in the lane and can sit past the first 50.
- 7: "forces a small page size" - `listByScheduledRange` takes no Limit and
  `queryAll` takes it only through the Query input (dynamoPaging.ts:30-44);
  the test seam the spec relies on does not exist yet and should be named.
