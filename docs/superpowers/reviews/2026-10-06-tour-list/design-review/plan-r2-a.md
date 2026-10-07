# Plan review r2 (reviewer A) - tour list implementation plan v2

Adversarial re-review of `docs/superpowers/plans/2026-10-06-tour-list.md`
(PLAN v2) and the spec amendments (4.9, P5, 9), worktree `W:\tmp\tour-list` at
HEAD 9650d386. Inputs also read: the "Plan round 1" adjudications (P1-P18) and
reviewer B's round-1 report (`plan-r1-b.md`). Read-only: no suite, server,
DynamoDB or Docker was run. "plan:N" / "spec:N" are line numbers in those two
files at 9650d386.

Order of this report: new problems first. Findings 1 and 2 were created by the
round-1 fixes themselves. Finding 3 is a fix that does not achieve its stated
goal. Findings 4 and 5 are leftovers. Finding 6 is the one adjudication I
contest.

Checked and sound (no finding): the `listGen` render-time list identity (A ->
B -> A gets a fresh list; the transient render with the old `n` is discarded
before any effect runs; `startOver` needs no ref resets); `restoreShort` /
`autoMode` / the `loadMore` guard (every user path - Load more, Keep checking,
Retry after `moreFailed` - reaches `loadMore` with `autoMode === null`, so the
guard blocks only stray calls); the capped restore staying silent (no follow
while `rows < depth`); the restart ending the restore via `!refreshed`; the
list-bound restore record and its five writers (initializer, adoption,
`change()`, a writing blur save, Start over); `change()` syncing `walkQ` and
the empty-box belt; the pruned Clear checks; `scannedCount` through repo, fake,
engine and route (`QueryCommandOutput.ScannedCount`; the fake's
`evaluated.length` equals it, including 0 past the end); the restated engine
case 9 (traced: 5 empty U calls -> null with a budget of 10, `{ ph: 'u', i: 3 }`
with 3); the perf route-pin exclusion moving into Task 10.1; and the e2e
fixture rules (per-test tours, `closeOut` skipping canceled tours, row
assertions limited to the test's own ids, at most 12 tours against a
30-iteration cap). The `exhaustive-deps` "ref in cleanup" warning does not
fire for `searchTimer` or `moreAbort`, because both are assigned elsewhere in
their component (eslint-plugin-react-hooks cjs development.js:396-413).

---

## 1. [MEDIUM] Since P14, route test 3 can no longer catch a page 2 that ignores the cursor's pinned instant

**What is wrong.** Route test 3 is the only check of spec P4/5.5. Page 1 of
`when=upcoming&limit=1` is read at `clock`. The test then advances `clock`
"past that tour" (past the FIRST row only) and reads page 2 with the cursor,
expecting "no 400, no skipped row" (plan:1303-1307). It runs on the harness
fake, `queryListPhaseFromItems`.

The v2 fake now resumes by key position: it starts at the first member strictly
after the start key's `(rangeKey, tourId)` (plan:1018-1027). Under v1 it looked
the start key's row up by `tourId`. Take a broken route that rebuilds page 2's
`gte` range from the NEW clock instead of `cursor.n`:
- The first row T1 is no longer a member of that range.
- Key-position resume after T1's key still lands on T2, the first member above
  it.
- So page 2 is T2 under both the correct route and the broken one, and the test
  passes either way.

Under v1's fake, the broken route resumed at the end, returned an empty page,
and was caught.

Real DynamoDB does not resume here. A Query whose `ExclusiveStartKey` lies
outside the KeyConditionExpression range fails with a ValidationException: "The
provided starting key is outside query boundaries based on provided
conditions". Spec 5.5 already relies on that: "an Upcoming list read again
hours later would start from a key the new `>= now` condition excludes"
(spec:612-615). The fake's header now claims key-position fidelity "whether or
not that key's row still exists or still sits there" (plan:970-972), but it
never models that rejection. The mirror test can't expose the gap either: it
resumes only `D all`, a status-filtered D and a U phase (plan:935-946), never a
range-bounded D phase (gte / lt / lte / between). So nothing pins the fake to
DynamoDB where they differ.

**Evidence.** plan:1018-1027, 970-972, 935-946, 1303-1307; plan:1393-1406 (the
GREEN route does use `cursor.n` - this is about the guard, not the code);
spec:612-615. The DynamoDB message is documented behavior; I did not observe it
here (no DynamoDB run).

**What it implies.** The regression guard for the pinned instant was made void
in the round that rewrote the fake. In production, that regression would show
up as a cursor-400 restart ("The list was refreshed.") on every Upcoming list
paged after a listed tour's start time. Fix (either part works; both is best):
- Model the rejection in the fake: throw the same `ValidationException`-named
  error when a D phase's start key falls outside `phase.range`. Add a
  range-bounded resume from a key below a `gte` bound to the mirror test, so
  DynamoDB Local pins it.
- And/or advance the test's clock past the SECOND row, so a new-clock read
  visibly skips it.

The rejection-modelling option also lets the route's "ValidationException with
a cursor -> 400" mapping run end to end in the harness, not only through
route test 9's injected throw.

## 2. [LOW] Two new RED cases cannot fail as written

**What is wrong.**
- Task 12.2 case 8: a filter change made "within 300 ms of the last keystroke"
  walks the new list "at once" (plan:2679-2681). It is meant to pin `change()`'s
  immediate `setWalkQ(next.q)` (P2 / B-F12). With the real timers and `waitFor`
  that S12 uses for search cases (plan:2591-2593), a `change()` that did NOT sync
  `walkQ` still passes: the debounce timer armed by the keystroke fires inside
  `waitFor`'s default window and starts the same walk. Only fake timers, never
  advanced to 300 ms, make the RED red.
- Task 12.4 case 7 adds "the same after ... a blur save that writes"
  (plan:2888-2892), but the case first waits "for the restore to finish". A blur
  save does not change the list key, so no restore request could follow it
  whether or not `setRestore(null)` runs. To mean anything it must run
  MID-restore, with a `limit: 100` restore page still pending, and assert that
  page is the last `limit: 100` request.
- (Not a defect, noted so nobody counts it as coverage.) Task 12.2 case 7's
  timer clause ("a keystroke followed by Clear filters within 300 ms never walks
  afterwards") cannot fail either. The empty-box belt (plan:2778-2781) blocks the
  walk even if `change()` forgets to clear the timer.

**Evidence.** As cited.

**What it implies.** The B-F12 timing fix and the blur-save drop are effectively
untested. Specify fake timers for 12.2-8 and a mid-restore blur for 12.4-7.

## 3. [LOW] P5's "a failed first page stays 'pending'" cannot deliver the anchor it protects

**What is wrong.** v2 keeps `restoreOutcome` 'pending' while
`state.status === 'error'` (plan:2461-2470; hook case 9, plan:2140-2142). The
adjudication's reason is that 'reached' "would have spent the once-per-record
anchor on nothing" (adjudications P5).

But the only way out of a failed first page is the Retry control
(plan:2647-2649). Clicking it, or pressing Enter on it, dispatches `pointerdown`
or `keydown` to the document, which trips the user-intent guard
(`userActed.current = true`, plan:2909-2919). So when the reload lands, the
anchor effect claims the record and returns at `if (userActed.current)`
(plan:2928-2929). The end state is identical to v1's: no anchor in either
design.

**Evidence.** As cited; spec:466-470 ("Acts" = pointerdown, keydown, wheel,
touchstart, listened for from the view's mount).

**What it implies.** The fix is plausible, not effective, and no view-level test
would show it: the plan has hook case 9 only. Decide whether pressing Retry
counts as "the user acted":
- If not, exempt the Retry control from the guard (or reset `userActed` when
  Retry starts the reload) and add a view case: failed first page -> Retry ->
  the opened row gets focus.
- If yes, drop the 'pending' special case and its rationale.

## 4. [LOW] Round-1 fixes left stale or wrong references

**What is wrong.**
- The constraints table still says `restore cap | 10 requests` (plan:76). The
  amended rule is the usual 50-row first page plus up to 10 restore pages of 100
  (plan:2082-2086; spec:452-456). A builder reading the table first can implement
  a 10-request total, which contradicts hook case 9 ("the first page + exactly 10
  restore requests", plan:2135).
- Task 13.1 still cites `tours-past.spec.ts:281-284` for the on-the-wire
  `scheduledAt` check (plan:3004-3006). That range is the Record-outcome deep-link
  assertion; the wire check is at `tours-past.spec.ts:259-262`. P12 corrected the
  other citations but not this one.

**Evidence.** As cited.

**What it implies.** Small, but the table is labelled "verbatim from the spec"
and is the first thing a builder reads.

## 5. [LOW] The view's loading state is still unspecified (B-F13-2, partly unaddressed)

**What is wrong.** Task 12.1's GREEN now gives exact count-line rules and a
first-match action area (plan:2628-2649). It says nothing about
`status === 'loading'`, which covers:
- the first page;
- every filter change (the hook derives 'loading' with empty rows,
  plan:2458-2459);
- the cursor-400 restart's page 1;
- Start over.

`Spinner` is imported (plan:2611) but never placed. Read literally, the count
line during a load renders `Showing 0 tours` (rows [], `complete` false). The
refreshed notice, which the hook deliberately keeps true "while that page
loads" (hook case 10, plan:2145-2146), may render beside it or not at all.

**Evidence.** As cited; plan-r1-b.md F13 bullet 2.

**What it implies.** Specify the loading render (spinner in the list area; the
count line hidden, or kept with only the notice) so the builder does not invent
it.

## Round-1 closure check (not a finding)

All 15 of my round-1 findings are closed in v2 except two:
- the `tours-past.spec.ts` citation (finding 4 above);
- the fake fix (P14), which closed my finding 14 but opened finding 1 above.

Reviewer B's findings, which I had not seen in round 1, are all reflected (P1-P18).

## 6. [LOW] Contest of P9: the refreshed notice inside the count-line live region is re-announced with every later count update

**What is wrong.** v2 renders " The list was refreshed." as a second span inside
the ONE `role="status"` count line "until the list changes" (plan:2637-2640;
hook `refreshed` "true until the list changes", plan:2227-2229). `role="status"`
is a live region with implicit `aria-atomic="true"`. Every later content change
re-announces the whole region: each Load more, each search-walk page
("Searching... N matches so far"), each follow page. So a screen reader repeats
"The list was refreshed." for the rest of that list's life, long after the
event.

Spec 4.5 says only that "the count line says" it (spec:387-388), not how long.
My round-1 suggestion was "until the next page lands", and I defend it on this
ground: keep the notice in the same region, but clear it once the restarted
list's next page commits (or render it only while the restarted page-1 count is
current).

**Evidence.** As cited.

**What it implies.** A small, real accessibility regression, created by
choosing the longest duration. Everything else in P9 (the `listKey#gen` list
identity, one region, Start over as a new list) I concede.

Conceded in one line each: P5's 50-row first page and "the restart ends the
restore" (rare, and consistent with spec 4.5's "the refreshed list starts at
page 1"); P1's list binding in place of clearing the record after the anchor
runs (equivalent once traced); P2's belt.
