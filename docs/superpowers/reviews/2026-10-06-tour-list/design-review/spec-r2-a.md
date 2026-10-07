# Tour list (All tab) - adversarial design review, round 2, reviewer A

Spec: `docs/superpowers/specs/2026-10-06-tour-list-design.md` DRAFT 2 (commit
0775dbd4 on `feat/tour-list`). Read with the round-1 adjudications
(`adjudications.md`) and reviewer B's round-1 report (`spec-r1-b.md`). Repository
read-only; claims about current behavior cite code read at 0775dbd4. Anything
not checked in code is marked UNVERIFIED.

Order: new problems in draft 2's new mechanisms first, then the contested
adjudications, then the round-1 fixes I checked and found correct.

---

## 1. [MEDIUM] P14's restore has nothing to anchor on once the user has acted on the tour, which is the common case

**What is wrong.** 4.9 restores the list to its earlier depth and then "scrolls
the opened row into view and moves focus to its link (when the row is still in
the list)". The memory holds only the filter key, a row count and the opened
`tourId`. The spec says nothing about a row that has gone. In a status- or
When-filtered list, the things a user does on the tour page change exactly the
field the list filters on:
- Mark toured: `TourDetail.tsx:381`.
- Mark no-show: `TourDetail.tsx:387`.
- Book or reschedule (a new date, so the tour crosses the pinned instant for
  Upcoming/Past): `TourDetail.tsx:527-530`.
- Record outcome "not a fit" closes the tour (`TourDetail.tsx:558-561`), and a
  move-forward converts and closes it (`placements.ts:771-775`).
- Cancel: `TourDetail.tsx:584`.

Worked case: Past + Scheduled (tours never marked - the follow-up queue
section 1 describes). Open one, mark it toured, press "Back to tours". The
restore reloads N rows, the opened row is gone, nothing is scrolled, and the
persistent scroll container (`.content`, `AppFrame.module.css:383`) leaves the
user near the top. Under Any time a rescheduled tour stays in the list but at
its NEW position, and the restore scrolls there - away from where the user was
working.

**What it implies.** The restore fails in the very loop P14 was added for
(reviewer B round 1 #4: open one, text or call, come back, open the next). The
memory should also keep the opened row's index (or its neighbours' ids), and
when the row is gone the view should land at that position. Section 9 needs a
test for "the opened row is no longer in the list".

---

## 2. [LOW] P14's trigger and cost: it restores on any matching POP, re-reads every earlier page on each return with no cap, and has no test reset seam

- **Trigger scope.** The trigger is "a POP or carries returnToList" plus a key
  match (4.9). So a POP from ANY page restores and focuses the row last opened,
  possibly long ago - for example All -> Active tab -> browser Back, or All -> a
  placement -> Back. P14 says "Every other arrival starts at page 1".
- **No cap.** The restore loads "until it holds at least that many rows or the
  list ends". Neither the 10-page follow cap (4.5) nor the 50-request walk cap
  (6) bounds it. A depth reached through several Keep checking rounds (each up
  to 11 requests x 5 Queries x 200 items), or through a whole-list walk, is
  read again in full on EVERY return.
- **D2 and D3 no longer hold.** D2 says "the first screen of an UNSEARCHED list
  never loads every tour" and D3 says "a search is the one way the All tab loads
  a whole filtered list". Restoring a fully loaded unsearched list, and repeated
  Load more / Keep checking, both load whole lists.
- **Test isolation.** The memory is module state, like the Past batch store,
  and that store ships a test reset seam (`resetBulkBatchStoreForTests`,
  `ToursPage.tsx:330`). Section 9 names no seam, so dashboard tests would leak
  the memory from case to case and restores would depend on test order.

**What it implies.** State the POP scope as a decision. One option: keep depth
and the opened id in the list entry's own history state, stamped at row open,
which also makes Back/Forward work per entry. Then:
- cap the restore, or say plainly that it is uncapped;
- reword D2 and D3;
- add the test seam.

---

## 3. [LOW] "No phantom Load more" is false exactly where draft 2 added "Limit = rows still needed"

**What is wrong.** 5.4 claims: "So a page that ends on the final row of the
final phase never leaves a phantom Load more" (adjudication R1-1 repeats it).
That holds when a filtered Query stops because its key range ran out, since no
LastEvaluatedKey comes back. It does not hold for an UNFILTERED final phase:
- Upcoming, Past or Date range with every status and type;
- Needs booking with every type;
- Any time when phase U is skipped.

Those Queries now ask for exactly the rows still needed. When the remaining rows
equal that Limit, DynamoDB stops AT the Limit and returns a LastEvaluatedKey
without looking further. The Query API reference documents that a non-empty
LastEvaluatedKey does not mean more data. 5.4's own second bullet then emits
`k` = that key, so Load more appears and returns an empty page with
`nextCursor: null`. 4.5 handles that page correctly, so the cost is cosmetic.
UNVERIFIED in DynamoDB Local specifically.

**What it implies.** Drop the guarantee, or peek one item ahead. Do not write a
test that asserts it.

---

## 4. [LOW] Gaps in the paging state machine: three loaders share one cursor, two buttons do the same thing, Retry can loop forever, and P15 blocks Ctrl/Cmd-click

- **Three loaders, one cursor.** Load more / Keep checking, the search walk and
  the return restore all advance the same cursor chain. Only "Load more hidden
  while a walk runs" is specified (4.5, 6). A search typed during a restore, or
  a restore that runs with a search (4.9's last bullet), runs two loops on one
  cursor. The result is duplicate requests and a race on `nextCursor`: rows are
  de-duplicated, but the read cost doubles. State that one loader runs at a
  time.
- **Two buttons.** In the capped follow state the last response carried a
  cursor, so Load more (4.5, second bullet) shows beside Keep checking, which
  is "the same request".
- **Retry that cannot succeed.** A 400 on a cursor-bearing request
  (`cursor_mismatch`, or `invalid cursor` - for example a tab left open across a
  deploy that changes U_ORDER or the fingerprint) is shown as a Load more
  failure. Its Retry resends the same cursor and fails forever (4.5, States).
  State that a cursor 400 restarts the list at page 1.
- **P15 is too broad.** "The All tab's click is prevented": a blanket
  preventDefault also stops Ctrl/Cmd-click from opening a new tab, because
  react-router's Link leaves a modified click to the browser only if the
  handler has not prevented it. Prevent only an unmodified primary click.

---

## 5. [LOW] The cost statements still do not match the read mechanism

- **Status does narrow server reads.** Section 6 says "only When narrows what
  the SERVER reads ... status and type narrow what is SENT". But the status set
  also decides which phase-U partitions are read, and it can skip phase D or U
  entirely (5.3: "for each U_ORDER status that is in the status set"; "Skips").
  So "A search under Any time therefore reads every tour once in phase D, and
  every toured, no-show, canceled and closed tour once more" is true only with
  every status selected.
- **The requested partition still over-reads.** 5.3 says the requested
  partition "wastes no reads". But phase U is "always" filtered (5.4), so the
  requested Query asks for QUERY_PAGE_LIMIT (200) even when a 50-row page needs
  5 more rows. The cursor resumes at the last returned row, so the next page
  re-reads the rest. That is the 4x over-read R1-8 removed for unfiltered pages,
  kept on the one dense filtered partition. The same applies to phase D whenever
  every dated status is pressed explicitly. Not a correctness bug. Either ask
  for the rows still needed on the requested partition (I1 plus P10 make the
  not-exists filter a no-op there) or drop the claim.

---

## 6. [LOW] The e2e only searches in the Any time step, so the other steps still depend on page depth

Adjudication R1-17 says the e2e "asserts through a search (which walks the whole
list), not page depth". Section 9 searches only in the Any time step:
- Needs booking defaults to earliest first (P3; createdAt ascending), so the
  spec's own new request is the LAST of every requested tour in the lane.
- Upcoming and Past + No show likewise depend on the spec's rows being among the
  first 50.

The lane holds other specs' tours (section 9). Search in every step, or reseed
in `beforeAll`.

---

## 7. [LOW] An undated toured, canceled or closed tour reads "Undated" on its All row and "Not booked" on its own page

3.7 now records that TourDetail prints "Not booked" for EVERY undated tour
(`TourDetail.tsx:312`). P7 prints "Undated" for every undated tour that is not
requested, and section 8's GLOSSARY entry lists only a requested tour's labels.
The divergence round 1 raised (A10) is now documented but not decided. Either
align TourDetail (a one-word change at `:312`) or record "Undated" versus "Not
booked" in the GLOSSARY.

---

## Contested adjudications

- **R1-2 (PATCH stamps `_schedPartition`) - CONCEDED.** Every production tour is
  written through the repo's create, which has stamped `_schedPartition` since
  its first commit (1acb89a4; `toursRepo.ts:355-364`). The Airtable import skips
  Tours on purpose (`airtableSource.ts:189-196`). PATCH's allowlist excludes the
  field (`tours.ts:146`), and no internal patch writes it. With P10's seed fix
  and pin, no reachable row lacks it.
- **R1-7 (PATCH refuses `no_show` without a date) - CONCEDED.** Only a direct
  API call can reach it (`TourDetail.tsx:319`), phase U now reads `no_show`, and
  the writer fix is filed (`docs/issues/tour-no-show-without-date.md`).

## Round-1 fixes checked and found correct

- **R1-1 (cursor).** I built every boundary I could reach and the four stop
  cases, the k-less "start of" form and the legal-combination table cover them
  all: D->U, U(i)->U(j), the D and U skips, status set {requested}, status set
  {scheduled}. The hash-value checks close the wrong-partition hole. The one
  exception is the phantom claim (finding 3).
- **R1-4 / R1-5 (date range).** Range with no bounds means the whole dated
  partition. The From/To conversion is pinned to `pastToursDateRange`
  (`useTours.ts:175-185`). `from`/`to` are accepted only under range and
  canonicalized on the server before any use.
- **R1-6.** `state.back` is built from local state at click time.
- **R1-8, R1-12, R1-13, R1-14, R1-15.** All present as adjudicated.
- **R1-17 (Today warning).** Removing the warning is safe: no test asserts it
  and no infra alarm keys on its text (grep of `app/test` and `infra` for "hit
  the cap" / "results truncated").
- **New issue file.** `tour-no-show-without-date.md` has valid frontmatter
  (`type: improvement` per `docs/issues/_TEMPLATE.md`).
- **Seed change.** Stamping the requested seed rows breaks no reader: nothing in
  `app/src`, `dashboard/src` or `e2e` relies on `_schedPartition` being absent.
  The only assertion of absence is the matrix coherence test the spec inverts
  (`seedMatrixCoherence.test.ts:415`).
