# Inbox: more rows, a time on every row, and a list that stays put - design specification

Status: DRAFT 4 - revised after adversarial review round 2; round 3 pending
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
  plus 7 group/relay rows (live data, not verifiable here).
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
  anywhere in page one. A budget exit returns `{ rows: [], nextCursor }`.
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
  development and in the e2e harness (which serves the Vite dev server). React
  Router 7 exposes `useNavigationType()` (`POP` for back/forward, `PUSH` for a
  link or programmatic navigation, `REPLACE`). React deletes subtrees
  parent-first: a deleted parent's effect cleanups run before its children's.
- The page's scroll container is `<main className={styles.content}>` in
  `AppFrame.tsx` (`overflow-y: auto`, no `overflow-anchor` rule), not the
  window. The contact and conversation pages that replace the Inbox are
  `height: 100%` with their own internally scrolling panes, so after a route
  swap `main.content` has nothing to scroll and its `scrollTop` reads 0.
  Chromium's CSS scroll anchoring is on by default: when content is inserted
  above the viewport's anchor node the browser raises `scrollTop` to keep that
  node in place. The contact timeline already opts out of anchoring on its
  stream (`Timeline.module.css`, `overflow-anchor: none`).
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
  `rowForConversation` per conversation, and each one awaits `findByPhone` /
  `findByEmail` (uncached, inside one try/catch), the contact's conversation
  set (`contactConvsCache`, a VALUE cache with a check-then-await-then-set
  shape, shared with the unread branch, which also deletes entries for its
  lagged-retry re-read), and `latestMessageOf` (an uncached
  `messages.listByConversation(id, { limit: 1 })` whose result is DERIVED
  against the conversation image passed in: `deriveLatest` falls back to that
  image's `last_message_preview`). A 100-row page is roughly 300 sequential
  DynamoDB round trips. The `emittedContacts` dedupe check and add live INSIDE
  `rowForConversation`, as does the `dropped(...)` telemetry.
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
   error state over rows that were fine. This resolves
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
whose page one is cut by a different key, a complete refresh REPLACES the list
with its fresh page one (100 rows, which is the badge cap), and an incomplete
refresh never shrinks it. Scroll position is kept on every tab.

## 4. Scope

### 4.1 In scope

- `dashboard/src/routes/inbox/useInbox.ts`, `Inbox.tsx`, `InboxRow.tsx`, their
  CSS modules and tests; new modules under `dashboard/src/routes/inbox/`:
  `inboxTime.ts` (pure formatter), `inboxListStore.ts` (the store),
  `useAutoLoad.ts` (the observer hook), `inboxListMerge.ts` (the pure merge of
  5.6, unit-tested on its own).
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
persisted in the store) and a `listEpoch` counter (`InboxState.listEpoch`,
bumped on every COMMITTED head read and every COMMITTED `loadMore`, never on a
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
    example `loadingMore` flipping back to false after a FAILED page) does not
    fire, because neither `intersecting` transitioned nor `epoch` changed.
- `enabled = hasMore && autoLoadArmed && !loadingMore`.
- The list `<ul>` gets `overflow-anchor: none`, so rows inserted above the
  viewport (a fresh head row, or an appended page that sorts above page one's
  old group rows) push the content and the sentinel DOWN instead of the
  browser raising `scrollTop` to hold them in place. Consequences: a committed
  page of `limit` rows pushes the sentinel `limit` row-heights further away,
  so after a full page the sentinel is outside the margin and the epoch-driven
  re-check finds `intersecting` false; only a SHORT page (a budget exit, or
  the end of the feed, where `hasMore` goes false anyway) can leave it inside
  the margin and continue, which is the wanted behavior on a budget exit. A
  head read that inserts one row moves the operator's reading position by one
  row height, the same as the Messages app.
- ARMING RULE, in the hook. `autoLoadArmed` is set from the result of the read
  that installs the CURRENT cursor chain: every committed `loadMore`
  (`true` iff its page delivered at least one row AFTER dedupe), and every
  committed head read that REPLACES the chain (the initial load; any head read
  on Unread and Unknown; a head read on All and Groups when the tail is
  empty). A head read on All or Groups that keeps a tail leaves it unchanged,
  because the tail's cursor and the last page result it describes are still
  the live chain. A failed page leaves it unchanged.
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
  - a restored list restores `autoLoadArmed`; on Unread and Unknown the mount
    head read replaces the chain and re-arms from its own result, which is
    right because the restored cursor is discarded with the old chain.
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
  becomes a two-row grid. Row one: dot, name (ellipsized, `min-width: 0`, no
  `max-width`), chip, tags, time at the right (`min-width: 0`,
  `white-space: nowrap`). Row two: preview (ellipsized) and the count pill at
  the right. The `<time>` keeps the same element and classes; only its grid
  placement changes. No element is duplicated for the two layouts. The
  actions overlay is revealed by swipe as today and covers the row's right
  end.
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
  head: InboxRowData[];   // the server's page one as of the last head read, server order
  tail: InboxRowData[];   // rows from loadMore pages, in load order, plus (All/Groups only)
                          // rows that slid out of the head; deduplicated by rowKey
  cursor: string | null;  // the position after the last row of head ++ tail;
                          // null means the loaded list reaches the end of the feed
  groupsTruncated: boolean;
  truncated: boolean;
  autoLoadArmed: boolean;
  tailPages: number;      // how many loadMore pages the tail holds (for the re-walk, 5.8)
  epoch: number;          // bumped on every commit (5.2)
}
base = [...head, ...tail]   // what serverRowCount, the notices and the Unread narrowing read
```

- `commitList(next)` is the ONLY writer: it sets `listRef.current = next`,
  calls `setList(next)`, and, when `aliveRef.current` is true and
  `statusRef.current === 'ready'`, saves the snapshot to the store under
  `keyRef.current` (5.8). Every mutation (head merge, `loadMore` append, the
  optimistic commit and rollback in `markRead`/`markUnread`, the reset)
  computes `next` from `listRef.current` synchronously and calls `commitList`.
  No functional `setState` updater touches the list, so the saved snapshot is
  exactly the committed value and never a pre-commit list with a post-commit
  cursor.
- `aliveRef` is set false in the unmount cleanup; `loadMore`'s controller is
  aborted there too. A `loadMore`, `markRead` or `markUnread` that settles
  after unmount neither commits nor saves.
- `loadMore` appends its page to `tail` DEDUPLICATED against the current
  `base` by `rowKey` (a row already present is skipped), installs its cursor,
  increments `tailPages`, bumps `epoch`, sets `autoLoadArmed` to whether the
  page delivered at least one NEW row, and keeps its two staleness guards. The
  dedupe closes the seen-set gap on Unread: a kept cursor's seen-set never
  learned the contacts a later head read emitted, so a multi-thread contact
  that surfaced in the head can be emitted again by the next page. Today's
  list is not deduped on append because today a head read always resets the
  cursor.
- A HEAD READ (initial load, Retry, SSE reconcile, mount reconcile) requests
  `limit` rows and merges per 5.6. The head read is never larger than page
  one, so `?limit=` tunes every read, not only the first.
- The filter/limit-change reset commits an empty `ListState` and clears
  `pending`, `refreshFailed` and the status.
- `pending` patches overlay `base` as today; the Unread narrowing and the sort
  produce `rows` as today.

### 5.6 The head-read merge (`inboxListMerge.ts`, pure)

Inputs on a committed head read: `P` (its rows), `C` (its cursor), its
`truncated` and `groupsTruncated` flags, the current `ListState`, `limit`,
`filter`. Two models, selected by the filter.

Definitions shared by both:

```
additive(row)  := filter === 'all' && (row.kind === 'relay_group' || row.kind === 'group_text')
pagedP         := P.filter(r => !additive(r))
headComplete   := !truncated && (C === null || pagedP.length >= limit)
                  // a truncated page, or a short page with a cursor, stopped early and
                  // says nothing about absent rows
inP            := Set(P.map(rowKey))
```

**Model R (replace) - `filter === 'unread'` and `filter === 'unknown'`.** Page
one on these tabs is not cut by `lastActivityAt` (section 2), so no
"slid out" inference is sound. Rule:

```
if headComplete:
  head := P; tail := []; cursor := C; tailPages := 0
  autoLoadArmed := P.length > 0
  flags := from the page
else:                                   // budget exit or depth cap
  if P.length === 0 and base.length > 0:
    keep everything; refreshFailed := true    // the banner (5.7); the read told us nothing
  else:
    head := P; tail := []; cursor := C; tailPages := 0   // a short page IS page one
    autoLoadArmed := P.length > 0
    flags := from the page
```

Page one is up to 100 rows, which is the badge cap, so a replaced tail is the
uncommon case; the store still restores rows instantly and the scroll position
is kept (it clamps if the list shrank).

**Model P (provenance) - `filter === 'all'` and `filter === 'groups'`.** Page
one is the newest `limit` paged rows by `lastActivityAt` plus (All) the
additive rows. Rule:

```
boundary := min(lastActivityAt) over pagedP, or undefined when pagedP is empty
hasKind(k) := P.some(r => r.kind === k)
oldestGroupInP := min(lastActivityAt) over P.filter(kind === 'group_text'), or undefined

keep(oldRow, wasInHead):
  if inP.has(rowKey(oldRow))                   -> false  // P's fresh copy wins
  if additive(oldRow):
    if !hasKind(oldRow.kind)                   -> true   // no row of that kind came back: a swallowed
                                                         // relay-list failure or an empty budget looks
                                                         // identical to "all closed"; keep rather than
                                                         // blank (residue: the last closed group lingers
                                                         // until a head read returns one of its kind or
                                                         // a reload)
    if oldRow.kind === 'group_text' && groupsTruncated
       && oldestGroupInP !== undefined
       && oldRow.lastActivityAt <= oldestGroupInP -> true // outside the page-one cap, not gone
    return false                                          // returned every read; absence means closed,
                                                          // converted or gone
  if !headComplete                             -> true   // the head stopped early; infer nothing
  if C === null                                -> false  // the feed ended inside the head; gone
  if !wasInHead                                -> true   // a loadMore row; the head says nothing
  return boundary !== undefined && oldRow.lastActivityAt <= boundary
                                                         // slid out of page one (ties kept: losing
                                                         // a live row costs more than keeping a
                                                         // gone one for one read)

newTail := dedupeByRowKey([ ...head.filter(r => keep(r, true)), ...tail.filter(r => keep(r, false)) ])
head    := P
tail    := newTail
cursor  := newTail.length > 0 ? cursor : C     // a kept tail keeps ITS cursor, INCLUDING null
                                               // (null + a tail = the list reaches the end; installing
                                               // C would re-walk rows already on screen)
tailPages := newTail.length > 0 ? tailPages : 0
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
  are DROPPED when the head read is complete. A dropped row's `unreadCount`
  no longer counts anywhere, which matches the badge.
- A budget-short or truncated head read keeps everything and the old cursor;
  the list never shrinks on the strength of a read that stopped early.
- A fully loaded list (`cursor === null`, tail non-empty) stays fully loaded
  across head reads: no spurious Load more, no re-walk.
- On Groups no row is additive, so every row follows the boundary rule, which
  matches the partition's `last_activity_at` order.

Invariant 1, stated honestly: on All and Groups a live update never removes a
row from the list unless a COMPLETE head read shows the server no longer
returns it inside page one; rows slide, they do not vanish. On Unread and
Unknown a complete head read replaces the list with its fresh page one and an
incomplete one changes nothing. On every tab the scroll position is never
reset by a live update.

### 5.7 Refresh failure and Retry

`InboxState` gains `refreshFailed: boolean`.

- "Rows are rendered" means `status === 'ready' && base.length > 0`, read
  through refs at the moment a head read settles.
- A head read that FAILS while rows are rendered sets `refreshFailed = true`
  and leaves the list untouched. A 404 in that state is treated the same way
  (a proxy or deploy-window 404 must not blank a healthy list into the
  "pending" copy). So is a zero-row incomplete head on Unread or Unknown
  (5.6 model R): the server told us nothing and the honest surface is the
  banner. A head read that fails with no rows rendered keeps today's behavior
  (`status: 'error'`, or `'pending'` on 404 with the list emptied).
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
  tailPages: number;
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
- WHEN TO SAVE: only from `commitList` (5.5), which captures the key from
  `keyRef` at that moment and skips while `status !== 'ready'`. Hence an empty
  pre-first-page snapshot is never written, a save can never land under a
  filter the state does not belong to, and the saved rows are the committed
  rows.
- THE UNMOUNT SAVE runs from a LAYOUT-effect cleanup (it runs before the
  replacing route's DOM commits) and writes the list from `listRef` with the
  `pending` patches folded in, and `scrollTop` from `scrollTopRef`, which a
  passive `scroll` listener on the container keeps current and which is
  SEEDED from the restored snapshot at mount (so a StrictMode simulated
  unmount, or an exit before any scroll event, saves the restored value, not
  0). Reading `scrollTop` from the container at passive-cleanup time reads 0
  (section 2), so that is never done.
- RESTORE ON MOUNT. `useInbox` initializes its state lazily from the store:
  if `load(key)` returns a snapshot, the FIRST render already has the list
  and `status: 'ready'` (no spinner). A `restoredKeyRef` starts as that key
  (or `null` on a miss).
- THE FILTER EFFECT'S RULE: on every run, if `key !== restoredKeyRef.current`
  it performs today's reset and initial fetch; otherwise it schedules a head
  read immediately (no debounce) as a reconcile. In both cases it then sets
  `restoredKeyRef.current = key`. A StrictMode mount/cleanup/mount replay of
  the same key therefore takes the reconcile branch on its second run and
  never resets a restored list, while a real filter change (different key)
  resets. On a store miss the first run resets and fetches, the cleanup aborts
  that fetch, and the replay's reconcile issues the one live fetch.
- THE TAIL RE-WALK (All and Groups; model R has no tail after its head read).
  When the mount reconcile's head read commits and the list holds a tail with
  `tailPages > 0`, the hook re-reads the tail: starting from the fresh head's
  cursor, it requests up to `tailPages` pages in sequence (each a normal
  `loadMore`-shaped read of `limit` rows), and after EACH page replaces the
  corresponding stretch of the tail: the page's rows are installed in tail
  order and any old tail row not yet re-read is kept until its page arrives;
  old tail rows that no page returns by the end of the re-walk are dropped;
  `cursor` ends as the last page's cursor. The re-walk is one request per tail
  page (typically zero or one), runs behind the already-rendered list, keeps
  the scroll position, and is abandoned (never committed) if a filter change
  or a later head read supersedes it (the same `firstPageGenRef` guard as
  `loadMore`). It is what makes a return to the page show the operator's own
  triage, rename or deletion on a tail row, and another operator's reads.
  While the operator stays on the page, a tail row refreshes only through
  activity (which moves it into the head); non-activity changes wait for the
  next return or reload (section 8).
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
landing at the bottom. With `overflow-anchor: none` (5.2) the inserted page
pushes the group rows and the sentinel down by the page's height, so the
sentinel leaves the margin and auto-load does not chain; "the bottom of the
list" can stay old group rows until the loaded one-on-ones reach their dates.
That is exactly what tracker #24 would change; this mission does not.

### 5.10 Server: prefetch the per-row reads on `filter=all`

The decision loop in `aggregateInbox`'s open-partition pager (the sequential
`for` over each `listByLastActivity` chunk that awaits `rowForConversation`)
is NOT restructured. Its order, its `emittedContacts` check and add, its
`dropped(...)` telemetry, its page-fill and cursor bookkeeping, and the
`inbox feed assembled` log line all stay byte-identical. What changes is where
the reads it awaits come from:

- Three per-request caches memoize PROMISES of RAW reads keyed by their input,
  storing the in-flight promise before awaiting it, so two callers for one key
  share one read (this also closes the check-then-await-then-set race):
  contact-by-phone and contact-by-email (new caches wrapping `findByPhone` /
  `findByEmail`; `rowForConversation`'s existing try/catch block calls through
  them unchanged in shape), `contactConvsCache` (converted from values to
  promises; its lagged-retry `delete` keeps working because deleting a promise
  entry forces the next caller to re-read), and a NEW raw-message cache over
  `messages.listByConversation(id, { limit: 1 })` keyed by conversation id.
  `latestMessageOf` reads the raw page through that cache and still derives
  against the conversation image IT was given, so the derived preview is never
  shared between two images of one conversation. Rejections are never cached:
  the degraded fallback the sequential path would have produced is what the
  promise resolves to, with the same WARN.
- Before the loop consumes a chunk, a PREFETCH pass starts, for every
  conversation in the chunk that is not a `relay_group`/`group_text`, the chain
  `contact lookup -> contactConversations(contact) -> raw latest message` through
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
  relay row, an unknown row, a soft-deleted resurfacing row, AND a contact
  whose conversation-set lookup fails (the `?? conv` fallback path) is
  IDENTICAL (rows, order, cursor, and the assembled-log counts) to the same
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
reconcile (head reads); the tail re-walk; `loadMore` (auto or manual);
`markRead`/`markUnread` optimistic patches and their commits/rollbacks; the
filter/limit-change reset; the unmount save; `clear()` on sign-out.

Readers/renderers: `Inbox.tsx` (rows, empty states, notices, banner, sentinel,
Load more gating, scroll restore), `InboxRow.tsx` (row + time + actions
overlay), `useAutoLoad` (reads `enabled`, `epoch`), `UnreadContext` (badge
clears noted by `markRead`), the page-performance harness, and every e2e spec
that reads the inbox (`inbox*.spec.ts`, `group-text-inbox.spec.ts`,
`call-inbox-unread.spec.ts`, `group-text-conversion.spec.ts`).

Invariants the plan must carry as explicit tasks or watch items:

1. All/Groups: a live update never removes a row unless a complete head read
   shows the server no longer returns it inside page one; rows slide, they do
   not vanish. Unread/Unknown: a complete head read replaces the list with
   page one; an incomplete one changes nothing. No live update resets scroll.
2. Back from a contact or conversation page shows the same rows and scroll
   position, then reconciles with one head read plus one read per tail page.
3. Auto-load never fires on a zero-row page with a cursor, never while
   `loadingMore`, never when `hasMore` is false, never re-tries a failed page
   without an intersection change or a manual click, and never chains past
   one page per commit unless the committed page was short.
4. A failed head read never blanks rendered rows; it shows the banner. A
   failed Retry with rows present keeps `status: 'ready'`.
5. A failed initial load (no rows) shows the existing error surface, unchanged.
6. The Unread tab's client narrowing and the notices keep their server-quantity
   gating (`serverRowCount`, `truncated`, `groupsTruncated`); the store holds
   server-shaped rows so restoring never changes which empty copy renders.
7. Sign-out clears the store; a save never lands under a key the rows do not
   belong to; no snapshot is written before the first page commits; nothing
   writes after unmount.
8. A fully loaded list stays fully loaded across head reads (no spurious Load
   more, no re-walk of rows on screen).
9. The server page for `filter=all` is identical in rows, order, cursor and
   telemetry counts with and without prefetch.
10. The perf harness observes one page request per inbox sample and no cursor
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
- `inboxListMerge.test.ts` (the pure merge): model P - additive rows dropped
  when absent while their kind returned, kept when their kind did not return,
  a group_text kept under `groupsTruncated` when older than the oldest in P;
  a slid head row (older than or equal to the boundary) kept and a
  boundary-or-newer absent head row dropped; a tail row kept; a budget-short
  or truncated head keeping everything and the old cursor; a `C === null`
  head dropping the tail; a null old cursor with a tail kept as null; dedupe
  of a tail row that reappears in P; `autoLoadArmed` unchanged when a tail is
  kept. Model R - a complete head replacing the tail and cursor; an
  incomplete short head replacing as page one; a zero-row incomplete head
  with rows present changing nothing and flagging the banner; the Unknown
  queue-order case (a new row inserted mid-page pushes the last row out and
  the list is exactly the fresh page one, nothing lost behind a cursor); the
  Unread multi-thread case.
- `useInbox.test.tsx` additions: every head read requests `limit`; the mount
  from store skips the spinner and issues exactly one head read under a
  StrictMode-style double effect run; the tail re-walk issues `tailPages`
  reads from the fresh head's cursor and replaces the tail stretch by
  stretch, dropping rows no page returned; saves happen only through
  `commitList`, only while ready, with the committed value (a loadMore commit
  saves the appended rows AND the new cursor together); nothing commits or
  saves after unmount (a loadMore resolved post-unmount); the unmount save
  folds `pending` in and writes the seeded `scrollTop` when no scroll event
  happened; `loadMore` dedupes against `base` and arms only on new rows;
  `epoch` bumps on commits and not on failures; `refreshFailed` set and
  cleared per 5.7 including the 404-with-rows arm, the zero-row-incomplete
  arm on Unknown, and the failing-retry-with-rows arm; the no-rows failure
  still yields `error`.
- `useAutoLoad.test.tsx`: with an injected observer factory: one observer per
  mount; fires `onLoad` once when intersecting becomes true while enabled;
  does not fire when disabled; fires again on an `epoch` change while still
  intersecting; does not fire when only `enabled` changes (the failed-page
  case); does not fire on an `epoch` change while not intersecting.
- `InboxRow.test.tsx` additions: the `<time>` element renders with `dateTime`,
  `title` and the label for contact, relay and group rows; unread vs read
  class; no element for an unparseable instant; the actions overlay keeps its
  buttons and names.
- `Inbox.test.tsx` additions: `limitFromParam` table; the banner and its
  `Retry refresh` call `retry`; the sentinel is present only with `hasMore`;
  scroll restore sets the container's `scrollTop` on a store-backed mount
  under `POP` and not under `PUSH` (a `MemoryRouter` with a pushed history
  entry versus a popped one); the groups link and `selectFilter` preserve
  `limit`; the list has `overflow-anchor: none`.
- `inboxListStore.test.ts`: save/load/clear; keys differ by operator id.
- Every inbox test file that mounts the hook or the page calls the store's
  `clear()` in `beforeEach`: the store is module-level state and would
  otherwise make the existing `useInbox.test.tsx` cases order-dependent.
- `AuthGate.test.tsx` (or the closest existing test): the store is cleared
  after the authenticated subtree unmounts, proven by a child that saves from
  a layout-effect cleanup and a store that is empty afterwards.

### 7.2 Route (Vitest, app)

- `inboxFeed.test.ts` or a sibling: the 5.10 equivalence test (rows, order,
  cursor, assembled-log counts), the one-read-for-two-misses cache test, the
  degraded-fallback memoization test, and the `stop`-flag test. The existing
  `filter=all` tests unchanged.

### 7.3 Playwright (`e2e/tests/dashboard-next/inbox-rows-timestamps.spec.ts`)

Hermetic `e2e:session` only, accessibility-first selectors, the lean profile.
The spec RESEEDS in `beforeEach` (the existing `reseed` fixture) and logs in
again, so it never depends on lane state left by sibling specs. Fresh parties
are minted per test with run-unique numbers (`registerParty` + `sendAsParty`);
any row left unread is marked read before the test ends. Under `filter=all`
at `?limit=N` the lean world renders `N` contact rows PLUS the seeded group
text and relay group rows; the assertions count accordingly.

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
   contact rows append and Load more disappears; then a new inbound for a
   fourth fresh party arrives and the list still holds every previously loaded
   row plus the new one at the top, with no spinner shown in between: take an
   `ElementHandle` of the list before the inbound and assert `isConnected`
   after, and that its row count only grew. Also assert (through the request
   log) that no request carrying `cursor` was issued after the inbound (the
   fully loaded list must not re-walk).
3. Back button. Viewport 1280x500 (so the list overflows), seed six parties at
   `?limit=2`, auto-load until Load more disappears, scroll the container to
   the bottom and assert `scrollTop > 0`; open the last row; `page.goBack()`;
   assert the same row count without a spinner and the container's `scrollTop`
   within 8px of the saved value; then assert (request log) that exactly one
   head read and `tailPages` cursor reads followed the return.
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
6. No auto-load chain at the group wall. Seed fresh parties newer than the
   lean group rows at `?limit=2`, scroll to the bottom once, and assert
   through the request log that the number of `cursor` requests is at most
   one per page the list gained, and that the list stops growing when the
   feed ends. This is the browser-side proof that `overflow-anchor: none`
   plus the epoch rule do not chain.
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
  read per tail page. DynamoDB on-demand cost at Sam's volume is negligible;
  latency is the real cost and 5.10 is the mitigation for the All tab. If
  5.10 is dropped, `?limit=50` is the fallback knob without a deploy, and it
  tunes every read.
- A committed head read still discards an in-flight `loadMore` page and
  re-enables the button; the epoch rule re-issues it once if the sentinel is
  still in view, so a busy SSE stream delays paging by one head read and does
  not starve it. Accepted.
- Tail rows on All and Groups are refreshed on every return to the page and
  whenever activity moves them into the head, but NOT for a non-activity
  change while the operator stays on the page: another operator's read, a
  rename or deletion made in another tab. Sam is the only operator today;
  accepted, and stated in front of her as "the list refreshes when you come
  back to it".
- On Unread and Unknown a complete refresh replaces the loaded list with its
  fresh page one, so a tail loaded past 100 rows is dropped on the next
  event. Page one is the badge cap; accepted.
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
- `overflow-anchor: none` on the list means an inserted row shifts the
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
