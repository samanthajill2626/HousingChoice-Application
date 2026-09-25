# Inbox: more rows, a time on every row, and a list that stays put - design specification

Status: DRAFT 1 - awaiting adversarial doc review, then Cameron's spec gate
Date: 2026-09-25
Branch: `feat/inbox-rows-timestamps`
Worktree: `W:\tmp\inbox-rows-timestamps`
Base: `main` at `cd8e8ddd15158e532d452383015f4e57115ff1d1`
Tracker: Sam's improvements list item #17 (support work under Amendment No. 2)

## 1. Outcome

Sam opens the Inbox and sees up to 100 conversations before she has to do
anything. Scrolling to the bottom loads the next 100 by itself. Every row shows
when its last activity happened, on the right, the way her phone's Messages app
does it: a clock time for today, "Yesterday", a month-and-day for anything
earlier this year, and month-day-year for other years. The list she has built
by scrolling survives two things that wipe it today: a live update (a text or
call arriving, a row marked read) and the browser's back button after she opens
a conversation. When a background refresh fails, the rows she has stay on
screen and a banner says the refresh failed, with a Retry.

Nothing tenant-, landlord- or partner-facing changes. No message-catalog copy is
added. The inbox API's wire shape (`InboxRow`, `InboxPage`) is unchanged; the
only server change is that the `filter=all` page is hydrated with bounded
concurrency instead of one row at a time, so a 100-row page does not take three
times as long as today's 30-row page.

## 2. Current behavior (verified against `main` @cd8e8ddd)

- `dashboard/src/routes/inbox/useInbox.ts` requests `PAGE_LIMIT = 30` contact
  rows. The server (`app/src/routes/inbox.ts`) defaults to 25 and clamps
  `?limit=` to 1..100 (`DEFAULT_INBOX_LIMIT`, `MAX_INBOX_LIMIT`, `parseLimit`).
- Under `filter=all`, page one ALSO carries every open and connecting relay
  group (uncapped) and the newest 50 native group texts
  (`GROUP_PAGE_ONE_LIMIT`), merged additively; both merge blocks gate on
  `startKey === undefined`, so pages two and later hold contact rows only. Sam's
  "37" is 30 contact rows plus 7 group/relay rows.
- Every `InboxRow` carries `lastActivityAt` (ISO). `InboxRow.tsx` never renders
  it. No row shows a time.
- Live updates: `useEventStream({ onConversationUpdated: scheduleRefetch })`
  debounces 300 ms and calls `fetchFirstPage`, which does
  `setBase(pageData.rows)` - the WHOLE list is replaced by page one. Rows
  appended by Load more are discarded. A `loadMore` in flight when a first-page
  read commits is discarded too (`firstPageGenRef`). So any inbox-affecting
  event collapses the list to page one.
- Navigation: the app uses `BrowserRouter` + `<Routes>`; `/inbox` mounts
  `<Inbox />` and `/contacts/:id` or `/conversations/:id` unmounts it. There is
  no scroll restoration. Back re-mounts the page: status `loading`, first page
  only, scrolled to the top.
- The page's scroll container is `<main className={styles.content}>` in
  `AppFrame.tsx` (`overflow-y: auto`), not the window.
- The Unknown filter can return `{ rows: [], nextCursor }` when its scan budget
  expires; the page renders `emptyMoreCopy()` above a live Load more. The Unread
  filter can set `truncated` with a cursor, so its notice can render above a
  working Load more. Both are accepted, documented states.
- A failed background reconcile sets `status: 'error'`, which blanks the list
  into "We couldn't load your inbox." (filed:
  `docs/issues/inbox-reconcile-failure-blanks-list.md`, a product decision
  awaiting a ruling). A failed `loadMore` keeps the cursor and re-enables the
  button silently.
- Server hydration is sequential: the pager loop in `aggregateInbox` awaits
  `rowForConversation` per conversation, and each one awaits a contact lookup,
  the contact's conversation set, and a latest-message read in turn. A 100-row
  page is roughly 300 sequential DynamoDB round trips.
- The row is a single flex line at every width: dot, name, chip, tags, preview
  (ellipsized), count, then the hover-revealed actions. `InboxRow.module.css`
  and `Inbox.module.css` contain no media queries.
- The contact timeline already has `formatTime` ("9:14a") and
  `formatDayDivider` ("Mon Jun 8") in `dashboard/src/routes/contact/format.ts`.
  The inbox does not reuse them (decision 5 below).

## 3. Locked product decisions (Cameron, 2026-09-25)

1. Page size 100 (the server's maximum) AND auto-load on scroll, with the Load
   more button kept as the fallback affordance. ("C" in the brainstorm.)
2. Timestamp tiers, exactly four:
   - same local calendar day as now: the clock time, `2:14 PM`;
   - the previous local calendar day: `Yesterday`;
   - any earlier day in the current local year: `Sep 12`;
   - any other year: `Sep 12, 2025`.
   No weekday tier: Cameron ruled it out because it hides the date.
3. Placement: right edge of the row. On a phone the row becomes two lines
   (name and time on top, preview and unread count below); on a desktop it
   stays one line with the time at the far right. Unread rows keep the existing
   bold name and preview, blue accent bar, and red count; the unread row's time
   is dark and semibold, a read row's time is muted. Mockups shared with Sam
   for asynchronous review at https://claude.ai/artifact/33RDvWfTxELDupEsQv7CzW;
   her notes, if any, are folded in as a revision of this spec.
4. Group and relay rows keep today's paging (page one only). They get the same
   time as every other row. The "one timeline across kinds" change is DEFERRED
   as tracker item #24 pending Sam's confirmation. The larger page moves the
   one-on-one cutoff from the 30th to the 100th conversation, which shrinks the
   wall of old group rows at the bottom of page one without touching the
   server's merge.
5. The inbox uses `2:14 PM`, not the timeline's `2:14p`. The inbox is the
   screen Sam compares to her phone; the timeline's format is filed as a
   separate follow-up (section 9), not changed here.
6. The loaded list persists across live updates and the back button via an
   in-memory store keyed by filter, restored on mount and then reconciled.
7. A failed background refresh keeps the rows AND shows the failure: a banner
   above the list with a Retry button. Never a silent stale list, never a blank
   error state over rows that were fine. This resolves
   `inbox-reconcile-failure-blanks-list` (option 1 with the failure made
   visible, which is what the issue's option 3 wanted preserved).
8. The dashboard honors an optional `limit` query parameter on `/inbox`
   (clamped 1..100, default 100). It is the Playwright seam for proving paging
   without seeding 100 conversations and a no-deploy tuning knob if 100 proves
   slow for Sam.
9. Bounded-concurrency hydration on the server's `filter=all` page, keeping
   emission order and dedupe identical to today.

## 4. Scope

### 4.1 In scope

- `dashboard/src/routes/inbox/useInbox.ts`, `Inbox.tsx`, `InboxRow.tsx`, their
  CSS modules and tests; a new pure `inboxTime.ts` formatter and a new
  `inboxListStore.ts` module, both under `dashboard/src/routes/inbox/`.
- `app/src/routes/inbox.ts`: the `filter=all` pager's hydration concurrency
  only. No wire-shape change. No change to the relay or group merge, the unread
  branch, the unknown branch, cursors, or limits.
- `e2e/tests/dashboard-next/`: a new `inbox-rows-timestamps.spec.ts`; existing
  inbox specs are re-run unchanged and must stay green.
- `docs/issues/`: resolve `inbox-reconcile-failure-blanks-list`; file the two
  follow-ups in section 9.

### 4.2 Out of scope

- One timeline across one-on-one, relay and group rows (tracker #24).
- Any change to `app/src/repos/conversationsRepo.ts` or any file on the
  mission's exclusion list (three live branches own the outbound-texting path).
  If the plan finds it needs one, it stops and asks.
- The contact timeline's time format.
- Changing the server's `DEFAULT_INBOX_LIMIT`, `MAX_INBOX_LIMIT`,
  `GROUP_PAGE_ONE_LIMIT`, or the seen-set cap.
- Virtualized rendering. At 100-300 rows of one `<li>` each the DOM is small.
- A periodic re-render to roll "2:14 PM" over to "Yesterday" at midnight. Labels
  are computed at render time; a reconcile (any inbox event) or a navigation
  re-renders them. The contact timeline accepts the same thing.
- Tenant-facing or catalog copy. None exists here.

## 5. Design

### 5.1 Page size and the `limit` parameter

- `useInbox(filter, limit)` takes the page size as a parameter. `Inbox.tsx`
  reads `limit` from the URL search params through a pure `limitFromParam(raw)`
  beside `filterFromParam`: an integer 1..100 is honored, anything else
  (absent, empty, `0`, `-5`, `abc`, `1000`) falls back to
  `DEFAULT_PAGE_LIMIT = 100`. The value never round-trips to the server
  un-clamped; the server clamps again anyway.
- `selectFilter` preserves a `limit` param that is present when it rewrites the
  filter param, so a tuned link keeps its size across tabs.
- Every `getInbox` call from the hook uses the hook's `limit` except the
  reconcile, which uses the reconcile size in 5.6.

### 5.2 Auto-load on scroll

- A sentinel element sits after the list and before the Load more button. It is
  `aria-hidden="true"`, empty, and not focusable. The button remains the
  accessible affordance and keeps its current copy and gating (`hasMore`,
  disabled while `loadingMore`).
- An `IntersectionObserver` on the page's scroll container (the nearest
  scrolling ancestor of the list, resolved at mount; today
  `AppFrame`'s `main.content`) with `rootMargin: '400px 0px'` calls
  `inbox.loadMore()` when the sentinel enters the margin.
- ARMING RULE. Auto-load is armed only while the LAST server page for this list
  delivered at least one row. The initial page arms it if it delivered rows. A
  page that delivered zero rows with a cursor (the Unknown tab's budget exit,
  or any future equivalent) DISARMS it: the sentinel stops firing and the
  manual button stays, with the existing `emptyMoreCopy()` /
  `emptyClearedCopy()` beside it. A manual click re-runs `loadMore` as today;
  if that page delivers rows, auto-load re-arms. This is what makes an
  auto-load loop impossible on an empty-page-with-cursor result.
- A failed `loadMore` keeps today's behavior (cursor kept, button re-enabled)
  and does NOT disarm auto-load; the next intersection retries once the
  sentinel leaves and re-enters the margin. There is no tight retry: the
  observer fires on intersection changes, not continuously.
- `loadMore` is already idempotent while `loadingMore` is true; the observer
  relies on that and adds no second lock.
- In jsdom (`IntersectionObserver` undefined) the hook installs nothing and the
  button alone drives paging. The unit tests exercise the arming rule through a
  small injected observer factory; Playwright exercises the real one.

### 5.3 The time label

New pure module `dashboard/src/routes/inbox/inboxTime.ts`:

- `formatInboxTime(iso: string, now: Date): string` returns the tier label per
  decision 2 using LOCAL calendar days (`getFullYear/getMonth/getDate` of both
  instants), never UTC days and never a 24-hour window. `2:14 PM` is
  `toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })`;
  `Sep 12` is `toLocaleDateString('en-US', { month: 'short', day: 'numeric' })`;
  `Sep 12, 2025` adds `year: 'numeric'`. An unparseable instant returns `''`
  (the `formatTime` contract in `contact/format.ts`), and the row then renders
  no `<time>` element at all rather than an empty one.
- `formatInboxTimeFull(iso: string): string` returns
  `toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric',
  hour: 'numeric', minute: '2-digit' })`, e.g. `Sep 12, 2026, 2:14 PM`, for the
  hover title; `''` when unparseable.
- Both accept a clean ISO instant. `lastActivityAt` is always a clean instant
  (it is the conversation's `last_activity_at`, not a `#`-suffixed sort key),
  so `isoOf` is applied anyway for symmetry with the other formatters and costs
  nothing.
- A future instant (clock skew) falls into the same-day tier if it is today,
  else the date tiers; nothing special.

### 5.4 The row

`InboxRow.tsx` renders, inside the existing `Link`:

```
<time className={styles.time} dateTime={row.lastActivityAt} title={full}>
  {label}
</time>
```

- Desktop (default styles): the `<time>` is the last child of the link, after
  the count pill, `flex: 0 0 auto; min-width: 6rem; text-align: right;
  font-size: var(--fs-xs)`. Read rows: `color: var(--c-text-muted)`. Unread rows
  (`.unread .time`): `color: var(--c-text); font-weight: var(--fw-semibold)`.
  The hover-revealed `.actions` stay outside the link, after it, unchanged.
- Phone (`@media (max-width: 600px)` in `InboxRow.module.css`, the first media
  query in the inbox styles): the link becomes a two-row grid. Row one: dot,
  name (ellipsized, `min-width: 0`), chip, tags, time at the right. Row two:
  preview (ellipsized) and the count pill at the right. The `<time>` keeps the
  same element and classes; only its grid placement changes. No element is
  duplicated for the two layouts.
- `title` on the `<time>` gives the full stamp on hover and on long-press in
  mobile browsers that surface titles. The accessible name of the row link now
  ends with the label text (it is link content), which is intended: a screen
  reader hears the name, chip, preview, count, then the time.
- The row's existing accessible-name consumers (Playwright locators using
  `getByRole('link', { name: /Name/ })`) keep matching because they are
  substring regexes; `inbox-nav-badge.spec.ts`'s strict-mode note about the
  count span is unaffected.
- `InboxRow` computes `now` as `new Date()` at render. Tests pin it with
  `vi.setSystemTime`.

### 5.5 The list store

New module `dashboard/src/routes/inbox/inboxListStore.ts`, module-level state
(a `Map`), no React:

```
key: `${filter}:${limit}`
value: {
  rows: InboxRowData[];        // the rows as DISPLAYED at save time (patches applied)
  cursor: string | null;
  groupsTruncated: boolean;
  truncated: boolean;
  scrollTop: number;
  savedAt: number;             // Date.now()
}
```

- `save(key, snapshot)`, `load(key)`, `clear()`; `clear()` is exported and is
  called when the authenticated shell unmounts (the `AuthGate` transition to
  unauthenticated, or `AppFrame` unmount, whichever the plan proves is the
  single seam) so a sign-out never leaks one operator's rows to the next
  sign-in in the same tab. A full page load starts empty by construction.
- `useInbox` SAVES on every change to `base`/`cursor`/`groupsTruncated`/
  `truncated` (an effect keyed on those), and on unmount saves once more with
  the current `pending` patches folded into `rows` so an optimistic mark-read
  made just before navigating away is what the operator sees on return.
  `scrollTop` is written on unmount from the scroll container.
- `useInbox` LOADS on mount: if the store has the key, the hook initializes
  `base`, `cursor`, `groupsTruncated`, `truncated` from it and starts in
  `status: 'ready'` (no spinner), then immediately schedules the reconcile of
  5.6. If it has nothing, today's path runs (`loading`, first page).
- The store is written for the filter the hook is showing, never for a filter
  it has left (the existing `activeFilterRef` and filter-effect resets apply
  before any save).
- Scroll restore: `Inbox.tsx` restores `scrollTop` in a layout effect after the
  first render that has rows, and only when the mount came from the store. The
  scroll container is resolved the same way 5.2 does.
- The Unread tab's client narrowing (`visible`) is applied AFTER load as today;
  the store holds `base`-shaped rows.

### 5.6 The reconcile sized to what is on screen

`fetchFirstPage` becomes `fetchHead(reason)` with one behavioral change: the
requested size is `R = min(max(loadedRowCount, limit), MAX_INBOX_LIMIT)` where
`loadedRowCount = base.length` at scheduling time and `MAX_INBOX_LIMIT` is
100 mirrored on the client as a named constant with a comment pointing at the
server's. Merge rule on success (`P` = the page's rows, `C` = its cursor,
`L` = `base.length`):

1. `L <= R` (the common case, everything the operator has is inside one
   server page): `base := P`, `cursor := C`. Exactly today's behavior with a
   bigger page.
2. `L > R` (the operator auto-loaded past 100 rows):
   - if `P.length < R` or `C === null`, the feed now ends inside the head:
     `base := P`, `cursor := C`. The tail was stale by definition.
   - else `base := P ++ (base.slice(R) filtered to rowKeys not in P)`,
     `cursor` UNCHANGED (it still addresses the position after the old tail).
     A row whose activity moved it into the head is deduplicated out of the
     tail. A tail row whose `unreadCount` changed without activity (a mark-read
     from another tab) stays stale until it scrolls out or the operator acts on
     it; the optimistic patches cover the operator's own actions.
3. `groupsTruncated` and `truncated` are replaced from the page as today.
4. The generation guards (`genRef`, `firstPageGenRef`, `activeFilterRef`,
   `statusRef`) keep their exact semantics. `firstPageGenRef` still bumps on
   every committed head read, so a `loadMore` that was in flight is still
   discarded and the button re-enabled.

The reasons are the same three as today: initial load (when the store is
empty), Retry, and the debounced SSE reconcile; plus the mount-from-store
reconcile, which is scheduled immediately (no debounce) and behaves as an SSE
reconcile for the guards.

Cost statement: every reconcile reads up to 100 rows. On `main` it reads 30.
With 5.10 the server builds a 100-row page in about the wall time today's
30-row page takes; without 5.10 it takes roughly three times as long. Either
way it is one request per 300 ms debounce window, as today.

### 5.7 Refresh failure

`InboxState` gains `refreshFailed: boolean`.

- A head read that fails while rows are rendered (`base.length > 0` at failure
  time, read through a ref) sets `refreshFailed = true` and leaves `status`,
  `base` and `cursor` untouched. A head read that fails with NO rows rendered
  keeps today's behavior (`status: 'error'`, the existing full error surface).
  The 404 "pending" arm is unchanged.
- Any head read that succeeds clears `refreshFailed`. `retry()` runs a head
  read and clears it on success.
- `Inbox.tsx` renders, when `refreshFailed && status === 'ready'`, a banner
  above the list, `role="status"` (not `alert`: nothing was lost), copy
  "Couldn't refresh the inbox." with a Retry button labelled `Retry refresh`
  (distinct from the existing error surface's `Retry` so the two never share an
  accessible name). It sits above the truncation notices, below the tabs.
- The banner does not disable Load more or the rows. A `loadMore` failure
  keeps today's silent behavior; it is not routed through the banner
  (unchanged product surface).
- `docs/issues/inbox-reconcile-failure-blanks-list.md` is set to `resolved`
  with a Resolution block naming this section.

### 5.8 Back button and scroll

Covered by 5.5: the unmount save + mount load + layout-effect scroll restore.
Two invariants:

- A return to `/inbox` with a DIFFERENT filter than the one saved starts as a
  fresh load for that filter (the key differs); the other filter's snapshot is
  kept for its own return.
- A return after the operator marked a row read on its contact page shows the
  row as read: the contact page's mark-read emits `conversation.updated`, but
  the inbox hook was unmounted then, so the mount reconcile is what corrects the
  snapshot. There is a window of one round trip where the stale count shows;
  accepted, and the same window exists today for a fresh mount.

### 5.9 Group and relay rows

No change to paging. `InboxRow` renders the time for `relay_group` and
`group_text` rows from their `lastActivityAt` exactly as for contact rows.
`groupsTruncated`, `groupRowsShown`, the notices and the Groups filter are
unchanged.

### 5.10 Server: bounded-concurrency hydration on `filter=all`

In `aggregateInbox`'s open-partition pager (the loop that awaits
`rowForConversation` per conversation of each `listByLastActivity` chunk):

- Hydrate a chunk's conversations with a concurrency limit of
  `HYDRATE_CONCURRENCY = 8` (a small hand-rolled window over the chunk; no new
  dependency), producing `(conv, row | undefined)` pairs in CHUNK ORDER.
- Apply the page-fill bookkeeping SEQUENTIALLY over those pairs in chunk order:
  the `emittedContacts` dedupe, the page boundary/cursor computation, the
  `dropped(...)` telemetry, and the stop-at-`limit` rule are untouched in
  meaning. Because the newest-conversation identity guard is a pure function
  of a contact's conversation set (not of iteration order), evaluating two
  conversations concurrently cannot make a contact emit twice; the sequential
  dedupe pass remains the defense in depth it is today.
- Rows hydrated past the point where the page filled are discarded, exactly as
  a sequential loop would have never reached them; the cursor is computed from
  the last CONSUMED conversation as today, so the wire cursor is unchanged for
  the same data.
- Per-request caches (contact, placement) keep working; they become shared by
  concurrent hydrations, which is safe because they are read-through maps
  keyed by id with idempotent fills.
- Best-effort semantics are unchanged: a failed lookup inside one hydration
  degrades that row as today and never rejects the batch.
- A route test asserts the page for a fixture with multi-number contacts, a
  relay row, an unknown row and a soft-deleted resurfacing row is IDENTICAL
  (rows, order, cursor) to the same request served with `HYDRATE_CONCURRENCY`
  forced to 1 through the router's deps.
- The unread and unknown branches are not touched. If the plan's reading of
  the pager finds an ordering dependence this section did not, the plan drops
  5.10 and says so; sections 5.1-5.9 do not depend on it.

## 6. Invariants and the surfaces that touch them

Protected state: the displayed inbox list (`base` + `cursor` + the flags) and
the list store.

Writers: initial load, Retry, SSE reconcile, mount-from-store reconcile
(`fetchHead`); `loadMore` (auto or manual); `markRead`/`markUnread` optimistic
patches and their commits/rollbacks; the filter-change reset; the unmount save;
`clear()` on sign-out.

Readers/renderers: `Inbox.tsx` (rows, empty states, notices, banner, Load more
gating), `InboxRow.tsx` (row + time), the scroll restore, the auto-load
observer (reads `hasMore`/armed), `UnreadContext` (badge clears noted by
`markRead`), and every e2e spec that reads the inbox.

Invariants the plan must carry as explicit tasks or watch items:

1. Any inbox-affecting event leaves every loaded row on screen (modulo the
   dedupe in 5.6.2) and never resets scroll.
2. Back from a contact or conversation page shows the same rows and scroll
   position, then reconciles.
3. Auto-load never fires on a zero-row page with a cursor, and never fires
   while `loadingMore` or when `hasMore` is false.
4. A failed background refresh never blanks rendered rows; it shows the banner.
5. A failed initial load (no rows) shows the existing error surface, unchanged.
6. The Unread tab's client narrowing and the notices keep their server-quantity
   gating (`serverRowCount`, `truncated`, `groupsTruncated`), unchanged.
7. Sign-out clears the store.
8. The server page for `filter=all` is byte-identical in rows, order and
   cursor with and without concurrency.

## 7. Testing

### 7.1 Unit (Vitest, dashboard)

- `inboxTime.test.ts`: every tier; the boundaries (23:59 vs 00:01 across a
  local midnight; Dec 31 vs Jan 1 across a year; an instant in a different UTC
  day but the same local day); unparseable input; the full-stamp helper.
- `useInbox.test.tsx` additions: reconcile requests `min(max(L, limit),
  100)`; merge cases 5.6.1 and both 5.6.2 arms including the dedupe; the
  mount-from-store path skips the spinner and reconciles immediately; unmount
  saves patched rows and the store key is filter+limit; `refreshFailed` set
  and cleared per 5.7, and the no-rows failure still yields `error`; arming
  rule via an injected observer factory (armed after a rows page, disarmed
  after an empty-with-cursor page, never fires while loading or without a
  cursor).
- `InboxRow.test.tsx` additions: the `<time>` element renders with `dateTime`,
  `title` and the label for contact, relay and group rows; unread vs read
  class; no element for an unparseable instant.
- `Inbox.test.tsx` additions: `limitFromParam` table; the banner and its Retry
  call `retry`; the sentinel is present only with `hasMore`; scroll restore
  calls the container.
- `inboxListStore.test.ts`: save/load/clear.

### 7.2 Route (Vitest, app)

- `inboxFeed.test.ts` or a sibling: the 5.10 equivalence test; the existing
  `filter=all` tests unchanged.

### 7.3 Playwright (`e2e/tests/dashboard-next/inbox-rows-timestamps.spec.ts`)

Hermetic `e2e:session` only, accessibility-first selectors, the lean profile.
Fresh parties are minted per test with run-unique numbers (the existing
`registerParty` + `sendAsParty` fixtures); any row left unread is marked read
before the test ends so later specs' "nothing unread" baselines hold.

1. Times render. Seed one inbound now; the row's `<time>` (located by role
   `time` is not a Playwright role, so `page.locator('time')` scoped inside
   the row link) has `dateTime` equal to the API's `lastActivityAt` for that
   row (read once through the request context) and text matching
   `^\d{1,2}:\d{2} [AP]M$`; the lean seed's June row has text matching
   `^[A-Z][a-z]{2} \d{1,2}(, \d{4})?$` (year-agnostic on purpose so the spec
   survives January).
2. Paging and survival. With `/inbox?limit=2` and at least three contact rows:
   two rows render, the sentinel scroll appends rows until the list holds all of
   them (Load more gone); then a new inbound for a fresh party arrives and the
   list still holds every previously loaded row plus the new one at the top,
   with no reload spinner.
3. Back button. Scroll to the bottom, open the last row, `page.goBack()`; the
   same rows are present without a spinner and the container's `scrollTop` is
   within a small tolerance of what was saved.
4. Phone width. `NARROW_360` from `e2e/support/viewport.ts`, the shared
   no-horizontal-overflow assertion, the time visible inside the first row,
   then `WIDE_RESTORE`.
5. Refresh failure banner: intercepted at the network layer with
   `page.route` returning 500 for the reconcile request only, triggered by an
   inbound; rows remain, the banner and `Retry refresh` appear, un-routing and
   clicking Retry clears it. (If the Unread tab's empty-page-with-cursor cannot
   be produced cheaply in the lean world, the auto-load disarm rule is proven
   in the unit tests only, and the spec says so in its header comment.)

### 7.4 Gates

All five from AGENTS.md, bare, from the worktree, plus a live self-QA pass in
an `e2e:session` lane at both widths.

## 8. Risks and accepted trade-offs

- Read cost: a reconcile reads up to 100 rows instead of 30 per debounce
  window. DynamoDB on-demand cost at Sam's volume is negligible; latency is the
  real cost and 5.10 is the mitigation. If 5.10 is dropped, `?limit=50` is the
  fallback knob without a deploy.
- A stale tail row (5.6.2) can show an out-of-date unread count until it scrolls
  out. Only reachable past 100 loaded rows and only for changes made elsewhere;
  accepted.
- The store is per tab and in memory. Two tabs do not share it; a reload
  starts fresh. Accepted; it matches the badge's optimistic layer.
- Labels do not roll over at midnight without a re-render. Accepted (section
  4.2).
- The 600px breakpoint is a new number in the inbox styles. The shell's own
  breakpoint is 860px (`twoPaneShell`); 600 is chosen so a narrow desktop
  window keeps the one-line row and only phones get two lines. Sam's
  asynchronous review may move it.

## 9. Issues to file and resolve

- Resolve: `inbox-reconcile-failure-blanks-list` (5.7).
- File: `contact-timeline-time-format-differs-from-inbox` (low, improvement):
  the timeline shows `9:14a`, the inbox `9:14 AM`; decide once and align.
- File: `inbox-labels-do-not-roll-over-at-midnight` (low, debt): a visible
  "2:14 PM" becomes "Yesterday" only on the next re-render.
- Tracker #24 (one timeline) is Cameron's, outside the repo.

## 10. Open items

- Sam's feedback on the mockups (row layout, breakpoint, unread time weight).
  Folded in as a spec revision before the plan if it arrives in time, else as
  a fix-wave item.
