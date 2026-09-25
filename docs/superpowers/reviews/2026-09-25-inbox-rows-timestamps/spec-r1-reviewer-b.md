# Spec R1 - adversarial review B

Spec: `docs/superpowers/specs/2026-09-25-inbox-rows-timestamps-design.md` (DRAFT 1)
Repo read at: `feat/inbox-rows-timestamps` @463a1f0e (base `main` @cd8e8ddd)
Reviewer: B (adversarial, read-only)
Date: 2026-09-25

Every claim about existing behavior below cites a `file:line` that was read.
Anything not verified is marked UNVERIFIED.

Current-behavior claims in spec section 2 that DO check out (no finding):
`PAGE_LIMIT = 30` (useInbox.ts:94); server default 25 / max 100 (inbox.ts:216-217);
both merge blocks gate on `startKey === undefined` (inbox.ts:2376, 2449); the
newest-50 group cap (inbox.ts:242, 2456); `setBase(pageData.rows)` on every
reconcile (useInbox.ts:239) and `firstPageGenRef` discard (useInbox.ts:339-342);
`<main className={styles.content}>` is the scroller at every width
(AppFrame.tsx:194, AppFrame.module.css:383-387); no media queries in either inbox
CSS module; failed reconcile -> `status: 'error'` (useInbox.ts:278); failed
`loadMore` is silent (useInbox.ts:350-359); `formatTime` / `formatDayDivider`
(contact/format.ts:22, 72). Sam's "37 = 30 + 7" is live-data only: UNVERIFIED.
Node 24's `toLocaleTimeString('en-US', ...)` emits a plain U+0020 before AM/PM
(checked with `node -e` on v24.14.1), so the `^\d{1,2}:\d{2} [AP]M$` regex is
not a U+202F trap.

---

## 1. [BLOCKING] The 5.6 merge rule does its arithmetic on the wrong quantity

**What is wrong.** 5.6 defines `R = min(max(L, limit), 100)` with
`L = base.length`, and splits the list into head and tail with `base.slice(R)`.
That treats `base` as a list of CONTACT rows in server paging order. It is not:

- Under `filter=all` the server's `limit` counts contact rows only
  (inbox.ts:2298-2303, "The page is `limit` CONTACT rows"). Page one then ADDS
  every open and connecting relay group and up to 50 group texts, which do not
  count against `limit` (inbox.ts:2361-2370, 2429-2436, 2456).
- Page one is then RE-SORTED, so relay and group rows are interleaved with
  contact rows by `lastActivityAt` (inbox.ts:2422-2424, 2481-2483). Index `R`
  in `base` is not a contact-row boundary.
- Under `filter=unread`, `limit` counts ALL rows, groups included
  (inbox.ts:1316-1319, 1556). No single formula is right for both filters.

**Worked example A (Sam, default limit 100, G = 7 group/relay rows, >100
contacts).** Page one is 107 rows. `L = 107`, `R = 100`, so `L > R`: case 2
runs on EVERY reconcile from the first page on. Section 8 says the stale-tail
case is "Only reachable past 100 loaded rows". That is false: it is Sam's normal
case. `P.length` (107) is not `< R` and `C` is non-null, so arm 2b runs:
`base := P ++ (base.slice(100) minus P)`, cursor unchanged. `base.slice(100)` is
the 7 OLDEST rows of the old sorted page one, a data-dependent mix of kinds.

- A new conversation pushes the 100th contact out of `P`. That row survives only
  if it sat at sorted index >= 100, meaning at least one group or relay row was
  newer than it. Otherwise it is in neither `P` nor the tail, and the unchanged
  cursor points past it. It silently leaves the inbox until something else
  replaces `base` wholesale.
- A row the server has STOPPED returning is kept forever if it sits at index
  >= 100. Examples: a relay group that closed (`listRelayGroups('open' |
  'connecting')` only, inbox.ts:2383-2385), a resurfaced soft-deleted contact
  after it is read (`deletedNoUnread`, inbox.ts:1181), a closed 1:1 thread.

**Worked example B (pure contact list: the Unknown tab, or All with no groups;
L = 200 after one auto-load).** A new inbound gives `P = [new, c1..c99]` and
`base.slice(100) = [c101..c200]`, so `c100` is lost for good. It is not in `P`,
not in the tail, and the cursor is past it. Each insertion at the head drops one
more row.

**The tuning knob does not tune.** With `?limit=30` (decision 8 and section 8
call it the no-deploy fallback "if 100 proves slow"), page one is 30 contacts
plus G groups. With G = 57, `L = 87`, so the first reconcile requests
`R = 87` contacts. After that `L = 144` and `R = 100`. The knob sets the size of
the first page only: every reconcile after the first event still reads up to
100 rows.

**What it implies.** The headline guarantee ("the list she has built by
scrolling survives a live update") rests on a split that does not match what the
server returns. The spec has to define the head/tail boundary in the server's
own paging unit for each filter. Two ways to do that: track which rows arrived
from head reads versus `loadMore` pages rather than using an index, or count
contact rows on All. It also needs a rule for rows that fall off the head
boundary, and `R` must not count additive group rows against a contact-row
limit. As written, the builder cannot implement 5.6 correctly.

## 2. [HIGH] Invariant 1 is not delivered for short heads: the merge can blank or truncate the list

**What is wrong.** Invariant 1 says "Any inbox-affecting event leaves every
loaded row on screen (modulo the dedupe in 5.6.2) and never resets scroll." The
mechanism breaks that in three places:

- **Case 1** (`L <= R`: `base := P`). A new head row pushes the old last row
  off the page. It disappears from screen, and only comes back through the cursor
  (auto-load). This is not the 5.6.2 dedupe, so the invariant as worded is false
  on every head insertion.
- **Arm 2a** assumes "`P.length < R` means the feed now ends inside the head".
  That is false for two accepted, documented server states:
  - Unread's budget exit mints a cursor with a SHORT page (inbox.ts:1661-1672).
  - Unknown's budget exit returns `{ rows: [], nextCursor }` or a short page
    with a cursor (inbox.ts:2284; inboxFilters.ts:26-29; spec section 2's own
    bullet).
- **The Unknown tab.** A single SSE event whose head read hits the scan budget
  replaces the operator's whole loaded list with ZERO rows ("Nothing on this page
  yet"), under both case 1 and arm 2a. On Unread a budget-short head throws away
  the loaded tail. Either way the list shrinks under the operator's scroll
  position, which then clamps.

**What it implies.** Either restate invariant 1 honestly, or specify that a head
read which is short but carries a cursor (non-null `C`) never shrinks `base`
below what is displayed. The e2e plan does not exercise any of these paths.

## 3. [HIGH] The auto-load observer's guarantees need opposite observer lifecycles

**What is wrong.** 5.2 claims "There is no tight retry: the observer fires on
intersection changes, not continuously". It also claims `loadMore` "is already
idempotent while `loadingMore` is true" and that the observer "adds no second
lock". Those claims hold only for ONE long-lived observer that always calls the
CURRENT `loadMore`. The spec never says so, and the two natural implementations
each break a different guarantee:

- **Observer re-created on dependency change** (the idiomatic effect keyed on
  `loadMore` / `hasMore`). `loadMore`'s identity changes whenever `cursor` or
  `loadingMore` changes (useInbox.ts:360). `IntersectionObserver` delivers an
  initial callback on `observe()`. So a FAILED `loadMore` flips `loadingMore`
  back to false, the observer is rebuilt, the initial callback sees the sentinel
  intersecting, and the load retries at once. That repeats for as long as the
  sentinel is in view and the error persists (a 400 from a cursor tag mismatch,
  a 500). That is exactly the tight loop 5.2 says cannot happen.
- **One stable observer** (the spec's stated model):
  - A successful page that leaves the sentinel inside the 400px margin produces
    no intersection change, so auto-load STALLS. That is the normal case for
    short Unread and Unknown pages and for the `?limit=2` seam that e2e test 2
    relies on ("the sentinel scroll appends rows until the list holds all of
    them" cannot complete).
  - The callback holds a stale `loadMore`. That closure's `loadingMore` and
    `cursor` are old (the guard at useInbox.ts:320 is closure state, not a ref).
    It can re-request a cursor whose page was already appended, and `rows` is not
    deduped (useInbox.ts:343). It can also abort the live request through
    `loadMoreAbortRef` (useInbox.ts:327).
- **The arming rule presumes re-firing.** An empty page with a cursor would not
  loop under a stable observer at all, so the rule only matters if the observer
  re-fires. The spec argues from both models at once.
- **Ownership is undefined.** It is not said where the observer and the `armed`
  flag live. `InboxState` gains only `refreshFailed` (5.7), yet 7.1 tests arming
  in `useInbox.test.tsx` through an "injected observer factory", and the hook
  owns no DOM (sentinel or scroll root). `armed` is not in the store snapshot, so
  a list restored from the store has undefined arming. For example, the Unknown
  tab could re-fire the cursor that just returned an empty budget page. It is
  also unstated whether a head read re-arms.

**What it implies.** Pick one lifecycle and make every guarantee hold under it.
Read `loadMore` / `loadingMore` through a ref if the observer is stable, or add
an explicit in-flight lock plus a failure backoff if it is re-created. Put
`armed` into the documented state and into the store.

## 4. [HIGH] "Retry refresh" blanks the list, and a failed retry strands the tab on a spinner

**What is wrong.** 7.1 wires the banner's button to `retry`. 5.7 says only that
"`retry()` runs a head read and clears it on success". Today `retry()` sets
`status: 'loading'` before it fetches (useInbox.ts:314-317), and nothing in the
spec changes that. Consequences:

1. Clicking "Retry refresh" replaces the rendered rows with the spinner
   (Inbox.tsx:206 and 243). That contradicts decision 7 ("never a blank error
   state over rows that were fine").
2. If that head read fails, `base.length > 0`, so 5.7 sets
   `refreshFailed = true` and "leaves `status` ... untouched", which is
   `'loading'`. The banner is gated on `status === 'ready'` (5.7) and the error
   surface on `status === 'error'` (Inbox.tsx:220). The operator gets a
   permanent spinner with no Retry: the "permanently stuck tab" that
   useInbox.ts:207-216 calls worse than the bug it was guarding.

5.7's own trigger conflates "rows are rendered" with `base.length > 0`, and the
two diverge in exactly this state. Test 5 covers only the retry that succeeds.

**What it implies.** The spec must say that a retry with rows present does not
enter `'loading'`, or that the failure arm restores `'ready'`. It needs a unit
test for a banner retry that fails.

## 5. [MEDIUM] 5.10 misdescribes where the dedupe and telemetry live; concurrency makes a double emit possible

**What is wrong.** 5.10 says the `emittedContacts` dedupe and the `dropped(...)`
telemetry are "applied SEQUENTIALLY" over the hydrated pairs, and that "the
sequential dedupe pass remains the defense in depth it is today". The code does
not look like that:

- The dedupe lives INSIDE `rowForConversation`: the check at inbox.ts:1150 runs
  before the awaited conversation-set read, and the add at inbox.ts:1189 runs
  after the row is built.
- `dropped()` is called inside the same function (inbox.ts:1071-1185).
- There is no sequential dedupe pass today.

"Cannot make a contact emit twice" is also not proven.
`contactConvsCache` is check-then-await-then-set (inbox.ts:842-865). Two
concurrent hydrations of two conversations belonging to one contact therefore
BOTH miss the cache and read the conversation set separately. The identity
guard compares each conversation against `newestOf` of ITS OWN read
(inbox.ts:1151-1168). The file itself documents stale participant-GSI images
naming a different newest thread (inbox.ts:1157-1160). Run sequentially, the
second read is a cache hit, so both evaluations see one consistent set. Run
concurrently, two differing reads can let both conversations pass, and
`emittedContacts.has` already ran before either add. Result: the same contact
twice on one page (duplicate React key `c:<id>`). The 5.10 equivalence test uses
static fixtures and cannot observe this race.

**Telemetry is not "untouched in meaning"** either:

- A duplicate that was `dupContact` sequentially becomes `notNewestConv` under
  concurrency, because the add has not happened yet.
- Hydrations past the page fill still bump `drops` and emit best-effort WARNs,
  and the sequential loop never reached them. The `inbox feed assembled` line
  (inbox.ts:2488-2509) changes for the same data.
- The comment "each contact/placement resolved at most once" (inbox.ts:771) stops
  being true: concurrent misses issue duplicate reads.

**Not bounded:** 5.10 never says whether hydration stops scheduling once the page
fills. Whole-chunk hydration on a later chunk (chunk size 100, inbox.ts:2303)
can do up to ~99 wasted hydrations (~300 reads) to fill the last few rows.

**What it implies.** Making the server change safe needs these edits inside
`rowForConversation`, which is more than "concurrency only":

- memoize promises, not values, in the caches;
- move the `emittedContacts` check and add into the sequential consumption pass;
- account for drops only for consumed conversations;
- stop scheduling once the page is full.

Otherwise the spec's own escape hatch applies and 5.10 should be dropped.

## 6. [MEDIUM] A passive-effect unmount reads the wrong `scrollTop`

**What is wrong.** 5.5 says "`scrollTop` is written on unmount from the scroll
container". The contact and conversation pages that replace the Inbox are
`height: 100%` with their own internally scrolling panes
(ui/twoPaneShell.module.css:11-16, 62-67). A `useEffect` cleanup runs AFTER the
route's DOM swap commits. By then `main.content`'s `scrollHeight` has collapsed,
so `scrollTop` reads as clamped, typically 0.

Only these capture the real value:

- a layout-effect cleanup, which runs before the deleted subtree's host nodes are
  removed;
- a scroll listener that records continuously.

**What it implies.** The spec must name the capture point. Written the natural
way (`useEffect(() => () => save(...))`), the restore silently goes to the top.
Test 3 is the only guard, and it is vacuous in the lean world (finding 10).

## 7. [MEDIUM] Save and load timing writes wrong snapshots, and the mount bypass is unspecified

**What is wrong.**

- **(a) Empty snapshots get saved.** The save effect "on every change to base /
  cursor / ..." also runs at mount, with `base = []` and `status: 'loading'`, and
  saves an EMPTY snapshot. StrictMode (main.tsx:15) runs the simulated-unmount
  save straight after mount. It is active in e2e because the harness serves the
  Vite dev server (dashboard/vite.config.ts:58-80). If the operator leaves before
  the first page lands, the return mounts that empty snapshot as
  `status: 'ready'`. It renders a false "No conversations yet" / "You're all
  caught up" until the reconcile lands.
- **(b) "The existing `activeFilterRef` and filter-effect resets apply before any
  save" is not how React effects work.** `setBase([])` inside the filter effect
  (useInbox.ts:300) does not change the `base` that a later effect in the SAME
  commit reads. The store key comes from `filter` and `limit`, so exhaustive-deps
  will put them in the save effect's deps. The commit that changes the filter
  then saves the OLD filter's rows under the NEW filter's key.
- **(c) The mount bypass is unspecified.** The filter effect (useInbox.ts:286-312)
  resets to `loading` and fetches unconditionally on mount. The spec never says
  how a mount from the store skips that. A "first run" ref, the obvious
  approach, fails under StrictMode's double effect run: the second run resets.

**What it implies.** Specify:

- save only from `status === 'ready'`, or restore only a ready snapshot;
- key the save to the filter the state actually belongs to, not the current prop;
- a StrictMode-safe mount bypass.

## 8. [MEDIUM] The store's row shape contradicts itself, and one reading reopens adversarial 4

**What is wrong.** 5.5's schema says `rows` are "the rows as DISPLAYED at save
time (patches applied)". Two paragraphs later it says "the store holds
`base`-shaped rows" with the Unread narrowing applied after load. The DISPLAYED
list is `rows`, which is narrowed AND sorted (useInbox.ts:533-534).

If the builder stores the displayed list, restoring an Unread list where the
operator cleared every row gives:

- `base = []`, so `serverRowCount = 0`;
- with a cursor, `emptyMoreCopy` ("This search stopped early to stay fast")
  instead of `emptyClearedCopy`;
- with `truncated`, `serverEndedEarlyEmpty`, which renders "We couldn't load
  your inbox." (Inbox.tsx:64-66, 79, 220).

Both are the defect the `serverRowCount` doctrine was introduced to fix
(useInbox.ts:67-81). A sorted store also changes what `base.slice(R)` means.

**What it implies.** State one shape: `patched` (base with pending folded in),
in server order, not narrowed.

## 9. [MEDIUM] Desktop "time at the far right" is not what the layout produces

**What is wrong.** Decision 3 and 5.4 put the `<time>` as the last child of the
link "at the far right". The `.actions` sibling, though, is always in layout: its
opacity is 0, but it keeps `flex: 0 0 auto` and `padding-right`
(InboxRow.module.css:140-148), and it sits to the right of the link
(InboxRow.tsx:122-150). So:

- The time sits left of an invisible button box.
- That box's width varies by row: "Mark read" on unread rows, "Mark unread" on
  read rows, nothing on deleted or closed rows.
- The times will not line up in a column, and unread-row times will be offset
  from read-row times.
- On a 360px phone the same dead box eats part of the two-line row.

**What it implies.** Decide where the actions go (for example, an overlay that
takes no layout width), or accept the misalignment in writing. The mockups
presumably show aligned times (UNVERIFIED, the mockup artifact was not read).

## 10. [MEDIUM] The Playwright plan is wrong about the lean world

**What is wrong.** The lean seed holds exactly ONE contact 1:1 (Tasha), one
`group_text` and one `connecting` relay group, all dated June 1
(app/src/lib/seed/lean.ts:224-280). `filter=all` page one merges the relay and
group rows on top of the contact rows.

- **Test 2:** "`/inbox?limit=2` ... two rows render" is false. With two fresh
  parties it renders 2 contacts + relay + group = 4 rows.
- **Test 3:** at the default limit of 100 the lean list does not overflow the
  container, so the `scrollTop` comparison is 0 == 0 and proves nothing. It needs
  a small `?limit` or seeded volume, plus an assertion that the container
  actually scrolled before the navigation.
- **Tests 1 and 3 depend on lane state the spec does not control:**
  - other specs send as Tasha (inbox-nav-badge.spec.ts:250-252);
  - group-text-conversion drives the connecting relay row to `group_text`
    (lean.ts:256-258);
  - sibling inbox specs reseed first (inbox-nav-badge.spec.ts:202-207,
    call-inbox-unread.spec.ts:110), and this spec does not.

  So "the lean seed's June row" may not be June.

**What it implies.** Reseed in `beforeEach` (then re-login), size page one with
the relay and group rows included, and make test 3 prove the container really
scrolled.

## 11. [MEDIUM] The perf:pages harness reads the inbox and asserts things this feature breaks

**What is wrong.** The spec's reader list omits `e2e/performance`. Its self-QA
requires, for every inbox sample in full mode:

- exactly one FINISHED required page request at evidence capture
  (e2e/performance/selfQa.ts:345-351);
- no inbox request carrying `cursor` (selfQa.ts:352-355).

Inbox readiness is "list or empty text visible" (e2e/performance/routes.ts:409-416).

- A mount from the store renders the terminal before any page request finishes,
  so the count is 0.
- Auto-load issues a `cursor` request whenever the first page has a cursor and
  does not push the sentinel out of the 400px margin, which is normal for Unread
  and Unknown budget pages.
- Warm inbox samples would measure a memory restore rather than a fetch.

UNVERIFIED: the exact capture timing relative to the mount reconcile.

**What it implies.** Enumerate the harness as a reader. Decide whether it
measures a store-restored inbox or disables the store and auto-load for
sampling, and adjust its invariants in the same change.

## 12. [LOW] The zero-margin seen-set invariant moves onto the live dashboard path

`docs/issues/seen-set-max-equals-max-inbox-limit.md` rests its "Nothing ships
broken" on the dashboard paging at 30. This spec has the dashboard request
`limit=100`, equal to `SEEN_SET_MAX` (inbox.ts:259, strict comparison at 1655),
on the Unread tab with zero margin, and never mentions the issue. At minimum,
update the issue's reachability paragraph and land the pinning boundary test it
proposes.

## 13. [LOW] The spec is not standalone about its exclusion list

4.2 forbids touching "any file on the mission's exclusion list (three live
branches own the outbound-texting path)" but does not list the files. A builder
who has never seen the conversation cannot honor it. (Read-only check: none of
the three live worktrees' branch diffs touch any inbox file today.)

## 14. [LOW] `limit` parsing is stated two ways

Decision 8 says the parameter is "clamped 1..100". 5.1 says `0`, `-5`, `abc` and
`1000` "fall back" to 100. For `0` and `-5`, clamping gives 1 and fallback gives
100. The server falls back below the range and clamps above it
(inbox.ts:2597-2602). Pick one.

Also, the groups truncation link hard-codes `/inbox?filter=groups`
(Inbox.tsx:146), so a tuned `limit` is dropped there despite 5.1's promise that
"a tuned link keeps its size across tabs".

## 15. [LOW] Factual slips

- "The shell's own breakpoint is 860px (`twoPaneShell`)". The AppFrame shell
  breakpoint is 768px (app/useNavChrome.ts:16, AppFrame.module.css:603); 860px
  belongs to the contact and conversation detail layout.
- 5.8 says "the same window exists today for a fresh mount". Today a fresh mount
  shows a spinner, not a stale count, so the stale-count window is new.
- `savedAt` is stored, but no rule reads it (no TTL, no staleness rule). Either
  it is dead state or a staleness rule is missing.

## 16. [LOW] Decision 7 has two holes the spec keeps

- The 404 "pending" arm is kept "unchanged", but it still empties a rendered list
  (useInbox.ts:266-276 sets `base` to `[]` and `status: 'pending'`). A proxy or
  CDN 404 during a deploy turns a healthy list into "The inbox turns on with its
  backend", which is the blank-over-good-rows outcome decision 7 forbids.
- `refreshFailed` is never reset on a filter change. That opens the same
  one-commit stale window that Inbox.tsx:188-196 already defends against for
  `truncated`.

## 17. [LOW] One unit-test boundary case depends on the time zone

7.1's "an instant in a different UTC day but the same local day" cannot be built
when the runner's TZ is UTC. Nothing pins TZ: no TZ in dashboard/vite.config.ts,
no TZ in the setup file, and no pin in dashboard/package.json. Pin TZ for
`inboxTime.test.ts` or build the case from an explicit offset.

## 18. [LOW] Bigger head reads starve paging past the head

Every committed head read still bumps `firstPageGenRef` and discards an in-flight
`loadMore` (5.6 step 4; useInbox.ts:238, 339-342). That happens even in arm 2b,
where the cursor is unchanged. A 100-row head takes longer than today's 30-row
one, so a busy SSE stream can keep discarding the page the operator (or
auto-load) asked for. The spec should at least state this as an accepted
trade-off.
