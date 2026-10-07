# Tour list (All tab) - adversarial design review, round 4 (final), reviewer A

Spec: `docs/superpowers/specs/2026-10-06-tour-list-design.md` DRAFT 4 (commit
5634409c), read whole, with the Round 3 adjudications. Repository read-only.
react-router behaviour is cited from the installed 7.18.0 build
(`node_modules/react-router/dist/development/chunk-4ZMWKKQ3.mjs`).

R3-4 (undoing round 2's tour-page wording change): NOT contested. The "Not
booked" vs "Undated" split already existed between the Past tab and the tour
page (`ToursPage.tsx:206` vs `TourDetail.tsx:312`). The All rows now follow the
Past tab, the GLOSSARY entry names which surfaces use which word, and the
alignment is filed (`docs/issues/undated-tour-wording.md`, frontmatter valid).
Keeping this branch to the All tab is defensible. Nothing earlier is reopened.

---

## 1. [MEDIUM] Changing a filter or the sort while a search is active leaves the search silently partial

**What is wrong.**
- On a filter change, 4.5 aborts whatever loader is running and loads the first
  page (`limit=50`). Section 6 likewise says the walk is aborted by any filter
  change.
- Section 6 lists exactly two walk triggers: "300 ms after typing stops, AND
  immediately whenever a non-empty search is adopted (mount, browser Back, the
  back arrow)".
- A filter change or a sort change is neither, so with a non-empty search the
  new list stops at page 1.
- Neither trigger covers the list after the cursor-400 restart either (4.5
  restarts at page 1).

**The count line has no wording for this state.** Its search copy is
"Searching... N matches so far" while a walk runs and "N matches" once complete
(6, via 4.5's "during a search the copy of section 6"). Neither describes "a
search is active, no walk is running, and the list is incomplete". A literal
build will most likely print "N matches" over a page-1-only search. That is the
silent truncation section 6 says the search must never present.

**Worked case.**
1. Search "Monique"; the walk finishes.
2. Switch When to Past.
3. Page 1 of Past (50 rows) loads and the search filters only those rows.
4. Every older match is missing, and the line reads as complete.

**Why the tests do not catch it.**
- Section 9's dashboard search tests cover only typing, adoption, clearing and
  the cap; there is no case for a filter change while searching.
- Section 9's e2e "searches in every step". If the search box keeps its text
  across the When changes, the e2e lane fits on one page and the test passes
  anyway.

**What it implies.** State one rule: whenever a new list starts while the search
is non-empty, the walk starts at once. That covers a filter change, a sort
change and the cursor-400 restart. Its copy and request cap apply as for
typing. Add a dashboard test that changes When during a search.

---

## 2. [LOW] The anchor's user-input guard needs an event definition, and the unmodified-click check needs react-router's exact rule

**The coordinator's question first.** The restore's own scroll and focus happen
only after the load ends, which is after the guard window. So by timing they do
not count. The guard text - "types, clicks or scrolls anywhere on the page
before the load ends" - still invites listeners that misfire:
- A `scroll` event cannot tell a user scroll from one the browser makes. The
  browser also scrolls when it clamps a scroll position after content shrinks,
  when overflow anchoring adjusts, and when something receives focus.
- `click`, `keyup` or `pointerup` can catch the tail of the very gesture that
  brought the user back - a mouse back button, or the release of Alt+Left -
  after the view has mounted.

Define the guard as user-intent events (`wheel`, `touchstart`, `pointerdown`,
`keydown`) registered when the view mounts. State that the restore's own scroll
and focus never trip it.

**The unmodified-click check.** 4.9 lists Ctrl/Cmd/Shift/middle. react-router
also treats Alt as a modifier: `isModifiedEvent` covers meta, alt, ctrl and
shift, and `shouldProcessLinkClick` also requires button 0 and a `_self` target
(`chunk-4ZMWKKQ3.mjs:7330-7337`). With the spec's list, an Alt-click writes a
record although react-router does not navigate. The handler should apply
exactly react-router's predicate.

---

## 3. [LOW] The one-loader rule misses two cursor consumers, and the second cursor 400 brings back a Retry that cannot succeed

**Two consumers the rule does not name.** 4.5 says "Four things advance the
list's cursor": Load more, Keep checking, the walk and the restore. Two more
also consume it: the first-page load after a filter change, and the automatic
empty-page follow.
- **Load more during the empty-page follow.** By 4.5's own rule, Load more
  appears while "the last response carried a nextCursor and no loader is
  running". During the follow the last response was an empty page with a
  cursor, and none of the four loaders is running, so Load more shows. A click
  then sends a second request on the same cursor.
- **A search typed while the first page is loading.** This case is unspecified.
  The Load-more case is now covered; this one is not.

**The second cursor 400.** After a second cursor 400, 4.5 shows "the Load more
failure message". 4.5 States says that message comes "beside a Retry", and that
Retry resends the rejected cursor. This is the dead end round 2 removed. Offer
"Start over" (page 1) there instead, or show no Retry.

---

## Draft-4 edits checked and found correct

- **History-state record.**
  - Only an unmodified click writes, and the pending-navigation skip wins. That
    skip cannot be tripped by the blur save that runs on the same click: the
    blur save is a REPLACE, which leaves `history.state.idx` unchanged
    (`chunk-4ZMWKKQ3.mjs:322-329`), so the row-open write still runs.
  - Every write replaces the whole history state, so a record cannot outlive
    the filters it was written under.
  - A reload keeps `history.state`, so it restores, as 4.9 now says.
- **Restore anchor.**
  - Counting positions over the visible rows is consistent with "still in the
    list".
  - A capped restore that stops short of `depth` moving nothing removes the
    misleading anchor at the last loaded row.
- **Restart and search typed during Load more.**
  - One automatic restart per list bounds the loop.
  - A search typed while Load more is in flight lets that request finish, then
    the walk continues from its cursor. This is consistent with the one-loader
    rule.
