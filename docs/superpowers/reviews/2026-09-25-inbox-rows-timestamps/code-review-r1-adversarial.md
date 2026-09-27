# Code review r1 - adversarial

Branch `feat/inbox-rows-timestamps` @156022b7, merge base `main` @cd8e8ddd.
Reviewer posture: read-only on the tree, blind to `docs/superpowers/`.
Throwaway tests (`zz-review-*`) were written, run as single files, and deleted
before handback; `git status` shows no file of mine besides this report.

## 1. What the branch does (derived from the code and its tests)

Dashboard. The Inbox now requests 100 rows per page (`DEFAULT_PAGE_LIMIT`,
tunable by `?limit=1..100`, which the tab switch and the groups link keep).
`useInbox` holds ONE authoritative list (head = the server's page one, tail =
pages added by Load more), mutated only through `commitList`. A head read
(initial load, retry, debounced SSE reconcile, or the reconcile after a
restore) goes through `mergeHeadRead`: a COMPLETE page (not truncated, and no
cursor or a full page of paged rows) replaces the list and drops the tail; an
INCOMPLETE one merges its rows in, removes nothing and keeps the old cursor.
Load more goes through `appendPage` (rowKey dedupe plus a conversationId dedupe
across the relay/group kinds). A failed head read with rows present keeps the
rows and raises `refreshFailed` (a `role=status` banner with "Retry refresh").
Every committed ready list is snapshotted into a module-level store keyed
`operatorId:filter:limit` (pending optimistic patches folded in, plus the last
reported scrollTop); a remount of the same key paints the snapshot on the first
render (ready, auto-load disarmed) and reconciles; a POP arrival restores the
saved scroll position, any other arrival scrolls to 0. AuthGate clears the
store from a passive effect when the session goes anonymous. A 1px sentinel
watched by an IntersectionObserver (400px margin, root = the shell's scrolling
`main`) auto-loads the next page; reports are consumed at arrival, discarded
while disabled, and re-checked by re-observing after every committed page
(`pageEpoch`). The page root sets `overflow-anchor: none`. Every row shows a
last-activity label inside its link (clock time today, "Yesterday", "Mon D",
"Mon D, YYYY"; local days; NBSP normalized) with a full-stamp `title`, and the
row actions became an absolutely positioned hover/focus overlay.

Server. `aggregateInbox`'s three per-request caches (contact lookup by the
(phone, email) pair, a contact's open 1:1 set, the raw latest message per
conversation) now memoize never-rejecting promises, and the `filter=all` pager
starts, per chunk, a prefetch pass of 8 workers that warm those caches ahead
of the unchanged sequential decision loop; it stops scheduling when the page
fills or the chunk ends and leaves in-flight chains to settle. A deps seam
(`inboxPrefetch: false`) runs without it; new tests assert rows, cursor and the
assembled log line are identical both ways. The profiler plan and the perf
request classifier moved from 30 to 100; six issues were filed or updated.

## 2. Findings

### AD-1 MUST-FIX - every render constructs two ICU formatters per row

Where: `dashboard/src/routes/inbox/inboxTime.ts:37,42,45,54`
(`toLocaleTimeString` / `toLocaleDateString` / `toLocaleString`, each with an
options bag), called twice per row per render at
`dashboard/src/routes/inbox/InboxRow.tsx:65-66`; `InboxRow` (`:51`) is not
memoized and `Inbox.tsx:366-374` re-renders every row on every Inbox render.

Mechanism: V8 (Chromium/Edge) reuses a cached formatter for
`Date.prototype.toLocale*String` only when locales AND options are absent; with
an options bag each call builds a new DateTimeFormat.

Reproduction (Node 24.14.1 = the same V8; exact copies of `formatInboxTime` +
`formatInboxTimeFull`, 100 rows spread over today / yesterday / this year):
median 11.2 ms, p90 17.6 ms per render. 1000 rows (label + full): 176.6 ms per
render; the same 2000 formats through two module-level `Intl.DateTimeFormat`
instances: 3.5 ms. Desktop CPU; a mid-range laptop is typically 2-4x slower.

Consequence: the Inbox re-renders on every IntersectionObserver report
(`useAutoLoad.ts:84-87` sets state inside the component), every committed head
read (every inbox-affecting SSE event), every `UnreadContext` value change
(`useInbox.ts:219` subscribes via `useUnread()`; the badge moves on SSE events
and on every optimistic mark-read through `noteRowsCleared`), every patch and
every `loadingMore` flip. Before this branch a row formatted nothing and the
page held 30 rows. At the default 100 rows each of those renders now pays
about a frame of formatting; auto-load makes 300-1000 loaded rows ordinary,
which is 50-180 ms per render on this machine (long tasks on a mark-read click).

Smallest fix: four module-level formatters in `inboxTime.ts` (time, month-day,
month-day-year, full) used via `.format(d)`, keeping `plainSpaces`. Optionally
`React.memo(InboxRow)`: its callbacks are stable `useCallback`s and unpatched
row objects keep identity through `applyPatches` / `sortByActivity`.

### AD-2 SHOULD-FIX - `overflow-anchor: none` on the page root removes anchoring for every row

Where: `dashboard/src/routes/inbox/Inbox.module.css:11` (on `.page`, the only
child of the scrolling `main`, `AppFrame.tsx:194-196`).

Mechanism: an element with `overflow-anchor: none` and its whole subtree are
excluded from anchor selection, so `main` has no anchor candidate while the
inbox is mounted. On the merge base `main` anchored on the first visible row:
when a head read inserted a row above the viewport (a new inbound moving its
row to the top, the commonest live update) Chromium raised scrollTop by the
inserted height and the rows being read stayed put. Now each insertion above
the viewport pushes the visible rows down a row height, and a removal above
(another operator's action on Unread) pulls them up.

The rationale in the CSS comment (`:5-10`) is to stop auto-load chaining when
the sentinel or Load more becomes the anchor. That needs only those two nodes
excluded: anchor selection takes the first visible node in DOM order, rows
precede both, and appending a page AFTER an anchor row never moves it.

Reproduction: not run. jsdom has no layout, and I did not launch a browser
while the e2e gate is running in this worktree. Evidence: CSS Scroll Anchoring
subtree exclusion, plus the base CSS (no `overflow-anchor` before).

Consequence: an operator scrolled down an active inbox watches the list creep
by a row per inbound (Chromium/Edge; Safari never anchored).

Smallest fix: move `overflow-anchor: none` from `.page` to `.sentinel` and
`.loadMore`; update `Inbox.styles.test.ts`; re-run e2e test 6 (the group-wall
no-chain test) to confirm.

### AD-3 SHOULD-FIX - the time's hover `title` is unreachable with a mouse

Where: `InboxRow.tsx:125-129` (`title={timeFull}` on `<time>`);
`InboxRow.module.css:150-157` (`.time`, min-width 5rem at the link's right end,
`.main` padding-right `--sp-4` = 16px); `:166-184` (`.actions`: absolute,
`right: --sp-3` = 12px, `padding-left` 12px, opaque background,
`pointer-events: auto` on `.row:hover` / `:focus-within`).

Mechanism: the overlay is a positioned descendant of `.row`, so it paints and
hit-tests above the non-positioned link. One action button (about 75-90px at
`--fs-xs` including its padding) plus 12px padding-left spans roughly 12px to
99-114px from the row's inner right edge; the time box spans 16px to 96px. The
only way to put the pointer over the time is to hover the row, which turns the
overlay on over it, so the element under the pointer is `.actions` and no
tooltip appears. Affects every row that offers an action (every unread row,
every read row that is not deleted / closed), i.e. almost all.
`formatInboxTimeFull` exists for "the row's hover title" (`inboxTime.ts:49`);
`InboxRow.test.tsx` only checks the attribute is present.

Reproduction: CSS geometry above; no browser run (same reason as AD-2).

Smallest fix: put the full stamp where the pointer can reach it (the row link
or `.actions`), or offset the one-line overlay left of the time column
(`right: calc(var(--sp-4) + 5rem + var(--sp-3))`), which also keeps the time
visible while hovering.

### AD-4 SHOULD-FIX - an incomplete head read keeps a NULL cursor over the server's continuation

Where: `dashboard/src/routes/inbox/inboxListMerge.ts:132`
(`cursor: hadRows ? state.cursor : C`).

Mechanism: once a list has rows and a null cursor (fully loaded), a later head
read that is truncated or short WITH a cursor (Unread budget exit or unresolved
lag drops beyond one page; Unknown budget stop or thread-read deferral page)
merges its rows but keeps null. `hasMore` is false, so neither Load more
(`Inbox.tsx:414`) nor the sentinel (`:383`) renders, while `Inbox.tsx:318-325`
renders "There are older unread threads not shown here." (truncated and
serverRowCount > 0). The merge base installed the page's cursor and offered
Load more. The state is saved to the store and survives every restore
(`hadRows` stays true); only a later complete head read or a tab switch clears
it.

Reproduction (throwaway `dashboard/src/routes/inbox/zz-review-null-cursor.test.tsx`,
real `Inbox` + `useInbox`, mocked API; deleted): Unread head read 1 = one row,
`nextCursor: null`; SSE head read 2 = two rows, `nextCursor: 'SERVER-SAYS-MORE'`,
`truncated: true`. Result: the notice renders, no "Load more" button, no
`[data-autoload-sentinel]`, two requests total. Control: the same page on a
fresh mount renders Load more. Both assertions passed.

Smallest fix: `cursor: hadRows && state.cursor !== null ? state.cursor : C`
(appendPage's rowKey dedupe already absorbs rows the list holds). Add the case
to `inboxListMerge.test.ts` (today it pins old 'TAIL' over 'SHORT' and null
over null, not null over a cursor).

### AD-5 NOTE - "can never fire from stale geometry" depends on the engine dropping queued IO entries

Where: `useAutoLoad.ts:52-55` (reobserve = unobserve + observe), `:84-87` (the
callback has no liveness guard), `:90-95`, `:104-109`; claim in the header
`:4-8`.

Per the IntersectionObserver spec, `unobserve()` / `disconnect()` remove
registrations but do not clear the observer's queued entries, so an entry
computed before a page commit can be delivered after the re-observe effect set
`consumedSeqRef`, and it is then consumed as fresh. Engine-dependent (Chromium
keeps records per observation and drops them with it; Gecko's Unobserve leaves
its queue). Worst case one extra page load; the next re-observe corrects. The
unit harness reports synchronously, so it cannot exercise this. Fix:
`io.takeRecords()` (discard) inside `reobserve` and before `disconnect`, and a
per-effect `live` flag checked in the callback.

### AD-6 NOTE - prefetch read-ahead WARNs for rows not on the page, and reads outlive the response

Where: `app/src/routes/inbox.ts:2373-2403` (`startPrefetch`); the best-effort
WARNs inside the cached promises at `:885`, `:916`, `:936`.

Reproduction (throwaway `app/test/zz-review-prefetch-readahead.test.ts`,
deleted): 20 contacts, `limit: 1`, `findByPhone` throws for conv-5, every read
takes 2ms. Prefetch on: 1 latest-message read finished when `aggregateInbox`
returned, 8 finished afterwards; one "inbox: contact lookup failed
(best-effort)" WARN for conv-5, which is not on the page. Prefetch off: 1 read,
0 WARNs.

Consequence: a best-effort WARN no longer means "a row on the served page
degraded"; a lookup outage emits up to a chunk of WARNs per request for rows
nobody saw, and DynamoDB reads continue after the response, including for
requests the dashboard already aborted (every superseded SSE reconcile and
every tab switch; Express does not cancel `aggregateInbox`). Page content is
unaffected. Consider a `readAhead: true` field on WARNs raised from the
prefetch path.

### AD-7 NOTE - cost per live update roughly tripled; the filed cost analysis is stale

Every inbox-affecting SSE event triggers one head read per connected
dashboard: at 100 rows plus read-ahead that is on the order of 100 contact
lookups, 100 participant-GSI queries and 100 latest-message reads (was 30 of
each), and superseded requests keep running (AD-6).
`docs/issues/thread-hooks-refetch-whole-page-per-event.md` (severity med) still
quantifies the 30-row page (`:112`).

### AD-8 NOTE - `headComplete` trusts that the server serves exactly the requested limit

`inboxListMerge.ts:106` compares `pagedP.length` with the REQUESTED limit.
`MAX_PAGE_LIMIT` (`useInbox.ts:62`) mirrors `MAX_INBOX_LIMIT`
(`app/src/routes/inbox.ts:223`) by comment only; nothing tests the equality. If
any branch ever serves fewer rows than asked on a full page (a lowered server
max, a per-branch cap), every head read classifies as incomplete: rows are never
removed, rows read elsewhere stay unread on the Unread tab, the first cursor is
kept for the life of the mount. Pin it (a shared-constant test, or have the
server echo the effective limit).

### AD-9 NOTE - comments and issues that are now false

- `app/src/routes/inbox.ts:2030`: "THE THRESHOLD IS THE REQUEST `limit` (30
  from the dashboard, useInbox)" - it is 100.
- `app/src/routes/inbox.ts:2020-2025`: a needs_review -> active flip mid-walk
  ships "a doubled row under a duplicate React key - ugly, but VISIBLE".
  `appendPage` (`inboxListMerge.ts:142-145`) now drops the second copy by
  rowKey, so the stale page-1 copy (still carrying Needs triage) silently wins.
  `docs/issues/unknown-queue-status-flip-duplicates-across-pages.md` states the
  same symptom and a reachability of "30 from the dashboard".
- `docs/issues/inbox-parselimit-empty-one-row.md:41` and
  `thread-hooks-refetch-whole-page-per-event.md:112` cite `PAGE_LIMIT = 30`.
- `e2e/performance/routes.ts` CONTRACT_SOURCE_LEDGER (`:689-692`, `:743-746`,
  `:770`, `:778`, `:787`) cites `useInbox.ts` / `Inbox.tsx` line ranges that now
  point at unrelated code; its test checks only the citation format.

### AD-10 NOTE - AuthGate's ordering rationale is wrong for passive cleanups (the code is still correct)

`AuthGate.tsx:10` and `AuthGate.test.tsx:1-4` say a cleanup in a deleted parent
(AppFrame) would run before the child's unmount save and repopulate the store.
Throwaway `dashboard/src/app/zz-review-cleanup-order.test.tsx` (deleted)
recorded React 19's deletion order: child layout cleanup (the save), parent
passive cleanup (the clear), child passive cleanup; the store ended empty. All
layout cleanups precede all passive cleanups, so only a LAYOUT cleanup in the
parent would run first. Reword so a future editor is not steered by a false
premise.

### AD-11 NOTE - perf harness: auto-load can fail a sample; warm inbox-all now measures a restore

`e2e/performance/collect.ts:174-194` treats any `/api/inbox` request with a
third key (a cursor) as `endpoint_contract_mismatch`, and `cli.ts:958-960` marks
the sample failed. A cursor request used to need a click; now `useAutoLoad`
issues one by itself whenever page one is short with a cursor and fits in the
viewport plus 400px (Unknown budget-stop or deferral pages). Separately, the
`inbox-all` warm sample reaches `/inbox` by clicking the nav link from Today (a
PUSH remount): if an earlier sample in the same document filled the store, rows
paint from the snapshot before any request. `readyMs` is still gated on the
reconcile request (`readiness.ts:115-121`), but long-task and DOM metrics now
describe a restore. Neither point is in `e2e/README.md`.

### AD-12 NOTE - the POP rule and the scroll position live in two places

`useInbox.ts:248` seeds `scrollTopRef` from the snapshot only when
`restoreScroll` (POP); `Inbox.tsx:189` independently picks `POP ? restored : 0`
for the DOM. Change one without the other and the unmount save disagrees with
what was applied. Relatedly the scroll-root effect (`Inbox.tsx:160-169`) is
keyed on `hasRows` only: if rows exist while the `<ul>` is not rendered
(status `error` with rows from a late loadMore commit), it returns and never
re-runs when the `<ul>` appears, so that mount has no scroll listener and saves
position 0.

### AD-13 NOTE - the "go see it unread" navigations first show the row as read

`ContactDetail.tsx:399` and `ThreadUnreadToggle.tsx:189` `navigate('/inbox')`
(PUSH) after a successful mark-unread. The remount restores the snapshot saved
when the operator opened that row, which folded the mark-read patch
(`useInbox.ts:166-178`, `:481-490`), so the row renders read until the
reconcile lands. Transient, but it is the one navigation whose purpose is to
show that row unread.

### AD-14 NOTE - on Unread, an incomplete head read keeps rows read elsewhere as UNREAD

Branch I (`inboxListMerge.ts:123-137`) removes nothing and does not refresh rows
absent from the page, so a row another operator or tab marked read keeps its
old `unreadCount > 0` and stays on the Unread tab until a complete head read.
"Remove nothing" is deliberate; the Unread narrowing turns "keep" into "keep
showing as unread".

### AD-15 NOTE - Option B plus auto-load reload the boundary page on every live update

A reader parked near row 100 with page 2 loaded: each complete head read drops
the tail, the sentinel lands inside the margin, the epoch re-observe fires, and
page 2 is fetched again - two requests and 100 rows removed and re-added per
SSE event (plus AD-1 render cost), invisible otherwise. A bookmarked `?limit=5`
re-chains the whole list on every event (the e2e spec pins this at limit 2).
Worth a line in `docs/issues/inbox-loaded-pages-survive-refresh.md`.

### AD-16 NOTE - tests that pin implementation

`useInbox.test.tsx:924` hard-codes the store key format (`'anon:all:2'`)
instead of `inboxListKey()`; `Inbox.styles.test.ts` regex-matches CSS text;
`InboxRow.test.tsx:222,225` assert a CSS-module class name;
`app/test/inboxFeed.test.ts:2564` hard-codes 9 instead of
`HYDRATE_CONCURRENCY + 1` (the constant is exported).

## 3. Consumer sweep

| Touched item | Every reader / writer found | Verdict |
|---|---|---|
| `inboxListStore` (new module singleton) | writers `useInbox.commitList` (`useInbox.ts:300-306`) and the unmount layout save (`:481-490`); reader: lazy init (`:205`); clear: `AuthGate.tsx:21-23`; tests. No other importer. | Holds |
| Sign-out paths | AppFrame `handleSignOut` (logout, then `refresh` -> anonymous -> AuthGate clear, ordering proven); session expiry (401s, no status flip; store stays in-tab for the same operator); another tab's global logout (same); full reload (module gone); public routes `/p`, `/join` unmount AuthGate without a clear (same session). A different operator can only enter through anonymous, and the key carries `userId`. | Holds |
| `useOptionalAuth` (new export) | `Inbox.tsx:60` only; `'anon'` fallback unreachable under AuthGate | Holds |
| Navigations into `/inbox` | nav link (PUSH: restore rows, scroll 0); `ContactDetail.tsx:399`, `ThreadUnreadToggle.tsx:189` (PUSH; AD-13); "Back to inbox" links `ConversationDetail.tsx:398`, `GroupTextView.tsx:319` (PUSH: scroll 0 by ruling, always the All key); `QuickReply.tsx:220,242` (PUSH); browser back/forward (POP: restore); tabs and the groups link (same instance: reset, no restore); reload / deep link (empty store) | Hold, except AD-13 |
| `GET /api/inbox` page shape (limit 100) | `useInbox` head + loadMore; perf `collect.ts` classifier (updated; AD-11); perf `routes.ts:1170`, `selfQa.ts:145,225` (harness-side reads at 30, still valid, not classified); e2e specs (API-side, own limits); `app/scripts/profile-inbox.ts` via the plan (updated; totalMs issue filed); `measure-unread-contact-coverage.ts` (historical instrument, unchanged by design) | Holds |
| Unread cursor size | the first Load more / auto-load now carries a 100-id seen-set (was page 4) | Holds: sized at ~6.3KB against CloudFront's 8,192 (`inbox.ts:257-271`); strict `>` at `:1715`; issue updated |
| Server caches (values -> promises) | pager `rowForConversation` (`:1146`, `:1211`); `buildContactRow` (`:1037`, `:1070`) from the pager, unread and unknown branches; unread `hydrateUnread` (`:1448`) and the lag-retry delete (`:1651`); prefetch (`:2382-2390`) | Holds: no rejection can be cached; the only delete runs on the unread branch, where no prefetch exists |
| `inboxPrefetch` seam | tests only; `api.ts:1175-1185` forwards logger / repos / events / unreadWalkLimit only | Holds (unreachable from HTTP or config) |
| "inbox feed assembled" log | fields unchanged; `drops` / `rawScanned` computed only by the loop | Holds |
| Best-effort WARN lines | now also raised by read-ahead | Changed meaning (AD-6) |
| Row link accessible name (time label appended) | e2e `inbox`, `inbox-comms`, `inbox-markread`, `deleted-contact-resurfacing`, `contact-create-relay-group`, `group-text-conversion` / `-detection` (`^With ...`), `relay-group-view`, `unknown-caller-triage` (href + toContainText): all substring or start-anchored; perf `countRelayConversationRows` keys on text + href | Holds |
| `role=status` banner | Spinner is also `role=status` but only while loading; the banner only while ready; e2e `getByRole('status')` users are elsewhere or text-filtered | Holds |
| "Loading..." / sub-heading copy | no pins (grep) | Holds |
| `.actions` overlay, `.time` | InboxRow only; e2e `inbox-nav-badge` hovers then clicks the action | Holds for clicks; AD-3 for the title |
| `.page { overflow-anchor }` | the only child of AppFrame `main` | AD-2 |
| `rowKey` moved to `inboxListMerge.ts` | re-exported by `useInbox`; `Inbox.tsx` imports it there; `unreadKeys.ts` comment | Holds |
| `MAX_PAGE_LIMIT` mirror | `limitFromParam`, `headComplete` | Latent (AD-8) |
| Perf source ledger | `routes.ts` citations | Stale (AD-9) |

## 4. Looked for and not found

- A path that restores one operator's rows for another: none (key carries
  `userId`; clear on anonymous; `'anon'` needs a missing provider).
- A save after the sign-out clear: none. Once passive cleanups have run
  `aliveRef` is false (commits skip the save), the layout save already ran,
  head read / loadMore are aborted, the debounce timer is cleared. A save in the
  window between layout and passive cleanups (React Router 7 transition
  commits) lands before the clear.
- A stale-filter or stale-list commit: `fetchHead` refuses on abort /
  `activeFilterRef` / `aliveRef`; `loadMore` on `filterGen` / `firstPageGen` /
  alive; a loadMore fired from a restored cursor is discarded when the
  reconcile commits (`useInbox.ts:359`).
- StrictMode: a restored mount issues one live reconcile; the simulated
  unmount saves the seeded POP position; `restoredKeyRef` skips the reset on
  replay; alive returns true.
- Unhandled rejections from `void worker()` or the cached promises: none
  (every await sits in try/catch; the IIFEs catch).
- Prefetch changing rows, order, cursor or drop counts: none; decisions stay in
  the loop, and the cache keys (JSON pair, contactId, conversationId) cannot
  alias.
- Unvalidated query params: `limit` validated in `limitFromParam` and clamped
  in `parseLimit`; `filter` allowlisted; the raw tuned `limit` is re-encoded by
  `URLSearchParams`.
- PII in new log lines: none (same shapes as before).
- Group pages short with a cursor (an auto-load trigger): `listGroupTexts` only
  stops short after 20 x 1MB pages.
- Throttling from 8x read concurrency: tables are `PAY_PER_REQUEST`.
- New React key collisions: `dedupeByRowKey`, `appendPage` dedupe and the
  conversationId dedupe cover head, tail and appended rows.
