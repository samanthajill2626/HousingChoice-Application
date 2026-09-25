# Inbox: more rows, a time on every row, and a list that stays put - design specification

Status: DRAFT 5 - revised after adversarial review round 3; round 4 (terminal) pending
Date: 2026-09-25
Revised: 2026-09-25
Branch: `feat/inbox-rows-timestamps`
Worktree: `W:\tmp\inbox-rows-timestamps`
Base: `main` at `cd8e8ddd15158e532d452383015f4e57115ff1d1`
Tracker: Sam's improvements list item #17 (support work under Amendment No. 2)
Review records: `docs/superpowers/reviews/2026-09-25-inbox-rows-timestamps/`

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
only server change is that the `filter=all` page prefetches its per-row reads
with bounded concurrency, so a 100-row page does not take three times as long
as today's 30-row page. That server slice is separable (section 5.10).

## 2. Current behavior (verified against `main` @cd8e8ddd)

- `dashboard/src/routes/inbox/useInbox.ts` requests `PAGE_LIMIT = 30`. The
  server (`app/src/routes/inbox.ts`) defaults to 25 and clamps `?limit=` to
  1..100 (`DEFAULT_INBOX_LIMIT`, `MAX_INBOX_LIMIT`, `parseLimit`: an absent,
  empty, zero or negative value FALLS BACK to the default; a value above 100 is
  clamped to 100).
- Under `filter=all`, `limit` counts CONTACT/UNKNOWN rows only, and the pager
  walks the `byLastActivity` open partition newest-first, emitting a contact
  only at its newest conversation, so a contact row's `lastActivityAt` IS the
  walk key. Page one ALSO carries every open and connecting relay group
  (`listRelayGroups`, best-effort: a failure is swallowed with a WARN and yields
  no relay rows; its own page budget can omit groups) and the newest 50 native
  group texts (`GROUP_PAGE_ONE_LIMIT`), merged additively and then re-sorted by
  `lastActivityAt`; both merge blocks gate on `startKey === undefined`, so
  pages two and later hold contact rows only. Sam's "37" is 30 contact rows
  plus 7 group/relay rows (live data, not verifiable here). A relay group
  CONVERTS to a native group text in place, under the same `conversationId`
  (`group-text-conversion.spec.ts`; the lean seed's connecting group).
- Under `filter=unread`, `limit` counts ALL rows in one unified walk of the
  `byUnread` index ordered by the newest UNREAD thread; identity is a seen-set
  of contact ids carried in the cursor, not the newest-conversation rule. A
  multi-thread contact DISPLAYS its newest thread of any state, so its
  displayed `lastActivityAt` can be newer than its position in the walk. A
  budget exit returns a short page with a cursor and `truncated`; the depth cap
  returns `nextCursor: null` with `truncated`; a zero-row page carries no
  cursor.
- Under `filter=unknown`, rows come from the contacts `byTypeStatus`
  partition in QUEUE order (untriaged first, then by status block, ids random
  within a block), NOT in activity order. A new unknown number can land
  anywhere in page one. A budget exit returns `{ rows: [], nextCursor }`, which
  the server deliberately does NOT flag as a failure: it is a normal answer
  ("nothing on this page yet, keep looking"), and the dashboard renders
  `emptyMoreCopy()` for it.
- Under `filter=groups`, rows are group texts only, paged newest-first on the
  `group_open` partition by `last_activity_at` with their own tagged cursor.
- Every `InboxRow` carries `lastActivityAt` (ISO). `InboxRow.tsx` never renders
  it. No row shows a time. `lastActivityAt` is the conversation's activity
  stamp, not the last message's `created_at`: the relay retry ladder bumps it
  60-240 s after the original send without changing the preview
  (`conversationsRepo.touchLastActivityPreservingStatus`). A relay row can
  show a time later than its previewed message; that is correct for a "last
  activity" label and is not to be "fixed".
- Live updates: `useEventStream({ onConversationUpdated: scheduleRefetch })`
  debounces 300 ms and calls `fetchFirstPage`, which does
  `setBase(pageData.rows)` - the WHOLE list is replaced by page one. Rows
  appended by Load more are discarded. A `loadMore` in flight when a first-page
  read commits is discarded too (`firstPageGenRef`). So any inbox-affecting
  event collapses the list to page one. `loadMore` appends without dedupe.
- Navigation: the app uses `BrowserRouter` + `<Routes>`; `/inbox` mounts
  `<Inbox />` and `/contacts/:id` or `/conversations/:id` unmounts it. There is
  no scroll restoration. Back re-mounts the page: status `loading`, first page
  only, scrolled to the top. The app root renders under `React.StrictMode`
  (`dashboard/src/main.tsx`), so effects mount, clean up and mount again in
  development and in the e2e harness (which serves the Vite dev server), and
  a mount issues one head read that the simulated cleanup aborts before the
  replay issues the live one. React Router 7 exposes `useNavigationType()`
  (`POP` for back/forward, `PUSH` for a link or programmatic navigation,
  `REPLACE`). React deletes subtrees parent-first: a deleted parent's effect
  cleanups run before its children's. A state update and a navigation issued
  in the same click handler batch into ONE render, and if that render unmounts
  the Inbox the update is never observable from the unmounting component.
- The page's scroll container is `<main className={styles.content}>` in
  `AppFrame.tsx` (`overflow-y: auto`, no `overflow-anchor` rule), not the
  window. When the Inbox is mounted, its page root is the only child of that
  container. The contact and conversation pages that replace the Inbox are
  `height: 100%` with their own internally scrolling panes, so after a route
  swap `main.content` has nothing to scroll and its `scrollTop` reads 0.
  Chromium's CSS scroll anchoring is on by default: when content is inserted
  above the viewport's anchor node the browser raises `scrollTop` to keep that
  node in place. `overflow-anchor: none` on an element excludes that element
  and its subtree from ANCHOR SELECTION; it does not turn anchoring off for
  the scroller, so an excluded list leaves the elements after it (a button)
  as candidates. The contact timeline opts out on its own scroller
  (`Timeline.module.css`, `.stream`).
- The sidebar is 240px wide above the shell's narrow breakpoint; the shell's
  media query is `max-width: 767.98px` (`useNavChrome.ts`,
  `AppFrame.module.css`): below it the sidebar becomes a drawer and the content
  is full width. The contact and conversation detail layouts switch at 860px
  (`twoPaneShell`). Two components use a `max-width: 599px` phone query
  (`contact/Modal.module.css`, `ui/imageViewer/ImageViewer.module.css`).
- A failed background reconcile sets `status: 'error'`, which blanks the list
  into "We couldn't load your inbox." (filed:
  `docs/issues/inbox-reconcile-failure-blanks-list.md`, a product decision
  awaiting a ruling). A 404 sets `status: 'pending'` and ALSO empties `base`.
  `retry()` sets `status: 'loading'` before refetching. A failed `loadMore`
  keeps the cursor and re-enables the button silently.
- Server hydration is sequential: the pager loop in `aggregateInbox` awaits
  `rowForConversation` per conversation, and each one awaits, inside ONE
  try/catch, `findByPhone` and then (only if that found nothing) `findByEmail`
  (an error in either sets the contact to undefined with a WARN and skips the
  rest), then the contact's conversation set (`contactConvsCache`, a VALUE
  cache with a check-then-await-then-set shape, shared with the unread branch,
  which also deletes entries for its lagged-retry re-read), and
  `latestMessageOf` (an uncached `messages.listByConversation(id, { limit: 1 })`
  whose result is DERIVED against the conversation image passed in:
  `deriveLatest` falls back to that image's `last_message_preview`). A 100-row
  page is roughly 300 sequential DynamoDB round trips. The `emittedContacts`
  dedupe check and add live INSIDE `rowForConversation`, as does the
  `dropped(...)` telemetry.
- The row is a single flex line at every width: dot, `.head` (name, chip,
  tags; `flex: 0 0 auto`, name `white-space: nowrap`), preview (ellipsized),
  count, then the `.actions` box (Mark read / Mark unread). The actions box is
  ALWAYS in layout (`opacity: 0`, `flex: 0 0 auto`, `padding-right`), revealed
  on hover, focus-within, or swipe; its width varies by row (one button, the
  other button, or none on deleted/closed rows). `.row` is `overflow: hidden`,
  so an over-wide row clips silently. `InboxRow.module.css` and
  `Inbox.module.css` contain no media queries.
- The dashboard's lint config carries `react-hooks/refs` (writing a ref during
  render is an error) and `react-hooks/set-state-in-effect`; existing code
  writes "latest handler" refs from a passive effect (`useEventStream.ts`).
- The contact timeline already has `formatTime` ("9:14a") and
  `formatDayDivider` ("Mon Jun 8") in `dashboard/src/routes/contact/format.ts`.
  The inbox does not reuse them (decision 5 below). The `en-US` formatters may
  emit U+202F before `AM`/`PM` on ICU 72+ hosts; the app already normalizes
  that in `app/src/lib/localTime.ts` (`toAscii`). Node 24.14.1 emits U+0020;
  the Playwright-bundled Chromium is unverified.
- The session identity is `me.userId` (`useMe` / `AuthContext`). `AuthGate`
  renders its children only while authenticated; `useAuth()` throws without a
  provider, and the existing inbox hook tests mount no provider.
- The page-performance harness (`e2e/performance/`) reads the inbox as a
  measured surface. Its self-QA asserts, per inbox sample in full mode, that
  exactly one initial inbox page request finished at evidence capture, and that
  no inbox request for a measured surface carried a `cursor` query key. Cold
  samples arrive by `page.goto`; warm samples `goto` a source page and click
  one link or tab to the target.
- The lean e2e seed holds exactly one contact 1:1 (Tasha Nguyen), one group
  text and one `connecting` relay group, all dated 2026-06-01. Sibling inbox
  specs send as Tasha and convert the relay group, and several reseed in their
  own setup.
- `SEEN_SET_MAX` (100) equals `MAX_INBOX_LIMIT` (100); the depth cap is a
  strict `>` comparison, so a 100-row Unread page mints a cursor
  (`docs/issues/seen-set-max-equals-max-inbox-limit.md`). Today the dashboard
  never requests 100; after this spec it does.

## 3. Locked product decisions (Cameron, 2026-09-25)

1. Page size 100 (the server's maximum) AND auto-load on scroll, with the Load
   more button kept as the fallback affordance.
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
   is dark and semibold, a read row's time is muted. Sam reviewed the mockups
   (https://claude.ai/artifact/33RDvWfTxELDupEsQv7CzW) on 2026-09-25 and
   approved them as drawn: times aligned in a column at the right edge on
   desktop, two-line rows on the phone. Section 5.4 is the build contract; the
   mockup is the approval record.
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
   in-memory store keyed by operator, filter and page size, restored on mount
   and then reconciled.
7. A failed background refresh keeps the rows AND shows the failure: a banner
   above the list with a Retry button. Never a silent stale list, never a blank
   error state over rows that were fine. A server answer that is NOT a failure
   (a budget exit that returned no rows) is not shown as one. This resolves
   `inbox-reconcile-failure-blanks-list`.
8. The dashboard honors an optional `limit` query parameter on `/inbox`
   (1..100, default 100; out-of-range or non-numeric values FALL BACK to 100,
   the same rule the server applies below its range). It is the Playwright seam
   for proving paging without seeding 100 conversations and a no-deploy tuning
   knob if 100 proves slow for Sam.
9. Bounded-concurrency PREFETCH of the per-row reads on the server's
   `filter=all` page, keeping the decision loop, emission order, dedupe and
   drop telemetry byte-identical (section 5.10). Separable: if the plan review
   finds it cannot be made equivalent, it is dropped and filed.

Design consequence, not a product decision (section 5.5): the "rows survive a
live update" guarantee is delivered by a head-plus-tail model on the two tabs
whose page one is cut by `lastActivityAt` (All, Groups). On Unread and Unknown,
whose page one is cut by a different key, a COMPLETE refresh replaces the list
with its fresh page one, and an INCOMPLETE refresh (a budget exit, a
truncated page) merges its rows in and never removes anything. Scroll position
is kept on every tab.

## 4. Scope

### 4.1 In scope

- `dashboard/src/routes/inbox/useInbox.ts`, `Inbox.tsx`, `InboxRow.tsx`, their
  CSS modules and tests; new modules under `dashboard/src/routes/inbox/`:
  `inboxTime.ts` (pure formatter), `inboxListStore.ts` (the store),
  `useAutoLoad.ts` (the observer hook), `inboxListMerge.ts` (the pure merge of
  5.6 and the pure re-walk fold of 5.8, unit-tested on their own).
- `dashboard/src/app/AuthGate.tsx` (the store clear, 5.8) and, if no optional
  accessor exists, `dashboard/src/app/AuthContext.tsx` (an additive
  `useOptionalAuth()` that returns `undefined` without a provider).
- `app/src/routes/inbox.ts`: the `filter=all` pager's prefetch only (5.10). No
  wire-shape change. No change to the relay or group merge, the unread branch,
  the unknown branch, cursors, or limits.
- `e2e/tests/dashboard-next/`: a new `inbox-rows-timestamps.spec.ts`; existing
  inbox specs are re-run unchanged and must stay green.
- `e2e/performance/`: enumerated as a reader (5.11); no change expected, the
  hermetic `npm run perf:pages` self-QA is a mission gate.
- `docs/issues/`: resolve `inbox-reconcile-failure-blanks-list`; update the
  reachability paragraph of `seen-set-max-equals-max-inbox-limit`; file the
  follow-ups in section 9.

### 4.2 Out of scope

- One timeline across one-on-one, relay and group rows (tracker #24).
- Any edit to these files, which three live branches own
  (`feat/share-skip-fix`, `feat/retry-send-window`,
  `feat/send-outcome-reconcile`): `app/src/services/sendMessage.ts`,
  `app/src/services/scheduledSendSuppression.ts`,
  `app/src/routes/broadcasts.ts`, `app/src/repos/broadcastsRepo.ts`,
  `app/src/repos/messagesRepo.ts`, `app/src/repos/conversationsRepo.ts`,
  `app/src/jobs/broadcastFanOut.ts`, `app/src/jobs/retrySend.ts`,
  `app/src/jobs/relay*.ts`, `app/src/adapters/messaging.ts`,
  `app/src/routes/webhooks/twilio.ts`, `app/src/routes/api.ts`,
  `app/src/routes/contactTimeline.ts`, `app/src/lib/import/**`,
  `app/src/lib/seed/**`, `dashboard/src/routes/contact/Timeline.tsx`,
  `dashboard/src/routes/contact/deliveryStatus.ts`,
  `dashboard/src/routes/broadcasts/**`, `RUNBOOK.md`. The hub files
  `dashboard/src/api/types.ts`, `client.ts`, `endpoints.ts` may take ADDITIVE
  edits only. If the plan finds it needs one of the excluded files, it stops
  and asks.
- The contact timeline's time format.
- Changing the server's `DEFAULT_INBOX_LIMIT`, `MAX_INBOX_LIMIT`,
  `GROUP_PAGE_ONE_LIMIT`, `SEEN_SET_MAX`, or any cursor encoding.
- Virtualized rendering. At 100-300 rows of one `<li>` each the DOM is small;
  5.2 bounds auto-load so the DOM cannot run away.
- A periodic re-render to roll "2:14 PM" over to "Yesterday" at midnight. Labels
  are computed at render time; a reconcile (any inbox event) or a navigation
  re-renders them. The contact timeline accepts the same thing.
- Refreshing a loaded tail row for a NON-activity change while the operator
  stays on the page (another operator's read, a rename or deletion made
  elsewhere). Section 5.8 refreshes the whole list on every return to the
  page; section 8 states the residue.
- Re-reading rows past page one on Unread and Unknown after a return: those
  tabs replace their list with page one on the first complete refresh (5.6),
  so a return there restores instantly and then shows page one. Re-reading
  their tail would be a new decision; it is not made here.
- Tenant-facing or catalog copy. None exists here.

## 5. Design

### 5.1 Page size and the `limit` parameter

- `useInbox(filter, limit, operatorId)` takes the page size and the operator
  id as parameters. `Inbox.tsx` reads `limit` from the URL search params
  through a pure `limitFromParam(raw)` beside `filterFromParam`: an integer
  1..100 is honored; anything else (absent, empty, `0`, `-5`, `abc`, `1000`)
  falls back to `DEFAULT_PAGE_LIMIT = 100`. `MAX_PAGE_LIMIT = 100` is a named
  client constant with a comment pointing at the server's `MAX_INBOX_LIMIT`.
  `Inbox.tsx` reads the operator id through `useOptionalAuth()` (`me.userId`,
  or `'anon'` without a provider, so the existing tests that mount no provider
  keep working).
- `selectFilter` and the groups-truncation link (`/inbox?filter=groups`) both
  preserve a `limit` param that is present, so a tuned link keeps its size
  across tabs. `Inbox.tsx` builds that link from the current params instead of
  a hard-coded string. The sidebar's Inbox link and the nav badge navigate to
  a bare `/inbox` and therefore reset to the default: the knob is a URL you
  open (or bookmark), not a setting.
- Every `getInbox` call from the hook uses the hook's `limit`: the initial
  load, Retry, the SSE reconcile, the mount reconcile, the tail re-walk, and
  `loadMore`.

### 5.2 Auto-load on scroll

Ownership: `useInbox` owns the ARMED flag (`autoLoadArmed` in `InboxState`,
persisted in the store) and a `pageEpoch` counter (`InboxState.pageEpoch`,
bumped ONLY by a committed head read, a committed `loadMore` page, and the
re-walk's final commit; never by a mark-read/unread commit, the reset, or a
failure); `Inbox.tsx` owns the DOM (the sentinel and the scroll container) and
mounts `useAutoLoad`.

- A sentinel `<div aria-hidden="true">` sits after the list and before the Load
  more button, rendered only while `hasMore`. It is empty and not focusable.
  The button keeps its current copy and gating.
- `useAutoLoad({ sentinelRef, root, enabled, onLoad, epoch })`:
  - creates ONE `IntersectionObserver` per mount of the sentinel (root = the
    page's scroll container, resolved once at mount as the nearest scrolling
    ancestor of the list; `rootMargin: '400px 0px'`) whose callback does ONE
    thing: `setIntersecting(entry.isIntersecting)`. No ref is written during
    render and no handler is captured in the callback, so the repo's
    `react-hooks/refs` rule is satisfied and there is no stale closure.
  - fires from an EFFECT over `[intersecting, enabled, epoch]`: when
    `enabled && intersecting` and EITHER `intersecting` just became true OR
    `epoch` differs from the epoch at the last fire, it calls `onLoad()` once
    and records `epoch` as the last-fired epoch. `onLoad` is the current
    `loadMore` by construction (effects see current props).
  - never fires otherwise. In particular a change of `enabled` alone (for
    example `loadingMore` flipping back to false after a FAILED page, or
    `hasMore` appearing after a head read while the sentinel was already
    intersecting) does not fire, because neither `intersecting` transitioned
    nor `epoch` changed. A head read that installs a cursor also bumps the
    epoch, so the second of those cases fires through the epoch arm once,
    which is the wanted single load.
- `enabled = hasMore && autoLoadArmed && !loadingMore`.
- The Inbox PAGE ROOT (`.page`, the only child of the scroll container while
  the Inbox is mounted) gets `overflow-anchor: none`. That excludes the entire
  page subtree - list, sentinel, button, notices - from anchor selection, so
  the scroller has no anchor candidate and rows inserted above the viewport
  (a fresh head row, or an appended page that sorts above page one's old
  group rows) push the content and the sentinel DOWN instead of the browser
  raising `scrollTop` to hold something in place. On the `<ul>` alone the
  exclusion would leave the Load more button as the anchor and the chain
  would survive (section 2). Consequences: a committed page of `limit` rows
  pushes the sentinel `limit` row-heights further away, so after a full page
  the sentinel is outside the margin and the epoch-driven re-check finds
  `intersecting` false; only a SHORT page in pixels (a budget exit, a tiny
  `?limit`, or the end of the feed, where `hasMore` goes false anyway) can
  leave it inside the margin and continue, which is the wanted behavior on a
  budget exit and the expected behavior at a tiny `?limit`. A head read that
  inserts one row moves the operator's reading position by one row height,
  the same as the Messages app.
- ARMING RULE, in the hook. `autoLoadArmed` is set from the result of the read
  that installs the CURRENT cursor chain: every committed `loadMore`
  (`true` iff its page delivered at least one row AFTER dedupe), the re-walk's
  final commit (`true` iff its last page delivered a row), and every committed
  head read that REPLACES the chain (the initial load; a complete head read on
  Unread and Unknown; a head read on All and Groups when the paged tail is
  empty). A head read that keeps a paged tail leaves it unchanged, because the
  tail's cursor and the last page result it describes are still the live
  chain. A failed page leaves it unchanged.
- Consequences, each pinned by unit tests:
  - an empty page with a cursor (the Unknown tab's budget exit) disarms; the
    epoch did not change (nothing committed), so nothing re-fires; the manual
    button stays with `emptyMoreCopy()` beside it. A manual click that returns
    rows re-arms and bumps the epoch;
  - a FAILED `loadMore` keeps the cursor, re-enables the button, does not
    bump the epoch, and so does not retry until the sentinel leaves and
    re-enters the margin or the operator clicks;
  - a head read that discarded an in-flight `loadMore` bumps the epoch, so if
    the sentinel is still inside the margin the page is re-issued once;
  - a restored list restores `autoLoadArmed`; on Unread and Unknown the first
    complete head read replaces the chain and re-arms from its own result,
    which is right because the restored cursor is discarded with the old
    chain.
- In jsdom (`IntersectionObserver` undefined) the hook installs nothing and the
  button alone drives paging. Unit tests inject an observer factory through an
  optional hook argument; Playwright exercises the real one, including the
  group-wall shape (7.3 test 6).

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
  (the conversation's `last_activity_at`, not a `#`-suffixed sort key), so
  `isoOf` is applied only for symmetry with the other formatters.
- A future instant (clock skew) falls into the same-day tier if it is today,
  else the date tiers; nothing special.
- Both helpers replace U+202F (and U+00A0) in the formatter output with a
  plain space, the way `app/src/lib/localTime.ts` does, so the label is
  `2:14 PM` with U+0020 on every host; the unit tests and the e2e regexes
  assert the plain space.
- The label reads the conversation's last ACTIVITY (section 2): a relay retry
  bump can put it minutes after the previewed message. The title shows the
  exact instant.

### 5.4 The row

`InboxRow.tsx` renders, inside the existing `Link`, after the count pill:

```
<time className={styles.time} dateTime={row.lastActivityAt} title={full}>
  {label}
</time>
```

- Desktop (default styles): `flex: 0 0 auto; min-width: 5rem; text-align:
  right; white-space: nowrap; font-size: var(--fs-xs)` (5rem holds
  `Dec 18, 2025` at 12px). Read rows: `color: var(--c-text-muted)`. Unread
  rows (`.unread .time`): `color: var(--c-text); font-weight:
  var(--fw-semibold)`.
- THE NAME CAN SHRINK in the one-line layout. `.head` (a direct child of the
  link) becomes `flex: 0 1 auto; min-width: 0; max-width: 45%` - the
  percentage resolves against the link, its flex container - and `.name`
  becomes `min-width: 0; overflow: hidden; text-overflow: ellipsis` (it keeps
  `white-space: nowrap`). Chips and tags keep `white-space: nowrap` and never
  shrink. An ordinary name in a wide row is NOT ellipsized (its head is far
  below 45%); only a long name in a tight row is. The preview, the count and
  the time therefore always keep their room and the time is never clipped by
  `.row { overflow: hidden }`.
- THE ACTIONS BOX LEAVES THE LAYOUT. `.actions` becomes an overlay: `position:
  absolute; right: var(--sp-3); top: 50%; transform: translateY(-50%)`, with a
  `background: var(--c-surface)` and a small left padding so it reads as a
  panel over the row's right end, `pointer-events: none; opacity: 0` until
  revealed on hover, focus-within or swipe exactly as today. It takes no width,
  so the times line up in one column on every row, whatever button the row
  offers. While revealed it covers the time, which is the Gmail convention and
  what Sam approved. The row keeps `position: relative` (it already has it).
  The button's tab order and accessible names are unchanged.
- Narrow (`@media (max-width: 767.98px)` in `InboxRow.module.css`, the shell's
  own query value, the first media query in the inbox styles): the link
  becomes a two-row grid. Row one: dot, name (ellipsized, `min-width: 0`),
  chip, tags, time at the right (`min-width: 0`, `white-space: nowrap`). Row
  two: preview (ellipsized) and the count pill at the right. Inside the query
  `.head` resets to `max-width: none` (the 45% cap is a one-line rule; on a
  360px row it would cap the name area at about 125px). The `<time>` keeps
  the same element and classes; only its grid placement changes. No element
  is duplicated for the two layouts. The actions overlay is revealed by swipe
  as today and covers the row's right end.
- The breakpoint matches the shell's: below it the sidebar is a drawer and the
  content is full width but narrow (a phone, or a drawer-mode tablet), and a
  one-line row with a time does not fit reliably under about 500px of row
  width. Above it the sidebar takes 240px and the content is at least about
  480px wide, where the one-line layout with the shrinking name fits; 768px
  is its tightest band and 7.3 tests it there. The 599px query two components
  use is a phone-only query for modals; this row's question is "is there room
  for one line", which is the shell's breakpoint, so the two are not aligned
  on purpose.
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

### 5.5 The list model

`useInbox` keeps ONE list-state object, mirrored in a ref that is the
authoritative value for every computation, and in React state for rendering:

```
interface ListState {
  head: InboxRowData[];   // the server's page one as of the last head read, in server order,
                          // plus (All only) additive rows kept across a head read (5.6)
  tail: InboxRowData[];   // PAGED rows only: rows from loadMore pages in load order, plus
                          // (All/Groups) paged rows that slid out of the head; deduplicated
                          // by rowKey; never holds an additive row
  cursor: string | null;  // the position after the last row of head ++ tail;
                          // null means the loaded list reaches the end of the feed
  groupsTruncated: boolean;
  truncated: boolean;
  autoLoadArmed: boolean;
  pageEpoch: number;      // bumped per 5.2
}
base = [...head, ...tail]   // what serverRowCount, the notices and the Unread narrowing read
```

- `commitList(next)` is the ONLY writer: it sets `listRef.current = next`,
  calls `setList(next)`, and, when `aliveRef.current` is true and
  `statusRef.current === 'ready'`, saves the snapshot to the store under
  `keyRef.current` (5.8). Every mutation (head merge, `loadMore` append, the
  re-walk fold, the optimistic commit and rollback in `markRead`/`markUnread`,
  the reset) computes `next` from `listRef.current` synchronously and calls
  `commitList`. No functional `setState` updater touches the list, so the
  saved snapshot is exactly the committed value and never a pre-commit list
  with a post-commit cursor.
- `pending` (the optimistic patches) is mirrored in `pendingRef`, written
  synchronously by `setPatch`/`clearPatch` alongside the state update, so the
  unmount save can read the patch a row click made in the same render that
  navigated away (section 2: that update and the navigation batch into one
  render).
- `aliveRef` is set TRUE in the body of the hook's mount effect and FALSE in
  its cleanup, so a StrictMode simulated unmount/remount leaves it true for
  the live instance. `loadMore`'s controller is aborted in the cleanup too. A
  `loadMore`, re-walk page, `markRead` or `markUnread` that settles while
  `aliveRef` is false neither commits nor saves.
- THE RESET (filter or limit change) first sets `status: 'loading'` through
  `applyStatus`, THEN commits an empty `ListState`; because the save is gated
  on `statusRef === 'ready'`, the reset never writes an empty snapshot under
  the new key or the old one.
- `loadMore` appends its page to `tail` DEDUPLICATED against the current
  `base` by `rowKey` (a row already present is skipped), installs its cursor,
  bumps `pageEpoch`, sets `autoLoadArmed` to whether the page delivered at
  least one NEW row, and keeps its two staleness guards. The dedupe closes the
  seen-set gap on Unread: a kept cursor's seen-set never learned the contacts
  a later head read emitted, so a multi-thread contact that surfaced in the
  head can be emitted again by the next page. Today's list is not deduped on
  append because today a head read always resets the cursor.
- A HEAD READ (initial load, Retry, SSE reconcile, mount reconcile) requests
  `limit` rows and merges per 5.6. The head read is never larger than page
  one, so `?limit=` tunes every read, not only the first.
- `pending` patches overlay `base` as today; the Unread narrowing and the sort
  produce `rows` as today.

### 5.6 The head-read merge (`inboxListMerge.ts`, pure)

Inputs on a committed head read: `P` (its rows), `C` (its cursor), its
`truncated` and `groupsTruncated` flags, the current `ListState`, `limit`,
`filter`. Definitions shared by every branch:

```
additive(row)  := filter === 'all' && (row.kind === 'relay_group' || row.kind === 'group_text')
pagedP         := P.filter(r => !additive(r))
headComplete   := !truncated && (C === null || pagedP.length >= limit)
                  // a truncated page, or a short page with a cursor, stopped early and
                  // says nothing about absent rows
inP            := Set(P.map(rowKey))
convsInP       := Set(P.map(r => r.conversationId).filter(defined))
```

**Branch I (incomplete head, every filter).** The read stopped early (a budget
exit or a truncated page, on any tab), so absence proves nothing:

```
head   := dedupeByRowKey([ ...P, ...head.filter(r => !inP.has(rowKey(r))) ])
tail   := tail.filter(r => !inP.has(rowKey(r)))
cursor := (head.length + tail.length was > 0 before this read) ? cursor : C   // keep the old
                                                                            // cursor, INCLUDING null;
                                                                            // a list that had nothing
                                                                            // takes the read's cursor
autoLoadArmed := unchanged (or P.length > 0 when the list was empty)
flags  := from the page
```

Nothing is removed and nothing is flagged as a failure: a zero-row budget
exit on Unknown is a normal server answer (section 2). If the list was empty
before, the result is exactly today's rendering of that page (`emptyMoreCopy`
beside a live Load more). Rows kept this way are re-examined by the next
complete head read.

**Branch R (complete head; `filter === 'unread'` or `'unknown'`).** Page one
on these tabs is not cut by `lastActivityAt` (section 2), so no "slid out"
inference is sound; a complete page one is the truth:

```
head := P; tail := []; cursor := C
autoLoadArmed := P.length > 0
flags := from the page
```

On Unread, page one (100 rows) is the badge cap, so a replaced tail is the
uncommon case. On Unknown, the queue is the set of untriaged numbers and page
one is its front; the tab exists to triage the newest, and rows past page one
are re-reachable through Load more, so replacing is the honest rendering of a
queue whose order the client cannot reason about. The store still restores
rows instantly on both tabs and the scroll position is kept (it clamps if the
list shrank).

**Branch P (complete head; `filter === 'all'` or `'groups'`).** Page one is
the newest `limit` paged rows by `lastActivityAt` plus (All) the additive
rows:

```
boundary        := min(lastActivityAt) over pagedP, or undefined when pagedP is empty
hasKind(k)      := P.some(r => r.kind === k)
oldestGroupInP  := min(lastActivityAt) over P.filter(kind === 'group_text'), or undefined

keepAdditive(oldRow):                                   // old HEAD additive rows only
  if inP.has(rowKey(oldRow))                    -> false // P's fresh copy wins
  if oldRow.conversationId in convsInP          -> false // the same conversation came back under
                                                         // another kind (relay converted to group
                                                         // text in place): never show it twice
  if !hasKind(oldRow.kind)                      -> true  // no row of that kind came back: a swallowed
                                                         // relay-list failure or an empty budget looks
                                                         // identical to "all closed"; keep rather than
                                                         // blank (residue in section 8)
  if oldRow.kind === 'group_text' && groupsTruncated
     && oldestGroupInP !== undefined
     && oldRow.lastActivityAt <= oldestGroupInP -> true  // outside the page-one cap, not gone
  return false                                           // returned every read; absence means closed,
                                                         // converted or gone

keepPaged(oldRow, wasInHead):
  if inP.has(rowKey(oldRow))                    -> false
  if C === null                                 -> false // the feed ended inside the head; gone
  if !wasInHead                                 -> true  // a loadMore row; the head says nothing
  return boundary !== undefined && oldRow.lastActivityAt <= boundary
                                                         // slid out of page one (ties kept: losing a
                                                         // live row costs more than carrying a gone
                                                         // one until the next return re-walks it)

keptAdditive := head.filter(r => additive(r) && keepAdditive(r))
newTail      := dedupeByRowKey([ ...head.filter(r => !additive(r) && keepPaged(r, true)),
                                 ...tail.filter(r => keepPaged(r, false)) ])
head         := [ ...P, ...keptAdditive ]                // kept additive rows stay HEAD rows
tail         := newTail
cursor       := newTail.length > 0 ? cursor : C          // a kept PAGED tail keeps ITS cursor,
                                                         // INCLUDING null (null + a tail = the list
                                                         // reaches the end; installing C would re-walk
                                                         // rows already on screen); kept additive
                                                         // rows do not count
autoLoadArmed := newTail.length > 0 ? autoLoadArmed : P.length > 0
flags := from the page
```

Why this delivers the guarantees on All and Groups:

- Rows that slid past the head boundary because newer activity arrived are
  KEPT (they move to the front of the tail), so an insertion at the top never
  makes a row vanish. They sit between the new head and the old tail in time
  order, and the tail's cursor still addresses the position after the old
  tail, so there is no gap in the cursor chain. The client sort by
  `lastActivityAt` renders them in place.
- Rows the server has stopped returning inside page one (a relay group that
  closed or was converted while other relay rows still return, a resurfaced
  soft-deleted contact after it was read, a contact whose threads all closed)
  are DROPPED. A dropped row's `unreadCount` no longer counts anywhere, which
  matches the badge. A converted relay group is dropped in favor of its
  group-text row under the same conversation, so a conversion never shows
  twice.
- A fully loaded list (`cursor === null`, paged tail non-empty) stays fully
  loaded across head reads: no spurious Load more, no re-walk of rows on
  screen. Kept additive rows never affect the cursor.
- On Groups no row is additive, so every row follows the paged rule, which
  matches the partition's `last_activity_at` order.

Invariant 1, stated honestly: on All and Groups a live update never removes a
row from the list unless a COMPLETE head read shows the server no longer
returns it inside page one; rows slide, they do not vanish. On Unread and
Unknown a complete head read replaces the list with its fresh page one. On
every tab an incomplete head read removes nothing, and no live update resets
the scroll position.

### 5.7 Refresh failure and Retry

`InboxState` gains `refreshFailed: boolean`.

- "Rows are rendered" means `status === 'ready' && base.length > 0`, read
  through refs at the moment a head read settles.
- A head read that FAILS (a rejected request: network error, 5xx, and the 404
  case below) while rows are rendered sets `refreshFailed = true` and leaves
  the list untouched. A 404 in that state is treated the same way (a proxy or
  deploy-window 404 must not blank a healthy list into the "pending" copy). A
  head read that fails with no rows rendered keeps today's behavior
  (`status: 'error'`, or `'pending'` on 404 with the list emptied). A head
  read that SUCCEEDS with an incomplete page is not a failure (5.6 branch I)
  and never shows the banner.
- Any committed head read clears `refreshFailed`. A filter or limit change
  clears it with the rest of the reset.
- `retry()`: with rows rendered it runs a head read WITHOUT entering
  `'loading'` (the rows stay, the banner stays until the read commits or fails
  again); with no rows it sets `'loading'` and fetches as today. A retry that
  fails with rows present leaves `refreshFailed` true and `status` `'ready'`,
  so the banner and its button remain: no spinner can strand the tab.
- `Inbox.tsx` renders, when `refreshFailed && status === 'ready'`, a banner
  above the list, `role="status"` (not `alert`: nothing was lost), copy
  "Couldn't refresh the inbox." with a button labelled `Retry refresh`
  (distinct from the existing error surface's `Retry`, so the two never share
  an accessible name). It sits above the truncation notices, below the tabs.
- The banner does not disable Load more or the rows. A `loadMore` failure
  keeps today's silent behavior; it is not routed through the banner.
- `docs/issues/inbox-reconcile-failure-blanks-list.md` is set to `resolved`
  with a Resolution block naming this section.

### 5.8 The list store, save, restore and re-walk

New module `dashboard/src/routes/inbox/inboxListStore.ts`, module-level state
(a `Map`), no React:

```
key: `${operatorId}:${filter}:${limit}`   // operatorId = me.userId, or 'anon' without a provider
snapshot: {
  head, tail: InboxRowData[];   // server order, NOT narrowed, NOT sorted, with the pending
                                // patches folded in at save time (`patched` shape)
  cursor: string | null;
  groupsTruncated: boolean;
  truncated: boolean;
  autoLoadArmed: boolean;
  scrollTop: number;
}
```

- `save(key, snapshot)`, `load(key)`, `clear()`. `clear()` runs from a
  PASSIVE effect in `AuthGate` that fires when the session transitions to
  unauthenticated. React deletes parent-first, so a cleanup in `AppFrame`
  would run BEFORE the Inbox's unmount save and the save would repopulate the
  store; a passive effect in the surviving parent runs after every deleted
  child's cleanup, so it runs after the save. The operator id in the key is
  the second lock, and `aliveRef` (5.5) is the third: a request that settles
  after unmount cannot write. A full page load starts empty by construction.
- WHEN TO SAVE: only from `commitList` (5.5) and the unmount save below, both
  gated on `statusRef.current === 'ready'` and `aliveRef`, both capturing the
  key from `keyRef` at that moment. Hence an empty pre-first-page snapshot is
  never written (a StrictMode simulated unmount before the first page commits
  finds `status: 'loading'` and skips), a save can never land under a filter
  the state does not belong to, and the saved rows are the committed rows.
- THE UNMOUNT SAVE runs from a LAYOUT-effect cleanup (it runs before the
  replacing route's DOM commits) and writes the list from `listRef` with the
  `pendingRef` patches folded in, and `scrollTop` from `scrollTopRef`, which a
  passive `scroll` listener on the container keeps current. `scrollTopRef` is
  SEEDED at mount with the restored snapshot's value ONLY when that value is
  about to be applied (a `POP` arrival, below), and with 0 otherwise, so a
  StrictMode simulated unmount or an exit before any scroll event saves the
  position this visit actually showed. Reading `scrollTop` from the container
  at passive-cleanup time reads 0 (section 2), so that is never done.
- RESTORE ON MOUNT. `useInbox` initializes its state lazily from the store:
  if `load(key)` returns a snapshot, the FIRST render already has the list
  and `status: 'ready'` (no spinner). A `restoredKeyRef` starts as that key
  (or `null` on a miss), and a `rewalkDueRef` starts as `true` on a hit.
- THE FILTER EFFECT'S RULE: on every run, if `key !== restoredKeyRef.current`
  it performs today's reset and initial fetch; otherwise it schedules a head
  read immediately (no debounce) as a reconcile. In both cases it then sets
  `restoredKeyRef.current = key`. A StrictMode mount/cleanup/mount replay of
  the same key therefore takes the reconcile branch on its second run and
  never resets a restored list, while a real filter change (different key)
  resets. On a store miss the first run resets and fetches, the cleanup aborts
  that fetch, and the replay's reconcile issues the one live fetch.
- THE TAIL RE-WALK (All and Groups only; the first complete head read on
  Unread/Unknown replaces the tail, so nothing is owed there). It runs ONCE
  per store restore, triggered by the FIRST head read that COMMITS after the
  restore (the mount reconcile normally; a Retry or an SSE head read if that
  one failed), when the committed state holds a non-empty PAGED tail.
  Mechanics, as a pure fold in `inboxListMerge.ts` plus the hook's loop:
  - it holds `loadingMore` for its duration, so auto-load and the button wait
    (the sentinel effect sees `enabled` false), and no `loadMore` can race it;
  - let `start` be the committed head's cursor and `oldest` the oldest
    `lastActivityAt` in the current tail; it requests pages from `start`
    (each a normal `loadMore`-shaped read of `limit` rows) until the page's
    cursor is null, or the page's oldest row is at or older than `oldest`
    (the walk has covered the tail's range), or `REWALK_MAX_PAGES = 5` pages
    have been read; intermediate pages are accumulated, not committed;
  - the FOLD, committed once at the end: `fresh` is the accumulated rows
    deduplicated against the CURRENT head (a head read may have landed
    meanwhile; branch P kept the tail, so the fold applies to the current
    state). The new tail is `fresh` followed by the current tail rows that
    are OUTSIDE the walked range, where the walked range is
    `[freshOldest, freshNewest]` by `lastActivityAt` and `freshNewest` is
    the newest row of the first re-walk page: rows newer than the range are
    rows a meanwhile head read slid into the tail (kept, unexamined), rows
    older than the range exist only when the page cap stopped the walk
    (kept, unexamined). Current tail rows INSIDE the range that no page
    returned are dropped: that is the operator's triaged, renamed, deleted or
    otherwise-read row refreshing. `cursor` becomes the last page's cursor
    when the walk reached the end or covered the range, and stays the current
    cursor when the page cap stopped it. `pageEpoch` bumps once; arming is set
    from the last page;
  - abandonment: a filter or limit change, or unmount (`aliveRef`), abandons
    it (nothing is committed). A head read landing meanwhile does NOT abandon
    it; the fold accounts for that read as above. A page failure ends the
    walk early and folds what was read (a partial refresh beats none).
  It costs one request per `limit` rows of tail (typically zero or one), runs
  behind the already-rendered list, and keeps the scroll position. It is what
  makes a return to the page show the operator's own triage, rename or
  deletion on a tail row, and another operator's reads. While the operator
  stays on the page, a tail row refreshes only through activity (which moves
  it into the head); non-activity changes wait for the next return or reload
  (section 8).
- Scroll restore: `Inbox.tsx` sets the container's `scrollTop` from the
  snapshot in a layout effect on the first render that has rows, only when the
  mount came from the store AND `useNavigationType()` is `POP` (the back or
  forward button). A `PUSH` arrival (the sidebar's Inbox link, the nav badge,
  a programmatic navigate) restores the ROWS instantly but starts at the top:
  an operator who clicks Inbox because the badge says there is new unread must
  land on the new rows, not at row 180. The container is resolved the same
  way 5.2 does.
- A return to `/inbox` with a DIFFERENT filter or limit than the one saved
  starts as a fresh load for that key; the other key's snapshot is kept for its
  own return.
- A return after the operator marked a row read on its contact page shows the
  restored (pre-mark) count for one round trip until the mount reconcile (or
  the re-walk, for a tail row) commits. Today a fresh mount shows a spinner
  instead; the brief stale count is the accepted price of an instant return.

### 5.9 Group and relay rows

No change to paging. `InboxRow` renders the time for `relay_group` and
`group_text` rows from their `lastActivityAt` exactly as for contact rows.
`groupsTruncated`, `groupRowsShown`, the notices and the Groups filter are
unchanged.

Consequence to state plainly: on the All tab, page one's group and relay rows
can be older than the contact rows an auto-load appends, and the client sorts
by time, so appended pages interleave ABOVE those old group rows rather than
landing at the bottom. With `overflow-anchor: none` on the page root (5.2) the
inserted page pushes the group rows and the sentinel down by the page's
height, so the sentinel leaves the margin and auto-load does not chain; "the
bottom of the list" can stay old group rows until the loaded one-on-ones reach
their dates. That is exactly what tracker #24 would change; this mission does
not.

### 5.10 Server: prefetch the per-row reads on `filter=all`

The decision loop in `aggregateInbox`'s open-partition pager (the sequential
`for` over each `listByLastActivity` chunk that awaits `rowForConversation`)
is NOT restructured. Its order, its `emittedContacts` check and add, its
`dropped(...)` telemetry, its page-fill and cursor bookkeeping, and the
`inbox feed assembled` log line all stay byte-identical. What changes is where
the reads it awaits come from:

- Three per-request caches memoize PROMISES keyed by their input, storing the
  in-flight promise before awaiting it, so two callers for one key share one
  read (this also closes the check-then-await-then-set race):
  - `resolveContact(phone, email)`, keyed `${phone}|${email}`, which performs
    EXACTLY today's block - `findByPhone`, then `findByEmail` only if that
    found nothing, inside one try/catch that resolves to `undefined` with the
    same WARN on any error. `rowForConversation` calls it in place of its
    inline block, so the sequential path's behavior (including "an error in
    the phone lookup skips the email lookup") is unchanged;
  - `contactConvsCache`, converted from values to promises; its lagged-retry
    `delete` keeps working because deleting a promise entry forces the next
    caller to re-read;
  - a NEW raw-message cache over `messages.listByConversation(id, { limit: 1 })`
    keyed by conversation id. `latestMessageOf` reads the raw page through it
    and still derives against the conversation image IT was given, so the
    derived preview is never shared between two images of one conversation.
  Rejections are never cached: each promise resolves to the degraded fallback
  the sequential path would have produced, with the same WARN.
- Before the loop consumes a chunk, a PREFETCH pass starts, for every
  conversation in the chunk that is not a `relay_group`/`group_text`, the chain
  `resolveContact -> contactConversations(contact) -> raw latest message` through
  those caches, with a concurrency window of `HYDRATE_CONCURRENCY = 8` (a small
  hand-rolled window; no new dependency). The window checks a `stop` flag
  before starting each chain; the loop sets it when the page fills or the
  chunk is exhausted, so no chain starts after the page is done (chains
  already in flight finish and are discarded). Prefetch results are never
  read directly; the loop hits the caches.
- The loop therefore performs the same awaits in the same order and takes the
  same branches; the only difference is that most awaits resolve immediately.
  Prefetches for conversations the loop never consumes are wasted reads,
  bounded by one chunk minus the `stop` cutoff.
- Telemetry: because the loop is unchanged, `drops`, the per-reason counts and
  the assembled line are identical for the same data. WARN lines for a
  degraded lookup are emitted once per key by the cache, so their COUNT can
  differ from today's only for conversations the loop never consumed; the
  equivalence test compares rows, order, cursor and the assembled-line counts,
  not WARN counts.
- The caches are closures shared with the unread branch today; converting
  them to promise caches changes nothing for that branch's callers (they
  `await` either way).
- A route test asserts the page for a fixture with multi-number contacts, a
  relay row, an unknown row, a soft-deleted resurfacing row, a contact whose
  conversation-set lookup fails (the `?? conv` fallback path), AND a
  conversation whose phone lookup throws (the email lookup must stay skipped)
  is IDENTICAL (rows, order, cursor, and the assembled-log counts) to the same
  request served with prefetch disabled through the router's deps; a second
  test proves the promise cache issues ONE read for two concurrent misses and
  memoizes the degraded fallback, never a rejection; a third proves the
  `stop` flag prevents new chains after the page fills.
- The unread and unknown branches are not touched and keep sequential
  hydration. Their pages also grow from 30 to up to 100 rows on every
  reconcile; unread rows are a triage set that is usually far short of 100,
  and `?limit=` tunes them too. If a measured Unread page is slow for Sam, the
  same prefetch pattern applies to that branch as a follow-up (section 9).
  This section is separable: sections 5.1-5.9 do not depend on it, and if the
  plan's reading of the pager finds a dependence this section did not, the
  plan drops it and files it.

### 5.11 The page-performance harness

`e2e/performance/` is a reader of the inbox's request pattern (section 2).
The design keeps its invariants without changing the harness:

- Cold samples navigate by `page.goto`, which resets module state, so the
  store is empty and exactly one initial page request is issued as today.
- Warm samples `goto` a SOURCE page and then click one link or tab to the
  measured target, so `/inbox` as a warm target is reached once per page
  session and the store is empty on arrival: the head read is the initial page
  request, as today. A snapshot would exist only if a flow visited `/inbox`
  twice in one page session, which no harness flow does. If one is ever added,
  readiness would resolve on the restored list before the head read finishes
  and the one-request count would read 0; the harness's inbox readiness would
  then need to await the head read for that flow.
- Auto-load fires only when the sentinel is within 400px of the viewport
  bottom; the perf seed's `filter=all` page is 100 rows tall, so it does not
  fire without a scroll, and the harness never scrolls. Its Unread/Unknown
  surfaces return short pages WITHOUT a cursor on the perf seed (the routes
  file records the budget exit as unreachable there), so `hasMore` is false and
  no sentinel renders.
- The hermetic `npm run perf:pages` self-QA is a gate for this mission (run
  from the worktree, bare, after the e2e gate). If it reports a count or
  cursor violation, the fix is in the harness's expectation only if the request
  pattern above is what it observed; otherwise the dashboard is wrong.

## 6. Invariants and the surfaces that touch them

Protected state: the `ListState` (5.5), `pending`, `refreshFailed`, and the
list store.

Writers (all through `commitList`): initial load, Retry, SSE reconcile, mount
reconcile (head reads); the tail re-walk's fold; `loadMore` (auto or manual);
`markRead`/`markUnread` optimistic patches and their commits/rollbacks; the
filter/limit-change reset; the unmount save; `clear()` on sign-out.

Readers/renderers: `Inbox.tsx` (rows, empty states, notices, banner, sentinel,
Load more gating, scroll restore), `InboxRow.tsx` (row + time + actions
overlay), `useAutoLoad` (reads `enabled`, `pageEpoch`), `UnreadContext` (badge
clears noted by `markRead`), the page-performance harness, and every e2e spec
that reads the inbox (`inbox*.spec.ts`, `group-text-inbox.spec.ts`,
`call-inbox-unread.spec.ts`, `group-text-conversion.spec.ts`).

Invariants the plan must carry as explicit tasks or watch items:

1. All/Groups: a live update never removes a row unless a complete head read
   shows the server no longer returns it inside page one; rows slide, they do
   not vanish. Unread/Unknown: a complete head read replaces the list with
   page one. Every tab: an incomplete head read removes nothing and is not a
   failure. No live update resets scroll.
2. Back from a contact or conversation page shows the same rows and scroll
   position instantly. On All/Groups it then reconciles with one head read
   plus the re-walk (one read per `limit` rows of tail), refreshing every row.
   On Unread/Unknown it then reconciles with one head read that replaces the
   list with page one, so rows past page one drop and the scroll clamps.
3. Auto-load never fires on a zero-row page with a cursor, never while
   `loadingMore`, never when `hasMore` is false, never re-tries a failed page
   without an intersection change or a manual click, and never chains past
   one page per commit unless the committed page was short in pixels.
4. A failed head read never blanks rendered rows; it shows the banner. A
   failed Retry with rows present keeps `status: 'ready'`. A successful but
   incomplete head read never shows the banner.
5. A failed initial load (no rows) shows the existing error surface, unchanged.
6. The Unread tab's client narrowing and the notices keep their server-quantity
   gating (`serverRowCount`, `truncated`, `groupsTruncated`); the store holds
   server-shaped rows so restoring never changes which empty copy renders.
7. Sign-out clears the store; a save never lands under a key the rows do not
   belong to; no snapshot is written before the first page commits or from a
   reset; nothing writes after unmount.
8. A fully loaded list stays fully loaded across head reads and across a
   return (no spurious Load more, no re-walk of rows on screen beyond the
   return's refresh).
9. A conversation never renders twice under two kinds.
10. The server page for `filter=all` is identical in rows, order, cursor and
    telemetry counts with and without prefetch.
11. The perf harness observes one page request per inbox sample and no cursor
    request.

## 7. Testing

### 7.1 Unit (Vitest, dashboard)

- `inboxTime.test.ts`: every tier; the boundaries built with LOCAL-time
  constructors (`new Date(y, m, d, h, min)`) so they hold under any runner
  time zone: 23:59 vs 00:01 across a local midnight; Dec 31 vs Jan 1 across a
  year; an instant whose UTC date differs from its local date, built as
  `new Date(y, m, d, 23, 30)` in a fixed-offset case guarded by
  `getTimezoneOffset() !== 0` (skipped with a stated reason when the runner is
  UTC); unparseable input; the U+202F normalization; the full-stamp helper.
- `inboxListMerge.test.ts` (the pure merge and fold): branch I on every
  filter - a short-with-cursor head merges its rows in and removes nothing,
  keeps the old cursor including null, and a zero-row budget exit with rows
  present changes nothing and flags nothing; with an empty list it yields the
  page as-is. Branch R - a complete head replacing the tail and cursor; the
  Unknown queue-order case (a new row inserted mid-page pushes the last row
  out and the list is exactly the fresh page one); the Unread multi-thread
  case. Branch P - additive rows dropped when absent while their kind
  returned, kept (in HEAD) when their kind did not return, a converted relay
  row dropped when its conversation returns as a group text, a group_text
  kept under `groupsTruncated` when older than the oldest in P; a slid head
  row (older than or equal to the boundary) kept in the tail and a
  boundary-or-newer absent head row dropped; a tail row kept; a `C === null`
  head dropping the paged tail; a null old cursor with a paged tail kept as
  null; kept additive rows not affecting the cursor or arming; dedupe of a
  tail row that reappears in P. The re-walk fold - rows inside the walked
  range not returned are dropped, rows newer (slid in meanwhile) and older
  (page cap) are kept, the cursor rules for end-reached, range-covered and
  cap-stopped, dedupe against a head that changed meanwhile.
- `useInbox.test.tsx` additions: every head read requests `limit`; the mount
  from store skips the spinner and issues exactly one LIVE head read under a
  StrictMode-style double effect run (the aborted first one is not counted);
  the re-walk runs after the first committing head read (also when the mount
  reconcile failed and a Retry commits), holds `loadingMore`, reads pages
  until the range is covered or the end, folds once, bumps the epoch once,
  and is abandoned on a filter change; saves happen only through
  `commitList`/the unmount save, only while ready, with the committed value
  (a loadMore commit saves the appended rows AND the new cursor together);
  the reset writes no snapshot; nothing commits or saves after unmount (a
  loadMore resolved post-unmount); `aliveRef` is true again after a
  StrictMode replay (a commit after the replay saves); the unmount save folds
  `pendingRef` in (a patch set in the same act as the unmount is saved) and
  writes the seeded `scrollTop` when no scroll event happened; `loadMore`
  dedupes against `base` and arms only on new rows; `pageEpoch` bumps on head
  and page commits and the fold, not on mark-read commits, resets or
  failures; `refreshFailed` set and cleared per 5.7 including the
  404-with-rows arm and the failing-retry-with-rows arm, and NOT set by an
  incomplete head; the no-rows failure still yields `error`.
- `useAutoLoad.test.tsx`: with an injected observer factory: one observer per
  mount; fires `onLoad` once when intersecting becomes true while enabled;
  does not fire when disabled; fires again on an `epoch` change while still
  intersecting; does not fire when only `enabled` changes (the failed-page
  case, and `hasMore` appearing without an epoch change); does not fire on an
  `epoch` change while not intersecting.
- `InboxRow.test.tsx` additions: the `<time>` element renders with `dateTime`,
  `title` and the label for contact, relay and group rows; unread vs read
  class; no element for an unparseable instant; the actions overlay keeps its
  buttons and names.
- `Inbox.test.tsx` additions: `limitFromParam` table; the banner and its
  `Retry refresh` call `retry`; the sentinel is present only with `hasMore`;
  scroll restore sets the container's `scrollTop` on a store-backed mount
  under `POP` and not under `PUSH` (a `MemoryRouter` with a pushed history
  entry versus a popped one); the groups link and `selectFilter` preserve
  `limit`; the page root has `overflow-anchor: none`.
- `inboxListStore.test.ts`: save/load/clear; keys differ by operator id.
- Every inbox test file that mounts the hook or the page calls the store's
  `clear()` in `beforeEach`: the store is module-level state and would
  otherwise make the existing `useInbox.test.tsx` cases order-dependent.
- `AuthGate.test.tsx` (or the closest existing test): the store is cleared
  after the authenticated subtree unmounts, proven by a child that saves from
  a layout-effect cleanup and a store that is empty afterwards.

### 7.2 Route (Vitest, app)

- `inboxFeed.test.ts` or a sibling: the 5.10 equivalence test (rows, order,
  cursor, assembled-log counts, including the throwing phone lookup), the
  one-read-for-two-misses cache test, the degraded-fallback memoization test,
  and the `stop`-flag test. The existing `filter=all` tests unchanged.

### 7.3 Playwright (`e2e/tests/dashboard-next/inbox-rows-timestamps.spec.ts`)

Hermetic `e2e:session` only, accessibility-first selectors, the lean profile.
The spec RESEEDS in `beforeEach` (the existing `reseed` fixture) and logs in
again, so it never depends on lane state left by sibling specs. Fresh parties
are minted per test with run-unique numbers (`registerParty` + `sendAsParty`);
any row left unread is marked read before the test ends. Under `filter=all`
at `?limit=N` the lean world renders `N` contact rows PLUS the seeded group
text and relay group rows; the assertions count accordingly. Request-log
assertions count FINISHED requests (StrictMode issues and aborts one extra
head read on every mount).

1. Times render. Seed one inbound now; the row's `<time>` (Playwright has no
   `time` role, so `row.locator('time')` scoped inside the row link) has
   `dateTime` equal to the row's `lastActivityAt` read once through the API
   request context, and text matching `^\d{1,2}:\d{2} [AP]M$`; the lean seed's
   June rows (Tasha, the group text) have text matching
   `^[A-Z][a-z]{2} \d{1,2}(, \d{4})?$` (year-agnostic on purpose so the spec
   survives January).
2. Paging and survival. Seed three fresh parties; open `/inbox?limit=2`; assert
   the two newest contact rows plus the two multi-party rows render and Load
   more is visible; scroll the container to the bottom; assert the remaining
   contact rows append (at `limit=2` every page is short in pixels, so the
   epoch rule chains to the end here BY DESIGN) and Load more disappears;
   then a new inbound for a fourth fresh party arrives and the list still
   holds every previously loaded row plus the new one at the top, with no
   spinner shown in between: take an `ElementHandle` of the list before the
   inbound and assert `isConnected` after, and that its row count only grew.
   Also assert (through the request log) that no finished request carrying
   `cursor` was issued after the inbound (the fully loaded list must not
   re-walk).
3. Back button. Viewport 1280x500 (so the list overflows), seed six parties at
   `?limit=2`, auto-load until Load more disappears, scroll the container to
   the bottom and assert `scrollTop > 0`; open the last row; `page.goBack()`;
   assert the same row count without a spinner and the container's `scrollTop`
   within 8px of the saved value; then assert (request log, finished
   requests) that exactly one head read and the re-walk's cursor reads
   followed the return, and that the row count is unchanged after they
   settle.
4. Widths. At `NARROW_360` from `e2e/support/viewport.ts`: the shared
   no-horizontal-overflow assertion, and the first row's `<time>` bounding box
   fully inside the row's box and in its top half. Then at 768x720 (the
   tightest one-line band, sidebar open) on a seeded row with a long name and
   a placement tag: the `<time>` box fully inside the row's box (its right
   edge at most the row's right edge, its width above 0), since
   `.row { overflow: hidden }` would otherwise clip it silently and
   `toBeVisible` would still pass. Then at `WIDE_RESTORE`: an ordinary
   seeded name is not ellipsized (`scrollWidth <= clientWidth` on the name).
5. Refresh failure banner. `page.route` returns 500 for the head read only
   (match on the absence of `cursor` in the query), triggered by an inbound;
   rows remain, the banner and `Retry refresh` appear; un-route and click Retry
   refresh; the banner clears and the new row appears.
6. No auto-load chain at the group wall. Viewport 1280x400; seed about 30
   fresh parties, all newer than the lean group rows; open `/inbox?limit=12`
   (a 12-row page is about 550px, taller than the viewport plus the 400px
   margin, so a committed page pushes the sentinel out); scroll to the bottom
   ONCE; wait for the network to settle; assert through the request log that
   EXACTLY ONE finished request carrying `cursor` was issued and that the
   list gained exactly one page; scroll to the bottom again and assert a
   second one. This is the browser-side proof that `overflow-anchor: none`
   on the page root plus the epoch rule do not chain when pages sort above
   the group wall. The plan may lower the party count if the measured row
   height allows, keeping the page taller than viewport plus margin.
7. Auto-load disarm on an empty page with a cursor is proven in the unit tests
   only; the lean world cannot cheaply produce the Unknown tab's budget exit.
   The spec's header comment says so.

### 7.4 Gates

All five from AGENTS.md, bare, from the worktree; the hermetic
`npm run perf:pages` self-QA; and a live self-QA pass in an `e2e:session` lane
at both widths.

## 8. Risks and accepted trade-offs

- Read cost: a head read is `limit` rows (100 by default) per 300 ms debounce
  window instead of 30; a return to the page costs one head read plus one
  read per `limit` rows of tail (capped at 5). DynamoDB on-demand cost at
  Sam's volume is negligible; latency is the real cost and 5.10 is the
  mitigation for the All tab. If 5.10 is dropped, `?limit=50` is the fallback
  knob without a deploy, and it tunes every read.
- A committed head read still discards an in-flight `loadMore` page and
  re-enables the button; the epoch rule re-issues it once if the sentinel is
  still in view, so a busy SSE stream delays paging by one head read and does
  not starve it. Accepted.
- Tail rows on All and Groups are refreshed on every return to the page and
  whenever activity moves them into the head, but NOT for a non-activity
  change while the operator stays on the page: another operator's read, a
  rename or deletion made in another tab. Sam is the only operator today;
  accepted, and stated in front of her as "the list refreshes when you come
  back to it". A row a complete head read should have dropped but that was
  kept on a timestamp tie stays until the next return re-walks it.
- On Unread and Unknown a complete refresh replaces the loaded list with its
  fresh page one, so a tail loaded past page one is dropped on the next
  complete refresh, including the one a return triggers. Accepted; on Unread
  page one is the badge cap, on Unknown it is the front of the triage queue.
- A relay or group row whose kind returned no rows at all on a head read is
  kept (a swallowed relay-list failure and "all closed" look identical on the
  wire); the last closed group can linger until a later head read returns one
  of its kind or a reload. Accepted; today's behavior drops them on the same
  read and re-shows them on the next, which is worse.
- A row that legitimately reappears (a relay group reopened) is re-added by the
  next head read; a row inserted mid-list with an OLD timestamp (an import
  writing historical activity) is missed until the next full load. Accepted.
- The store is per tab and in memory. Two tabs do not share it; a reload
  starts fresh. Accepted; it matches the badge's optimistic layer.
- Labels do not roll over at midnight without a re-render. Accepted (section
  4.2).
- The actions overlay covers the time while revealed. Accepted; Sam approved
  the aligned-column layout and this is the standard pattern.
- `overflow-anchor: none` on the page root means an inserted row shifts the
  operator's reading position by one row height instead of holding the anchor.
  Accepted; it is what the Messages app does, and anchoring is what would make
  auto-load chain.
- `limit=100` on the Unread tab sits exactly at `SEEN_SET_MAX`; the strict `>`
  comparison keeps page two reachable. The issue's reachability paragraph is
  updated to say the dashboard now requests 100 (section 9).

## 9. Issues to file and resolve

- Resolve: `inbox-reconcile-failure-blanks-list` (5.7).
- Update: `seen-set-max-equals-max-inbox-limit` - the dashboard now requests
  `limit=100`, so the zero-margin invariant is on the live path; the pinning
  boundary test it proposes becomes worth landing (not in this mission).
- File: `contact-timeline-time-format-differs-from-inbox` (low, improvement):
  the timeline shows `9:14a`, the inbox `9:14 AM`; decide once and align.
- File: `inbox-labels-do-not-roll-over-at-midnight` (low, debt): a visible
  "2:14 PM" becomes "Yesterday" only on the next re-render.
- File: `inbox-unread-page-hydration-sequential` (low, debt): the unread and
  unknown branches hydrate one row at a time; at `limit=100` a full unread
  page is up to 100 sequential latest-message reads per reconcile. Apply the
  5.10 prefetch pattern there if a measured page is slow.
- File: `inbox-tail-rows-stale-until-return` (low, decision): on All and
  Groups a loaded tail row does not reflect a non-activity change made
  elsewhere until the operator returns to the page; revisit if a second
  operator joins.
- File only if 5.10 is dropped: `inbox-all-page-hydration-sequential` (medium,
  debt) with reviewer B's analysis of the cache race and the in-function dedupe.
- Tracker #24 (one timeline) is Cameron's, outside the repo.

## 10. Open items

None. Sam approved the mockups on 2026-09-25.
