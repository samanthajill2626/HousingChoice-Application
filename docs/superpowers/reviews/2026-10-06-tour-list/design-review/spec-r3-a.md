# Tour list (All tab) - adversarial design review, round 3, reviewer A

Spec: `docs/superpowers/specs/2026-10-06-tour-list-design.md` DRAFT 3 (commit
7a8ac2f3), read with the Round 2 adjudications. Repository read-only;
citations are to code read at 7a8ac2f3, including the installed react-router
(7.18.0, `node_modules/react-router/dist/development/chunk-4ZMWKKQ3.mjs`).
UNVERIFIED marks what I could not check.

## The coordinator's history-state questions, answered first

- **Does the record survive react-router's state semantics? Yes.** The
  dashboard mounts a declarative `<BrowserRouter>` (`dashboard/src/main.tsx:15-19`),
  not a data router. Its history writes `{ usr: state, key, idx }` with
  `pushState` / `replaceState` synchronously inside `navigate`
  (`chunk-4ZMWKKQ3.mjs:303-333`). So a stamped REPLACE followed at once by the
  row Link's PUSH leaves the list entry holding the record, and a POP reads it
  back as `location.state`. The tour page's only in-page REPLACE keeps its state
  (`TourDetail.tsx:289-293`). The back arrow is a PUSH that carries the record
  in its own state.
- **WebKit replaceState budget: no issue.** The always-on write adds one
  `replaceState` per row open. Even a burst of Ctrl-clicks stays far under 100
  per 10 s.
- **Own-write stamp and adoption: no collision.** The row-open write is stamped,
  so it is never adopted (`ListingsList.tsx:214-218`), and the PUSH unmounts the
  view anyway.
- **What remains:** the pending-navigation skip, modified clicks, and the
  drop-on-other-writes dependency. All three are finding 2.

---

## 1. [MEDIUM] The anchor's scroll and focus fire when a long load ends, even if the user is already typing or scrolling

**What is wrong.** 4.9 ends a restore by scrolling to the anchor row and moving
focus to its link. "With a search, the walk of section 6 loads the whole
filtered list instead, and the same anchor rule applies when it ends." 4.5 adds:
"Typing a search while a restore runs aborts the restore and the walk continues
from the cursor it reached." Two consequences:
- A return with a search runs a walk of up to 50 requests (6). That is seconds
  at scale, and the anchor fires only at the end.
- In the takeover case, the trigger for the walk is the user's own typing.

Nothing says the anchor is dropped once the user has interacted. So focus can
jump from the search box to an old row's link mid-word. The following
keystrokes are lost, and Enter opens that tour.

**What it implies.** The restore should anchor only if the user has not typed,
clicked or scrolled since arrival. A restore that user input aborts never moves
scroll or focus. Section 9 needs a test that types during a slow walk.

---

## 2. [LOW] The always-on row-open write: the pending-navigation conflict is unresolved, modified clicks write a record, and the design silently depends on other writes dropping the record

- **Two rules contradict.** 4.7 keeps "writes are skipped while a navigation is
  pending" and adds "opening a row always writes"; 4.9 repeats "ALWAYS".
  - If ALWAYS bypasses the skip, a row clicked while a Back or tab switch is
    still pending REPLACEs the entry that navigation already landed on. That is
    the overwrite #1 exists to prevent (`ListingsList.tsx:250-256`).
  - If the skip wins, that entry gets no record: browser Back restores nothing
    there, while the back arrow (router state) still does.
  - Say which rule wins. It should be the skip.
- **Modified clicks write a record for a row the tab never left.** react-router
  runs the Link's own `onClick` before it decides a click is modified
  (`chunk-4ZMWKKQ3.mjs:10552-10556`, `7333-7336`). So a Ctrl/Cmd/Shift-click on a
  row still makes the stamped REPLACE, writing a record although the tab stays
  on the list. A later reload or POP of that entry restores toward a row opened
  in another tab. Write the record only for an unmodified primary click.
- **An unstated dependency.** The record no longer carries a filter key (draft
  2's memory did). It is safe only because every other stamped write - control
  changes and the blur save - replaces the whole state with the stamp, as #1's
  `persist` does with `state: OWN_WRITE` (`ListingsList.tsx:257-260`). A builder
  who "keeps the record alive" with `{ ...location.state, stamp }` would replay
  an old depth and anchor on new filters. 4.9 should say that every other write
  drops `restore`. A reload of an entry that holds a record also restores; that
  arrival is not in 4.9's list.

---

## 3. [LOW] The anchor's terms are undefined under a search and at the restore cap

- **Which list does `openedIndex` count?** Under a search the user sees only the
  matches, but the list LOADED is the whole filtered list. If `openedIndex` (and
  "still in the list") counts loaded rows, the fallback can land on a row the
  search hides, which cannot be focused. Define both over the VISIBLE rows.
- **Not loaded is not the same as gone.** The restore stops after 10 requests
  and "keeps what it has" (4.9). The opened row may then simply not be loaded
  yet. The rule treats that as "left the list" and focuses the row at
  `openedIndex`, clamped to the LAST loaded row. That is presented as "the next
  one to work on" while the opened row still exists further down. After a capped
  restore, anchor nothing (or anchor only if `openedIndex` was reached) and leave
  Load more to continue.

---

## 4. [LOW] The new "Undated" rule misses three tour lists

**What is wrong.** Section 8 and the GLOSSARY now state the rule: "Not booked"
for a requested tour, "Undated" for any other undated tour. P7 changes the tour
page (`TourDetail.tsx:312`; the Schedule card's When row uses the same string,
`:783`). Three other tour lists still print "Not booked" for EVERY undated tour:
- the tenant file, `TenantFile.tsx:334-337`;
- the landlord file, `LandlordFile.tsx:214-217`;
- the property page, `ListingDetail.tsx:1082-1084`.

**What it implies.** An undated toured tour now reads "Undated" on its own page
and "Not booked" in its tenant's file. The drift moved instead of closing, and
the GLOSSARY entry would be false for three surfaces. Either apply the rule
there too (three one-line changes; `files.test.tsx:266-278, 458-470` and
`ListingDetail.test.tsx:432-433` cover requested tours only and stay valid), or
scope the GLOSSARY entry to the surfaces that follow it.

---

## 5. [LOW] The cursor-400 restart can loop, and "one loader at a time" does not cover a search typed during Load more

- **The restart can loop.** 4.5 restarts the list at page 1 on a cursor 400.
  Section 6 says that whenever a search is active and the list is incomplete
  "the hook then loads the REST". So after a restart with a search active, the
  walk resumes. A persistent cursor rejection - for example a fingerprint or
  validation defect shipped in a deploy - then becomes an automatic loop: page
  1, walk, 400, restart, page 1, and so on. Allow one automatic restart per list;
  a second cursor 400 shows the error and stops the walk or restore.
- **Typing during Load more is unspecified.** The rule names only a search typed
  during a restore. It does not say whether a search typed while Load more or
  Keep checking (or its empty-page follow) runs waits for that request or aborts
  it.

---

## Verified correct (round-2 fixes)

- **Peek row.** With `Limit = rows still needed + 1`, a final unfiltered phase
  ending exactly on `limit` rows returns no LastEvaluatedKey (its range ends
  before the Limit), so `nextCursor: null`. When more rows remain, the peek
  proves it. The narrowed phantom statement in 5.4 is accurate.
- **Phase-D normalization and the requested partition.** Omitting the status
  filter when every dated status is selected can exclude nothing under I1.
  Dropping the not-exists filter on `requested` leaves the I1 violation case to
  client de-duplication, as stated.
- **P15.** The carve-out matches react-router's rule: modified and non-primary
  clicks are left to the browser (`chunk-4ZMWKKQ3.mjs:7333-7336`); middle-click
  fires `auxclick` rather than `click`.
- **History-state record.** It survives as described (see the answers above),
  and per-entry state removes draft 2's test-seam and POP-scope problems.
- **e2e.** Searching in every step removes the page-depth dependence.
- **Prior concessions.** Nothing new to contest on R1-2 or R1-7.
