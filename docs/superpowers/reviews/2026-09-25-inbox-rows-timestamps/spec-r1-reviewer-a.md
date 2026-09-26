# Spec R1 adversarial review (reviewer A) - inbox rows + timestamps

Spec: `docs/superpowers/specs/2026-09-25-inbox-rows-timestamps-design.md` (DRAFT 1)
Repo read at: worktree `W:\tmp\inbox-rows-timestamps`, HEAD 463a1f0e (base cd8e8ddd)
Reviewer posture: adversarial, read-only. Every claim about current behavior
cites a file:line that was read. Anything not verified is marked UNVERIFIED.

Severity is by consequence if the spec ships unfixed.

---

## 1. [BLOCKING] Merge rule 2 (5.6.2) permanently loses rows, and it fires on page one of the All tab, not only "past 100 loaded rows"

**What is wrong.** Two independent defects in the same rule.

(a) Unit mismatch. `R` is sized from `L = base.length` (5.6), but on
`filter=all` the server's `limit` counts CONTACT rows only, while `base` holds
contact rows PLUS every open/connecting relay row PLUS up to 50 group rows
merged additively onto page one (`app/src/routes/inbox.ts:2376-2427`,
`:2449-2486`; spec section 2 says so itself). With the default limit of 100,
page one of All is `100 + k` rows whenever any relay or group row exists, so
`L = 100 + k > R = min(max(L, 100), 100) = 100` on the FIRST reconcile after
mount, with no scrolling at all. Section 8's "Only reachable past 100 loaded
rows" and 5.6.1's "the common case" are false for All; rule 2 is the common case
on All for any org that has a group or relay thread (Sam's stated "37 = 30 + 7"
has seven).

(b) Row loss. Rule 2 keeps `base.slice(R)` (index-based, on page-append order)
and keeps the OLD cursor. The row that was last inside the old head and gets
pushed out of the new head by one new arrival is in neither `P` nor
`base.slice(R)`, and the kept cursor already points past it, so no Load more or
auto-load can ever fetch it again in this list session. Concrete trace with the
spec's own "wall of old group rows at the bottom of page one" (decision 4):

```
base = [c1..c100, g1..g7]      (server order; groups older than every contact)
new inbound from a contact not on screen
P    = [n, c1..c99, g1..g7], C = after c99
rule 2: base := P ++ ([g1..g7] minus P = [])  ; cursor := after c100 (UNCHANGED)
c100: not in P, not in the kept tail, and behind the kept cursor -> gone
```

Every new-contact arrival loses one more row. In the pure-contact case (L > 100
after an auto-load) the same row at index R-1 is lost every time.

**Evidence.** Spec 5.6 (R formula, rule 2, "cursor UNCHANGED"), section 8 bullet
2; `dashboard/src/routes/inbox/useInbox.ts:239` (base is installed in server
order), `:343` (loadMore appends); `app/src/routes/inbox.ts:2303` (chunk sized
from contact `limit`), `:2329` (page fills on CONTACT rows), `:2419-2424`,
`:2479-2483` (relay/group rows appended and re-sorted into the same page).

**What it implies.** Invariant 1 is violated in the exact configuration the
spec was written for, silently and unrecoverably until a full reload. The
Playwright seam hides it: with `?limit=2`, `R = min(max(L, 2), 100) = L` for any
L <= 100, so every e2e reconcile takes rule 1 and rule 2 is never exercised end
to end. The merge needs to be keyed on what the server's page actually covers
(contact-row count on All, a position comparison against `C`, or simply "take
`P` and `C` and let the cursor re-serve what fell off"), not on
`base.length`.

---

## 2. [HIGH] Invariant 1 ("every loaded row stays on screen") is a slogan the reconcile rules do not deliver

**What is wrong.**

(a) Rule 2's first arm infers "the feed now ends inside the head" from
`P.length < R`. That inference is false on two of the four tabs. The Unknown
branch returns short pages WITH a cursor when its scan budget expires, including
`{ rows: [], nextCursor }` (`app/src/routes/inbox.ts:2153-2170`; documented in
`dashboard/src/routes/inbox/Inbox.tsx:257-271` and spec section 2). The Unread
branch's budget exit "STILL MINT[S] THE CURSOR" on a short page
(`app/src/routes/inbox.ts:1661-1672`). On either, a reconcile with `L > R`
takes `base := P` and wipes every loaded tail row - down to ZERO rows on an
empty budget page, i.e. the list collapses into "Nothing on this page yet" on a
background event, which is the outcome this spec exists to remove.

(b) Rule 1 at `L == R` (page one full, no groups - e.g. the Unread tab at
100 rows) installs `base := P`. One new arrival pushes the old 100th row out of
`P`; it leaves the screen (recoverable only via the cursor). Literally a
violation of invariant 1, and a visible jump for an operator reading the bottom
of page one.

(c) Rows that legitimately stop qualifying (a group row pushed out of the
server's top-50 group cap, a row read elsewhere on Unread, a soft-deleted
contact) also leave. That is correct behavior, which is why the invariant as
worded cannot be the acceptance test.

**Evidence.** Spec 5.6 rule 2 first arm, invariant 1 (section 6), 7.3 test 2;
code cited above.

**What it implies.** The builder will be held to an invariant the design
contradicts. Restate invariant 1 as what the mechanism can guarantee, and fix
rule 2's "feed ended" test to key on `C === null` alone.

---

## 3. [HIGH] "Retry refresh" calls today's `retry()`, which blanks the rows to a spinner - and a failed retry then strands the tab on a spinner forever

**What is wrong.** 5.7 says the banner's button calls `retry` (7.1: "the banner
and its Retry call `retry`") and that "`retry()` runs a head read and clears it
on success". It does not change what `retry()` does first: today it calls
`applyStatus('loading')` (`dashboard/src/routes/inbox/useInbox.ts:314-317`).
`Inbox.tsx` renders rows only under `status === 'ready'`
(`dashboard/src/routes/inbox/Inbox.tsx:243`) and the spinner under `'loading'`
(`:206`), so pressing "Retry refresh" replaces a list that "was fine" with a
spinner - the thing decision 7 forbids.

Worse, 5.7's own failure rule then makes it permanent: the retry's head read
fails with `base.length > 0` (retry never clears `base`), so the new rule "sets
`refreshFailed = true` and leaves `status` ... untouched" - status stays
`'loading'`. The banner is gated on `status === 'ready'`, the error surface on
`status === 'error'` (`Inbox.tsx:220`), so the operator gets a spinner with no
rows, no banner and no Retry. This is exactly the "permanently stuck tab" the
existing generation-guard comment calls worse than the bug it guards
(`useInbox.ts:207-217`), and the second bad render recorded in the open issue
`docs/issues/inbox-group-truncation-notice-not-reset.md` ("while retry()'s
request is on the wire ... the same notice makes the same claim above the
Spinner").

**What it implies.** The spec must specify a non-destructive refresh retry
(no `'loading'` when rows exist) or the build ships a stuck state reachable by
one click during an outage.

---

## 4. [HIGH] The sign-out clear seam named in 5.5 is broken by React's deletion order: the Inbox's unmount save repopulates the store after `clear()`

**What is wrong.** 5.5 calls `clear()` "when the authenticated shell unmounts
(the AuthGate transition to unauthenticated, or AppFrame unmount, whichever the
plan proves is the single seam)", and separately requires the Inbox hook to
SAVE on unmount. Sign-out is in-SPA, not a reload: `handleSignOut` awaits
`refresh()` (`dashboard/src/app/AppFrame.tsx:43-57`), AuthContext flips to
`anonymous` (`dashboard/src/app/AuthContext.tsx:27-41`), and AuthGate swaps its
children for `<Login />` (`dashboard/src/app/AuthGate.tsx:10-20`), deleting the
whole AppFrame subtree including `<Inbox />` (`dashboard/src/App.tsx:129-166`).

React runs deletion effects PARENT FIRST, then children. Verified in the
installed react-dom 19.2.7,
`node_modules/react-dom/cjs/react-dom-client.development.js:16248-16300`
(`commitPassiveUnmountEffectsInsideOfDeletedTree_begin` runs the fiber's own
passive unmount, then descends to `fiber.child`). So with the "AppFrame unmount"
option, AppFrame's cleanup clears the store and THEN the Inbox's unmount save
writes the signed-out operator's rows back. The next sign-in in the same tab
mounts from that snapshot with `status: 'ready'` and shows the previous
operator's list until the reconcile lands.

Whether the AuthGate option works depends on unstated effect kinds: an AuthGate
`useEffect` runs in the passive MOUNT phase after all passive unmounts (works);
a render-time clear or a layout-phase clear runs before the Inbox save
(broken). Symmetrically, an Inbox save in a LAYOUT cleanup runs before an
AppFrame PASSIVE clear (works by accident).

**What it implies.** Invariant 7 holds or fails on an effect-ordering detail the
spec does not mention, and 7.1's `inboxListStore.test.ts: save/load/clear`
cannot see it. The spec must pick the seam and the effect phases, or suppress
the save once sign-out has begun.

---

## 5. [HIGH] The auto-load mechanism contradicts its own Playwright test and its own "no tight retry" guarantee

**What is wrong.** An `IntersectionObserver` delivers a callback on observe()
and then only on threshold CROSSINGS. 5.2 relies on that for safety ("There is
no tight retry: the observer fires on intersection changes, not continuously").
Three consequences the spec does not resolve:

(a) Stall. After a successful load that does not push the sentinel out of the
400px margin, no crossing occurs and nothing fires again. 7.3 test 2
(`?limit=2`, "the sentinel scroll appends rows until the list holds all of
them") is exactly that case: a short list keeps the sentinel inside the margin
from mount, the initial callback loads page 2, and then nothing fires. The test
cannot pass with the mechanism as written (and scrolling does not help while the
sentinel is already intersecting). The same stall follows every SSE reconcile
that discards an in-flight loadMore (5.6.4 keeps the `firstPageGenRef` discard).

(b) Stale closure. `loadMore` is re-created on every `cursor`/`loadingMore`
change (`useInbox.ts:319-360`, deps `[filter, cursor, loadingMore]`). An
observer built once captures the mount-time `loadMore` (cursor null at mount ->
permanent no-op) - so "the observer relies on [loadMore's idempotence] and adds
no second lock" only holds if the builder routes through a latest-ref.

(c) Hot loop. The obvious fix for (a) and (b) - recreate the observer when
`loadMore` changes - makes every re-creation fire an initial callback. A failing
`loadMore` flips `loadingMore` true -> false in `.finally` (`useInbox.ts:353-359`),
changing `loadMore`'s identity, recreating the observer, firing, failing again:
a request loop against a failing server, which 5.2 claims is impossible.

Also unspecified: whether a head reconcile's rows RE-ARM auto-load after an
empty-with-cursor page disarmed it. Under rule 2 the cursor is kept, so re-arming
on the head's rows re-points auto-load at the cursor that just returned nothing.

**Evidence.** Spec 5.2, 5.6.4, 7.3 test 2; `useInbox.ts:319-360`.

**What it implies.** The spec must choose the re-trigger rule explicitly
(e.g. re-check intersection after a SUCCESSFUL page only, never after a
failure) and make the test and the guarantee agree.

---

## 6. [HIGH] 5.10's "cannot emit twice" argument is false: the dedupe lives inside the concurrent function, and the identity guard degrades to always-pass

**What is wrong.** 5.10 says the sequential bookkeeping pass applies "the
`emittedContacts` dedupe" and that concurrency is safe "because the
newest-conversation identity guard is a pure function of a contact's
conversation set". In the code:

- The dedupe is INSIDE `rowForConversation`, checked before any await
  (`app/src/routes/inbox.ts:1150`) and written after several awaits (`:1189`).
  Two conversations of one contact hydrating in the same window both pass the
  check before either writes.
- `contactConversations` is best-effort: a thrown lookup caches and returns `[]`
  (`:858-865`), and then `maxConv = newestOf(convs) ?? conv` (`:1152`) makes
  EVERY conversation its own newest, so the identity guard (`:1168`) passes for
  all of them. Sequentially, `emittedContacts` is the ONLY thing that stops the
  second row. Concurrently, both emit.
- The cache has no in-flight memoization (`:843-865`): two concurrent misses
  both call `conversationsForContact`, so the two hydrations can see DIFFERENT
  sets (a write or GSI catch-up between the reads, or one read failing), and each
  can crown a different newest. "Idempotent fills" is false - the fills race and
  the last one wins.
- There is no per-request CONTACT cache at all (`contacts.findByPhone` is called
  per conversation, `:1081-1082`); the caches are `contactConvsCache` and
  `placementLabelCache` (`:772-773`).

So the sequential dedupe is LOAD-BEARING, not "defense in depth", and the spec
leaves it ambiguous whether it moves out of `rowForConversation` (which 5.10
also says is untouched in meaning). The 7.2 equivalence fixture (multi-number
contact, relay, unknown, soft-deleted) omits the one case that breaks: a
multi-number contact whose conversation-set lookup throws. With the repo's
immediate-resolving fakes (`app/test/inboxFeed.test.ts:3`), a builder who keeps
the in-function dedupe passes the test and ships duplicate rows (duplicate React
keys) whenever the participant GSI read fails.

Related, uncited: the open issue
`docs/issues/inbox-all-tab-open-partition-safety-net.md` records a trap for
anyone restructuring this loop (the `moreChunks` binding orphaned by replacing
the loop tail, a gate-5 lint error).

**What it implies.** 5.10 must state that the contactId dedupe runs in the
sequential pass over hydrated rows (and that the in-function early return is
removed or duplicated), and the equivalence test must include a failing
`findByParticipantPhone` for a multi-number contact inside one window.

---

## 7. [MEDIUM] 5.10's "dropped(...) telemetry untouched in meaning" is false

**What is wrong.** `dropped()` is called inside `rowForConversation`
(`app/src/routes/inbox.ts:1071, 1094, 1150, 1168, 1181, 1185`), not in the pager.
Under a window of 8: (a) conversations hydrated past the page-fill point record
drops for rows the sequential loop never reached; (b) a sibling conversation
that sequentially hit `dupContact` (`:1150`) now usually reaches the identity
guard first and records `notNewestConv` (`:1168`), nondeterministically. The
file documents `notNewestConv` as the read-side signal for GSI lag
(`:1157-1167`) and `drops` as a diagnostic contract (`:809-828`). The 7.2 test
compares rows, order and cursor only, so the drift is invisible.

**What it implies.** Either make `rowForConversation` return a reason that the
sequential pass records, or state the telemetry change and update the comments
that define those fields.

---

## 8. [MEDIUM] Rule 2's kept cursor re-emits contacts on the Unread tab (duplicate rowKeys)

**What is wrong.** The unread cursor carries a SEEN-SET of emitted contactIds
(`app/src/routes/inbox.ts:1327-1333`, `:1552`), and the unread path
deliberately has NO newest-conversation identity guard ("row identity is the
seen-set", `:1434-1438`). Rule 2 installs a fresh head read (its own seen-set)
but keeps the OLD cursor, whose seen-set never learned the head's emissions. A
multi-thread contact that newly surfaces in the head via a new inbound, and whose
older unread thread lies beyond the kept scan position, is emitted AGAIN by the
next loadMore. `loadMore` appends without dedupe (`useInbox.ts:343`); the
comment at `useInbox.ts:151-158` names duplicate rowKeys as the defect
`firstPageGenRef` exists to prevent. Rule 2's head-vs-tail dedupe runs only at
reconcile time, not on later appends.

**What it implies.** Reachable only past 100 loaded unread rows, but a real
duplicate-row bug; rule 2 either needs an append-time dedupe or must not keep a
cursor minted by a different chain.

---

## 9. [MEDIUM] The store's save/load mechanics are underspecified, and the stated mechanism mis-keys writes and restores false empty states

**What is wrong.**

(a) 5.5 says the hook LOADS "on mount" and "starts in `status: 'ready'`", but
the existing filter effect runs on mount and unconditionally resets to
`'loading'`, `base = []`, then fetches (`useInbox.ts:286-312`). The spec never
says how that effect changes, nor whether an in-page tab switch (All -> Unread
-> All, or the browser Back stepping through `?filter=`, `Inbox.tsx:16-20`)
restores from the store or reloads.

(b) "SAVES on every change to base/cursor/... (an effect keyed on those)" with
key `${filter}:${limit}`. On a tab switch there is one committed render where
`filter` is already the new value but `base` still holds the OLD filter's rows,
because the reset happens in an effect - the one-commit shape
`Inbox.tsx:188-196` already documents for `truncated`. A save effect that reads
`filter` and `base` from that render writes the old tab's rows under the new
tab's key. The spec's defense ("the existing activeFilterRef and filter-effect
resets apply before any save") is not a mechanism: `activeFilterRef` is written
inside that same effect flush and `setBase([])` is asynchronous.

(c) The snapshot has no `status`. A save during `'loading'` (the reset commit
writes `rows: []`), `'error'` or `'pending'` restores as `'ready'` with zero rows,
which renders the filter's empty copy - "You're all caught up" - until the
reconcile lands. The file's own history treats a false "all caught up" as a
defect (`Inbox.tsx:29-66`). Reachable by navigating away while a slow 100-row
first page is on the wire.

(d) The unmount save must read `base`/`pending` through refs; a cleanup closure
reads the values of the render it was created in.

**What it implies.** Specify: skip saves unless `status === 'ready'` for the
active filter epoch, and state the filter-effect branch for a store hit.

---

## 10. [MEDIUM] Scroll position captured "on unmount" is read after the route swap and is clamped by the destination page

**What is wrong.** The scroll container `main.content` belongs to AppFrame and
persists across routes (`dashboard/src/app/AppFrame.tsx:194-196`,
`AppFrame.module.css:383-387`); nothing resets it on navigation. A passive
(`useEffect`) cleanup runs after the commit that removed the Inbox DOM and
inserted the destination page, so reading `scrollTop` there returns a value
clamped to the destination's scroll height. 5.5 says only "written on unmount".
The 7.3 test 3 opens "the last row", which in the lean world is the connecting
relay group (`app/src/lib/seed/lean.ts:30`, TC0 is the oldest instant) and so
navigates to `/conversations/:id`. UNVERIFIED how tall that page renders in
`main.content`; if it is shorter than the inbox offset, the saved value is wrong.

**What it implies.** Specify capture in a layout-phase cleanup or a scroll
listener.

---

## 11. [MEDIUM] Restore fires on EVERY mount, not only on Back - clicking Inbox (or its unread badge) lands deep in an old scroll position

**What is wrong.** Section 1 and invariant 2 scope the feature to "the
browser's back button after she opens a conversation". The mechanism (5.5)
restores rows and `scrollTop` on any mount with a store hit: the sidebar Inbox
link, the nav unread badge, a programmatic navigate. An operator who scrolled
to row 180, opened a contact, and then clicks the Inbox link BECAUSE the badge
says there is new unread lands at row 180 with the new rows above the fold.
Nothing distinguishes POP from PUSH navigation (React Router 7 exposes
`useNavigationType()`; `dashboard/package.json` pins `react-router-dom ^7`).

**What it implies.** A product decision the spec made by accident; state it.

---

## 12. [MEDIUM] The latency claim covers one tab of four; Unread and Unknown go from 30 to 100 rows with sequential hydration on every reconcile

**What is wrong.** Sections 1 and 5.6 promise "a 100-row page does not take
three times as long" and "With 5.10 the server builds a 100-row page in about
the wall time today's 30-row page takes". 5.10 touches `filter=all` only. The
Unread branch hydrates one candidate at a time (`app/src/routes/inbox.ts:1531-1532`),
the Unknown branch resolves threads per contact in its fill loop
(`:1902-1917`, `want: limit - keptContacts.length` at `:1907`), and the client
change (5.1) sends `limit=100` to every tab, including every debounced SSE
reconcile. Unread is the triage tab. Section 8's fallback ("?limit=50 without a
deploy") is not a fallback an operator will find (see finding 22).

**What it implies.** Either extend the concurrency to the unread hydration loop,
keep a smaller limit on Unread/Unknown, or state the ~3x cost on those tabs.

---

## 13. [MEDIUM] The row layout arithmetic does not work: invisible actions reserve width, and the 6rem time column starves the name on phones

**What is wrong.**

- `.actions` is a laid-out flex item at `opacity: 0` (`InboxRow.module.css:140-148`),
  so it always reserves its width to the right of the link. The `<time>` is the
  link's last child, so "time at the far right" really sits left of an invisible
  gutter whose width depends on row state: "Mark read" on unread rows, "Mark
  unread" on read rows, and NO button on deleted or closed rows
  (`InboxRow.tsx:126-149`). The time column is ragged by state.
- Phone (5.4): the time keeps `min-width: 6rem` ("only its grid placement
  changes"). At `NARROW_360` (`e2e/support/viewport.ts:23`): 360 - 48 content
  padding (`AppFrame.module.css:386`, `--sp-5` = 24px) = 312 row; minus ~100
  actions and 12 gap = ~200 link; minus 32 link padding = ~168; minus dot 8,
  two 12px gaps and the 96px time leaves ~40px for the name. UNVERIFIED to the
  pixel (button widths estimated), but the order of magnitude is the point.
- 600-900px desktop: `.head` is `flex: 0 0 auto` (`InboxRow.module.css:67`);
  with a long name plus tags, `.head + count + 6rem time + actions` exceeds the
  row and `.row { overflow: hidden }` (`:16`) clips the time off the right edge.
- None of 7.3 test 4's assertions can catch any of this: the row's
  `overflow: hidden` guarantees no page-level horizontal overflow, and
  `toBeVisible` passes on a clipped element. 7.4's self-QA runs at "both widths"
  (360 and 1280), not the 600-900 band where the one-line layout is tightest.

**What it implies.** The spec needs to decide what happens to `.actions` (absolute
overlay, or collapsed off-hover) and drop or reduce the time's min-width on
phones.

---

## 14. [MEDIUM] On the All tab, auto-loaded pages land ABOVE page one's older group rows, not at the bottom

**What is wrong.** The client sorts the whole accumulation newest-first
(`useInbox.ts:533-534`), and page one on All carries up to 50 group rows plus
every relay row regardless of age (`inbox.ts:2376-2486`). When those rows are
older than page two's contacts - decision 4's "wall of old group rows at the
bottom of page one" - the operator is scrolled at that wall when the sentinel
fires, and the 100 new rows are inserted above her viewport. With Chromium's
scroll anchoring on the scroller she sees nothing change except the scrollbar
(UNVERIFIED for Safari, which may not anchor). Section 1's "Scrolling to the
bottom loads the next 100 by itself" is false in that configuration, and
decision 4's "shrinks the wall" holds for page one only.

**What it implies.** Not a request to build tracker #24 - a request to state
this consequence for Sam's review instead of claiming the wall shrinks.

---

## 15. [MEDIUM] Existing hook tests become order-dependent: the module-level store survives between tests

**What is wrong.** `useInbox.test.tsx` mounts the REAL hook repeatedly with the
same filter (`Probe`, `dashboard/src/routes/inbox/useInbox.test.tsx:59-81`) and
also renders the real `Inbox` for composed cases (`:36-39`). A module-level
`Map` keyed `all:100` persists across tests in one file; RTL's cleanup
unmounts each test's tree, which (per 5.5) SAVES. The next test then mounts
from the store in `'ready'` with the previous test's rows, and every assertion
that expects `'loading'` first, a first-page fetch, or a row count is now order
dependent. `dashboard/src/test/setup.ts` has no hook to clear it. 7.1 lists only
"additions". (`Inbox.test.tsx` mocks `useInbox` at `:38-42` and is insulated.)
The `useInbox(filter, limit)` signature change also touches `Probe`.

**What it implies.** The plan needs a global `afterEach(clear)` (or equivalent)
as an explicit task.

---

## 16. [MEDIUM] Several 7.3 Playwright cases cannot run as written

- Test 2: "With `/inbox?limit=2` ... two rows render" is false. Page one of All
  also carries every relay row and up to 50 group rows
  (`inbox.ts:2376-2486`); the lean seed alone has a native group text and a
  connecting relay group (`app/src/lib/seed/lean.ts:27-30`; described in
  `e2e/tests/dashboard-next/inbox-nav-badge.spec.ts:33-37`), and the spec
  deliberately does not reseed, so earlier specs' group texts accumulate. The
  loaded-row count `L` therefore depends on suite order; past 100 it flips the
  reconcile from rule 1 to rule 2 (finding 1) and the "still holds every
  previously loaded row" assertion becomes order-dependent.
- Test 3: at the default limit the lean world's inbox does not scroll, so
  `scrollTop` 0 == 0 passes vacuously. The test needs a limit and enough rows,
  or a short viewport, and the spec names neither.
- Test 5's aside proposes proving the disarm rule with "the Unread tab's
  empty-page-with-cursor". That state is server-unreachable:
  `if (unreadRows.length === 0) unreadCursor = null;`
  (`app/src/routes/inbox.ts:1714`). The empty-page-with-cursor is the UNKNOWN
  tab's (section 2 of the spec says so correctly).
- Test 2 also depends on the stall in finding 5.

---

## 17. [MEDIUM] The spec does not stand alone: the "mission's exclusion list" it tells the builder to respect is not in it

**What is wrong.** 4.2 forbids "any file on the mission's exclusion list (three
live branches own the outbound-texting path)" without listing the files or the
branches. Nothing in the worktree carries that list (no `.superpowers/`, no
other doc mentions it). A builder cannot honor a guardrail it cannot read.
Similarly, decision 3's visual contract points at an external mockup artifact
the builder may not be able to open, and section 10 defers Sam's possibly
structural layout feedback to "a fix-wave item".

**What it implies.** Inline the exclusion list (paths) in 4.2.

---

## 18. [LOW] 5.8 misdescribes today's behavior to justify the stale window

5.8: "There is a window of one round trip where the stale count shows;
accepted, and the same window exists today for a fresh mount." Today a fresh
mount shows a SPINNER, not stale rows: status starts `'loading'`
(`useInbox.ts:124`, `:299`) and rows render only under `'ready'`
(`Inbox.tsx:206`, `:243`). The stale-data window is new behavior; accept it on
its own terms.

---

## 19. [LOW] The dashboard moves onto the zero-margin `MAX_INBOX_LIMIT == SEEN_SET_MAX` boundary without citing the open issue or pinning it

`app/src/routes/inbox.ts:217` and `:259` are both 100.
`docs/issues/seen-set-max-equals-max-inbox-limit.md` (open) says the invariant
is untested above limit 30 and that "Nothing ships broken" only because the
dashboard pages at 30. This spec makes the dashboard page at exactly 100. It
still works (strict `>` at `:1655`), but the spec should cite the issue and add
the limit-100 unread paging test it asks for. It also moves
`unread-load-more-empty-on-exact-multiple`'s false-truncation point from 120 to
200 unread contacts.

---

## 20. [LOW] `toLocaleTimeString` may emit U+202F before AM/PM; the repo already normalizes for this elsewhere

5.3 defines `2:14 PM` as the raw `toLocaleTimeString('en-US', ...)` output, and
7.3 test 1's regex uses an ASCII space. ICU 72+ en-US data uses U+202F there;
the app normalizes it (`app/src/lib/localTime.ts:46-52`, `toAscii`), whose
comment says the CURRENT host ICU emits plain spaces. UNVERIFIED for the
Playwright-bundled Chromium. Cheap to adopt the same normalization.

---

## 21. [LOW] The timezone boundary unit test is machine-dependent

7.1 asks for "an instant in a different UTC day but the same local day". The
dashboard test setup pins the clock (`dashboard/src/test/setup.ts`, PINNED_NOW)
but not `TZ`, and nothing else does (`dashboard/vite.config.ts`). Under UTC the
case does not exist; under a US zone it does. The existing precedent avoids TZ
by using zone-less ISO strings (`dashboard/src/routes/contact/format.test.ts:85`),
which cannot express this case.

---

## 22. [LOW] The `?limit=` "no-deploy tuning knob" does not survive in-app navigation

Only `selectFilter` is specified to preserve it (5.1). The sidebar Inbox link
and the group-notice link (`Inbox.tsx:146`, `to="/inbox?filter=groups"`) drop
it, so it is a test seam, not a knob Sam can live with.

---

## 23. [LOW] `R` must be read through a ref, or the filter effect loops

5.6 computes `R` from `base.length` "at scheduling time". If `fetchHead` takes
`base` as a dependency, its identity changes on every page, and the filter
effect (deps include `fetchFirstPage`, `useInbox.ts:312`) re-runs: reset,
spinner, refetch, repeat. The existing code avoids exactly this for status
(`useInbox.ts:173-181`). Say "through a ref" as 5.7 already does.

---

## 24. [LOW] Breakpoint facts in section 8 are wrong

"The shell's own breakpoint is 860px (`twoPaneShell`)" - the SHELL (AppFrame)
breaks at 768px (`dashboard/src/app/useNavChrome.ts:16`,
`AppFrame.module.css:600-603`); 860 is `twoPaneShell`, a page layout
(`dashboard/src/ui/twoPaneShell.module.css:128`). The app's existing phone
breakpoint is `max-width: 599px` (`dashboard/src/routes/contact/Modal.module.css:141`,
`dashboard/src/ui/imageViewer/ImageViewer.module.css:68`); `600px` diverges by
one pixel for no stated reason. Between 600 and 767px there is no sidebar, so
"a narrow desktop window keeps the one-line row" is really "a drawer-mode
tablet keeps it" (and see finding 13).

---

## 25. [LOW] `savedAt` is stored and never read

5.5's value shape includes `savedAt`; no rule in the spec reads it (no staleness
cutoff, no scroll-restore gate). Either give it a rule or drop it.

---

## 26. [LOW] The perf:pages harness is an unenumerated inbox reader

`e2e/performance/routes.ts:409-416` resolves inbox readiness on the
`Conversations` list appearing. On a warm (SPA) navigation that now happens at
store restore, before any `/api/inbox` read, so warm-mode inbox numbers stop
measuring the API. Section 6's reader list omits it.

---

## 27. [LOW] `lastActivityAt` is not "the time of the last message"

Section 1 frames the label as the phone Messages app's last-message time. The
field is the conversation's activity stamp, which the relay retry ladder bumps
60-240s after the original send without changing the preview
(`app/src/repos/conversationsRepo.ts:651-681`,
`touchLastActivityPreservingStatus`). A relay row can therefore show a time
later than its preview's message. Worth one sentence so nobody "fixes" it.
