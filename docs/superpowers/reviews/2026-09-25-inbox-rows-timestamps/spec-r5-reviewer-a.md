# Spec R5 re-review of the Option B removal (reviewer A)

Spec: `docs/superpowers/specs/2026-09-25-inbox-rows-timestamps-design.md` (DRAFT 7 @05d94cc5)
Also read: `docs/issues/inbox-loaded-pages-survive-refresh.md`; DRAFT 5
(@b53a9e8a) and DRAFT 6 (@35843a25) via `git show`, for the issue check.
Scope: what the removal left dangling, guarantees the simpler mechanism no
longer delivers, and whether the issue file is a fair record. Read-only.

**Honest read: precision only.** No finding changes Option B or any
mechanism. Finding 1 is HIGH because two e2e cases assert the opposite of what
the mechanism does, so a correct build fails them. The likely wrong
"fix" is to suppress auto-load.

---

## 1. [HIGH] [PRECISION] Tests 2 and 3 assert that auto-load does NOT fire after the page-one refresh; the mechanism guarantees it does

**What is wrong.** In both Option B cases the operator is at the bottom of a
fully loaded list at `?limit=2` when the complete head read lands:

- Test 2: she scrolled to the bottom to load everything, then an inbound
  arrives.
- Test 3, part 2: she opened the last row and came back with POP, so the
  restore puts her at the bottom.

Branch C then commits `head := P; tail := []; cursor := C;
autoLoadArmed := P.length > 0` and bumps `pageEpoch` (5.2, 5.6). Page one at
`limit=2` is four rows, so the list now fits the viewport and the scroll
clamps. `hasMore` is true again, so the sentinel mounts and its new observer
reports intersecting: `intersecting` was reset to false on unmount (5.2), so
this is a false-to-true transition. The effect fires `loadMore`. At `limit=2`
every page is short in pixels, and test 2 itself says the epoch rule "chains to
the end here BY DESIGN", so the list grows back to every row and Load more
disappears again.

5.8's own "WHAT THE RETURN SHOWS" says exactly this: "the sentinel is in view,
so auto-load fetches the next page once". Yet:

- test 2 asserts "Load more is visible again; exactly one finished head read
  and no cursor request followed the inbound";
- test 3 asserts "after the head read settles the list is page one with Load
  more visible again".

Neither holds, except transiently.

**Consequence.** A correct build fails both cases. The fix that makes them
pass (suppressing auto-load after a head read) would contradict 5.8 and
invariant 2.

**Fix.** Pin the trade where auto-load cannot re-fetch. Scroll to the top
before the inbound or before opening the row. Use a limit and viewport where
page one is taller than the viewport plus the 400px margin; test 6's
`?limit=12` at 1280x400 is one. Then assert page one and a visible Load more.
Keep a separate at-the-bottom case that asserts what 5.8 promises: one head
read, then cursor reads, and the list converges.

## 2. [MEDIUM] [PRECISION] The Outcome and section 2 now overclaim what a live update wipes today

**What is wrong.** DRAFT 7 narrowed the Outcome to "The first page of the list
(100 rows) and her place in it survive two things that wipe them today: a live
update ... and the browser's back button". It added to section 2 that the SSE
reconcile, "because the page re-renders from `loading`, loses the scroll
position". That new sentence is false.

- The SSE path is `scheduleRefetch -> fetchFirstPage`
  (`dashboard/src/routes/inbox/useInbox.ts:366-372`). It never applies
  `'loading'`: it installs the page and applies `'ready'` (`:199-243`).
  `'loading'` is set only by the filter effect (`:299`) and `retry()`
  (`:315`).
- The `<ul>` stays mounted under `status === 'ready'`
  (`dashboard/src/routes/inbox/Inbox.tsx:243`).

So today a live update already keeps page one current and keeps her place in
it. It only clamps when the new page is shorter than her position, and Chromium
scroll anchoring holds her view when a row is inserted above it. DRAFT 7 keeps
the first two. It deliberately gives up the anchoring: `overflow-anchor: none`
on the page root means "an inserted row shifts the operator's reading position
by one row height" (5.2, section 8).

The genuine live-update gains are the larger page one, a failed refresh no
longer blanking the list (5.7), and an incomplete refresh no longer shrinking it
(branch I). The Back restore is the real new behavior. The title's "a list that
stays put" inherits the overclaim.

**Fix.** Restate the Outcome's live-update half as those deltas. Delete the
section 2 clause.

## 3. [MEDIUM] [PRECISION] The issue file points at the wrong draft and overstates the review

`docs/issues/inbox-loaded-pages-survive-refresh.md` has three problems:

- It says the design "survived four adversarial review rounds as DRAFT 5 of
  the spec (commit `b53a9e8a`...)".
- Its suggested fix is "Build DRAFT 5 sections 5.5, 5.6 (branch P) and 5.8 (the
  re-walk) as reviewed".
- The spec's Outcome and decision 6 point at DRAFT 5 @b53a9e8a as well.

DRAFT 5 was the SUBJECT of round 4, which found precision defects in exactly
that re-walk:

- the fold's range bounded by the first page's newest row, so gone rows at the
  top of the tail survive;
- the shared `loadingMore` hold that a discarded page clears mid-walk;
- the ambiguous `start` cursor.

Those were fixed in DRAFT 6 @35843a25, which has `rewalking` and "the
triggering head read's OWN page cursor `C`" and bounds the range by the
triggering head's boundary. DRAFT 5 still has `freshNewest`. The issue's own
bullet ("bounded by the triggering head's boundary") describes DRAFT 6 while
its pointer names DRAFT 5, so "build as reviewed" would rebuild the round-4
defects. Also, DRAFT 6's fixes were never adversarially reviewed: round 4
closed on them as precision edits.

**Fix.** Point at DRAFT 6 @35843a25 in the issue, the Outcome and decision 6.
Say "reviewed through round 4 (DRAFT 5); round 4's precision fixes are in
DRAFT 6 and were not re-reviewed". Cite `spec-r4-reviewer-a.md` with the other
records. The rest of the issue is a fair record: the problem statement, the
three-part mechanism summary, the residue, and the reopen triggers all match
what was reviewed.

## 4. [LOW] [PRECISION] A restored `autoLoadArmed` fires a cursor request that the restore's own head read then discards

5.2 and 5.8 restore `autoLoadArmed` with the snapshot. Say she returns (POP) to
a position at the bottom of a list that is not fully loaded, with `hasMore`
true. The sentinel reports intersecting at mount, before the mount reconcile
lands, and auto-load fires a `loadMore` from the restored cursor. Branch C then
replaces the list and cursor, so that page is either discarded
(`firstPageGenRef`) or appended and then dropped. That is one wasted `limit`-row
read per such return. It contradicts invariant 2 ("no cursor request unless the
sentinel is in view after the reconcile"). Under Option B the restored arm has
no remaining use: every chain is replaced by the first complete head read. So
restore with `autoLoadArmed: false` and let the restore's head read arm it.

## 5. [LOW] [PRECISION] "A busy SSE stream ... does not starve it" is a tail-model leftover

Section 8, bullet 3 was written when a head read only discarded an in-flight
page. Under Option B every complete head read drops pages two and beyond. While
events are arriving, depth past page two is reachable only by scrolling a full
page between events: each event resets the list to page one, and auto-load
re-fetches only page two. Restate it: paging resumes after each event; depth
does not accumulate across events.

## 6. [LOW] [PRECISION] The `ListState.head` comment is inexact after branch I

5.5: "head: the server's page one as of the last complete head read". Branch I
sets `head := P ++ old head rows not in P`, so after an incomplete read `head`
holds rows from more than one read. Say "page one as of the last head read,
plus rows an incomplete read could not rule out".

---

## Dangling-reference sweep (no finding)

- No live reference remains to the re-walk, `rewalking`, `tailPages`, the
  boundary rule, `keepAdditive`/`hasKind`, branch P or branch R. The matches
  are only in 4.2's out-of-scope bullet and the deferred-issue pointers.
- Invariants are renumbered consistently: 5.5 and 5.6 cite invariant 8 (no
  conversation twice), which is section 6's 8.
- `loadMore`'s rowKey and conversation dedupe keeps a valid reason under Option
  B: branch I keeps the old cursor, so the Unread seen-set gap still exists.
  `dedupeConversations` in branch C is correctly a no-op: one server page cannot
  carry both kinds for one conversation.
- The removal leaves correct: 5.7 (Retry with rows, the banner, branch I never
  a failure), 5.8's save gating, `aliveRef`, `pendingRef`, the POP/PUSH scroll
  rule with the explicit 0, and test 3 part 1 at `?limit=10` (seven contacts,
  `C === null`, no sentinel, no cursor request).
