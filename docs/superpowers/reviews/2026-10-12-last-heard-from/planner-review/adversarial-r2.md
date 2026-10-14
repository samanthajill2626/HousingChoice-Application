# Adversarial re-review (round 2) - feat/last-heard-from, planner fix wave

Scope: commits 8d365094 (follow-ups lookback filter + unit tests) and
814cc258 (contacts-list-facets e2e) on 6f0673c9, plus a second pass over the
whole branch, plus the adjudications in `adjudications.md`. Read-only; no
tests or commands run besides git/grep/read.

Result: one new LOW in the branch, one LOW precision note on the fix. The fix
is correct, not merely plausible. No adjudication contested.

---

## 1. What did we all miss?

### 1.1 [LOW] A one-click Interested creates a tour that the same page's Tours card never shows; the next step on that page is a duplicate tour

Where:
- dashboard/src/routes/listing/ListingDetail.tsx:420-423 - `onRecipientOutcome`
  applies only the returned row (`setRecipientRow`). It does not touch the
  page's `tours` slice.
- The property page's "Tours on this property" card renders that slice
  (ListingDetail.tsx:1241-1258, loaded once at useListing.ts:204-225).
- The contact page is the same: ContactDetail.tsx `onListingOutcome` calls only
  `file.setListingSentRow`, and the tenant's Tours card renders `file.tours`.
- Server side, a route-mode Interested really creates a `requested` tour
  (app/src/routes/units.ts:1338-1349).

Failure scenario: on the property page, staff click Interested on a "Sent to"
row (property has a tour_type). The row turns into a "Tour requested" chip,
but the Tours card a few inches away still says there are no tours (or does not
list the new one). Staff then use that card's or the header's Schedule tour.
POST /api/tours does no dedupe (the already-filed `tour-create-no-dedupe`), so
the tenant now has two open tours for one property, and two reminder ladders
once both are booked. The Activity card is stale in the same way (no
`listing_interested` row until a reload). The row's chip does link to the real
tour, which is why this is LOW. Fix shape: when the returned row carries a
`tour` the slice does not have, refetch (or append to) the tours slice, on both
hosts.

Nothing else new. On the second pass I also checked the Sent-to 503 path (the
card has its own error branch, ListingDetail.tsx:1231) and the contact page's
units load (all pages, so "absent unit = deleted" holds). The reasoning in the
auto-reply issue checks out too: the live parser lives in lib/emailMime.ts and
the stored header set is capped (inboundEmail.ts:316-346).

---

## 2. The fix (unreviewed code)

### 2.1 followUps.ts lookback filter - correct

- Boundary: the filter keeps `sentMs >= now - FOLLOW_UP_LOOKBACK_MS`.
  `isWaiting` rejects `now - sentMs > FOLLOW_UP_LOOKBACK_MS`
  (lib/listingSendOutcome.ts:120). These are the same predicate on integer ms
  with the same `now` (`deps.now`, passed once from the route). So the filter
  can drop no row that isWaiting would have kept, and the exact boundary
  instant is kept by both.
- NaN / absent sentAt: the filter drops them. isWaiting also drops them
  (`instantMs` undefined -> false, listingSendOutcome.ts:117-118), and
  listByUnit already returns only listed rows. No behavior change.
- Future sentAt (clock skew) is kept by the filter. isWaiting then finds it
  not quiet, so it is not listed. Same as before.
- No cross-row dependency is lost. A listing_sends row is one (unit, contact)
  pair, and its `sentAt` is already the latest counted share. Dropping one
  pair's old row cannot change another pair's outcome. Tours are read per unit
  and grouped by tenant, so a dropped row only removes an unneeded join.
- byUnit / truncated: `byUnit` is derived from `items`, which only ever held
  in-window rows, so it is unchanged. `truncated` comes from the unit walk
  (step 1), which the fix does not touch. So the Properties pill gives the same
  answer as before, with fewer reads behind it.
- Tests: both new cases pin the read shape (no tours read and no contacts batch
  for old-only units; the batch ids are exactly the recent recipient). They
  would fail if the filter moved below the joins.

### 2.2 [LOW] Precision: the joins are bounded now, but the reads are not

The adjudication says the fix stops "the work grows with every send ever made".
That is true of the tours reads and the requireComplete contacts batch, which
are the parts that could 503 the list. It is not true of
`listingSends.listByUnit`, which still pages every row (full items with their
`shares` maps) of up to 100 units on every Properties and Matching mount.
There is no failure mode here (a Query failure was already a 503, and no batch
is involved), so this is wording only. If the read volume ever matters, a
sentAt-bounded read is the next step: for example a byUnit query with a
FilterExpression on sentAt, which still costs read capacity but trims the
payload. Not blocking.

### 2.3 contacts-list-facets.spec.ts additions - prove what they claim, low flake risk

- After "Show all statuses" with the search cleared, the spec asserts the
  placed AND inactive rows are present (toHaveCount(1)). Before, only the URL
  was checked. Then, from the default-plus-Inactive state, it toggles the
  Placed chip on (row present, aria-pressed true, URL carries status=placed)
  and off (row gone). That is exactly C3's gap.
- Selectors key on `freshTenant(...)` first names, which are run-unique
  (spec header line 38). There is no cross-run or substring collision between
  'StatusPlaced' and 'StatusInactive'. The `Placed` chip regex is anchored and
  avoids `Placing`.
- Flake risk: low. Filtering is client-side over a list loaded after both
  status writes. The `goto` happens after the API writes, and the earlier
  `toPass` reload loop guarantees a fresh load. Each chip click re-renders
  synchronously and is awaited through web-first assertions. toHaveCount
  proves presence in the DOM, not visibility, which is all the facet claim
  needs.

---

## 3. Adjudications

- A2 (auto-reply deferred as med issue): CONCEDE. Texting is the primary
  channel and the filed issue (docs/issues/email-auto-reply-moves-last-heard-from.md)
  names the right headers, both affected writers and the one-rule fix.
- A3 (Activity card crowding noted): CONCEDE. The dual write is specified.
- A4 (1:1 first-participant rule noted): CONCEDE. Reachability is unproven,
  and the rule is the spec's.
- A5 (stale-card action): CONCEDE. Already filed by the build.
- A6 (join duplication deferred): CONCEDE. Filed as low.

## 4. Verdict on the fix

Correct. The early filter uses the same predicate as `isWaiting`, so it cannot
change any listed row, `byUnit`, `truncated` or the pill, and it removes the
reads that grew with history and could 503 the list. The e2e additions close
C3 as claimed.
