# Planner review - adversarial (plan-blind) - feat/inbox-rows-timestamps

Reviewer: planner's independent adversarial reviewer, plan-blind (diff + repo +
charter only; no spec, plan, worklist or builder claims read).
Scope: `git diff main...HEAD` excluding docs/superpowers/** and docs/issues/**,
branch head 967ef4ab, worktree W:\tmp\inbox-rows-timestamps.
Method: read every changed source file and its main-side predecessor, walked
the interleavings named in the charter, and reproduced one test-honesty
finding with a throwaway mutant under the ignored .superpowers/planner/adv/.
Severity is the consequence if the branch ships unfixed.

## Summary

No BLOCKING or HIGH finding. The client state machine held under every
interleaving walked (section "Verified sound"); the server prefetch is
row/order/cursor/log-line equivalent to its sequential arm. The findings are
two user-visible scroll consequences, one unmeasured server-cost consequence,
one test that cannot fail for the behavior it names, and LOW residue.

| # | Sev | Title |
|---|-----|-------|
| 1 | MEDIUM | `overflow-anchor: none` on the whole page makes every live update above the viewport slide the rows under a scrolled operator; a mis-click opens AND marks read the wrong row |
| 2 | MEDIUM | Back-button restore survives the reconcile only inside page one: past row `limit` the complete head read drops the tail and the restored scrollTop clamps |
| 3 | MEDIUM | 30 -> 100 rows per head read on paths the prefetch does not cover (Unread hydration, All-tab placement labels), re-paid on every SSE reconcile per dashboard - unmeasured |
| 4 | LOW | The stop-flag test cannot fail when the stop flag is removed (REPRODUCED) |
| 5 | LOW | Prefetch reads ahead of the fill point and logs WARNs for reads the page never used, after the assembled line; the equivalence suite's "off" arm is not main's path |
| 6 | LOW | An incomplete head read keeps a restored list unarmed and removes nothing; the Unread head read is incomplete whenever a full page carries a lag drop |
| 7 | LOW | SEEN_SET_MAX comment still computes the unread reach for 30-row pages |
| 8 | LOW | The action overlay covers the new time on hover and on keyboard focus |
| 9 | LOW | The time label has no clock: across midnight on an idle screen, yesterday's rows keep a bare clock time |
| 10 | LOW | The phone-name no-shrink rule recognizes NANP only; a non-NANP stub number can still lose digits |
| 11 | LOW | CSS source-text pins and a pixel-pitch-dependent e2e count are not layout coverage |

---

## 1. MEDIUM - Disabling scroll anchoring moves the list under a scrolled operator on every live update

**What is wrong.** `.page { overflow-anchor: none; }`
(dashboard/src/routes/inbox/Inbox.module.css:11) removes the entire inbox
subtree from anchor selection. The comment (Inbox.module.css:5-10) justifies it
for auto-load only - an appended page must push the sentinel down rather than
let the browser raise scrollTop and chain loads. But the rule is not scoped to
auto-load: it also disables anchoring for the SSE-driven head read, which is
the far more frequent mutation. On main the inbox had default anchoring, so a
row inserted, moved or removed ABOVE the viewport of an operator scrolled into
the list was compensated by the browser and the rows under the pointer stayed
put.

Now every such commit shifts the visible rows:
- a new conversation or a contact with new activity lands at the top (the
  complete head read, inboxListMerge.ts:110-121 via useInbox.ts:364) - the list
  under the pointer slides down one row;
- on Unread, a row read elsewhere leaves - the list slides up one row;
- a restored list (finding 2's path) is shifted by every row that arrived
  while the operator was away, even inside page one.

**Why it matters.** Opening a row is also a mark-read: `onOpen={inbox.markRead}`
(Inbox.tsx:386). A click that lands a moment after a reconcile commits opens
and marks read the neighbor of the intended row. On a busy inbox the reconcile
fires ~300 ms after each burst of `conversation.updated` (useInbox.ts:553-559),
so this is a routine event for an operator working below the fold, not a
corner case.

**Evidence.** Inbox.module.css:1-12 (the rule and its auto-load-only
rationale); main's Inbox.module.css had no overflow-anchor rule
(`git diff main...HEAD` shows it added); the only other opt-out in the app is
Timeline.module.css:142. Test coverage: e2e spec test 2
(inbox-rows-timestamps.spec.ts:175-217) asserts counts, the top row and that
the <ul> stays connected - never that the rows under the viewport hold still.
Inbox.styles.test.ts pins the declaration's presence.

**Implies.** The auto-load constraint and the live-update constraint want
opposite anchoring; the branch resolved it for auto-load only and did not
record the live-update cost. Not reproduced in a browser (jsdom has no
layout); the anchoring semantics are standard CSS Scroll Anchoring.

## 2. MEDIUM - The back-button restore only survives the reconcile inside page one

**What is wrong.** A restore mounts the saved list instantly (useInbox.ts:205-209)
and the page applies the saved scrollTop once (Inbox.tsx:192-198, latched by
`restoredRef`). The same mount then issues the reconcile head read
(useInbox.ts:448-464, no reset because the key matches). On the All tab that
read is a COMPLETE page in the ordinary case - the server mints a cursor only
when the page filled with `limit` contact rows, so
`headComplete = !truncated && (C === null || pagedP.length >= limit)`
(inboxListMerge.ts:106) is true - and branch C replaces the list and drops the
tail (inboxListMerge.ts:110-121, `tail: []`). For an operator whose saved
position was past page one (row > 100 at the default limit):
1. the restored rows and position appear;
2. about one head-read later the list shrinks to page one; the browser clamps
   scrollTop to page one's height;
3. the latch prevents re-applying the saved position;
4. auto-load (armed by the complete read) appends page two below the clamp.
The operator ends at the page-one/page-two boundary, not at the row they
opened.

**Evidence.** useInbox.test.tsx:973-982 pins the tail drop itself ("the
restore's complete head read replaces the whole restored list"). The e2e
"Option B trade, pinned deliberately" arm (inbox-rows-timestamps.spec.ts:268-287)
asserts row counts and request order at limit=2 and never reads scrollTop; the
scrollTop assertions (spec:252-265) run only at limit=10 where everything fits
in page one.

**Implies.** The code comments call the tail drop a deliberate trade (Option
B); what is not pinned or stated anywhere in the diff is that the headline
behavior - "the back button restores the scroll position" - does not hold for
any row beyond page one. The same collapse on every SSE reconcile while
scrolled past page one is parity with main (main's reconcile also replaced the
list with page one), so only the restore half is new. Combined with finding 1,
the collapse moves the list under the pointer as well.

## 3. MEDIUM (UNVERIFIED magnitude) - Page size 100 multiplies head-read work on paths the prefetch does not cover

**What is wrong.** DEFAULT_PAGE_LIMIT went 30 -> 100 (useInbox.ts:60) for every
filter, and every SSE `conversation.updated` re-runs the head read of the
current filter on every connected dashboard (useInbox.ts:553-563). The server
prefetch (inbox.ts:2375-2405) covers only the All tab's contact lookup,
conversation set and latest message. Uncovered:
- **Unread tab** (the tab the page's own comments call the one "an operator
  lives in all day", Inbox.tsx:84): candidates hydrate strictly sequentially
  (inbox.ts:1591-1592 `for ... await hydrateUnread(candidate)`), each a
  participant-set read, a latest-message read and a placement read
  (inbox.ts:1443-1505) - about 3.3x the sequential round trips per head read.
- **All tab**: the placement label stays a loop-only value cache
  (inbox.ts:954-965, read at inbox.ts:1081), so a page of 100 contact rows with
  placements still pays up to 100 sequential GetItems on the critical path.

**Evidence.** The diff changes the profiler plan to 100 rows
(app/src/lib/inboxDiagnostics.ts, createInboxProfilePlan) but carries no
measurement; I did not run the profiler (charter: no servers). Magnitude is
therefore UNVERIFIED; the direction (linear in `limit`, sequential on these two
paths) is read directly from the code.

**Implies.** Live-update latency on the Unread tab and per-event DynamoDB
spend scale with the new page size, multiplied by open dashboards, on exactly
the reads the prefetch was added to hide on the All tab.

## 4. LOW - The stop-flag test cannot fail when the stop flag is removed (REPRODUCED)

**What is wrong.** "the stop flag ends scheduling when the page fills: reads
stay near the page size, not the chunk" (app/test/inboxFeed.test.ts:2546-2570)
asserts `calls.listByConversation <= HYDRATE_CONCURRENCY + 1` at the moment
`aggregateInbox` returns (inboxFeed.test.ts:2565). With `slowReads` each read
waits one 1 ms timer; the request returns during the microtask drain after the
FIRST timer, before the second wave of reads can start. The counter at return
therefore measures only the first wave (8 workers) plus at most one read -
with or without a stop flag.

**Reproduction.** .superpowers/planner/adv/stopflag.test.ts against the real
module and a mutant (.superpowers/planner/adv/mut/inbox.nostop.ts, both
`prefetch?.stop();` lines at inbox.ts:2442 and :2466 removed), same scenario
(60 conversations, limit 1, 1 ms reads), run with
`npx vitest run stopflag --root app --dir <abs>/.superpowers/planner/adv`:

```
REAL:   at return 8, after 100ms 8,  bound 9
MUTANT: at return 9, after 100ms 25, bound 9
```

The shipped assertions (`> 1` and `<= 9` at return) PASS on the mutant, which
then reads the whole 25-item chunk.

**Implies.** The only guard on the concurrency bound is vacuous; a regression
of the stop flag ships green. Consequence is bounded (extra reads up to the
chunk), hence LOW. Sampling the counter after the request's in-flight chains
settle (as the repro does) is what distinguishes the two.

## 5. LOW - Prefetch read-ahead past the fill point; stray WARNs after the assembled line; the "off" arm is not main

**Equivalence - VERIFIED by reading.** Rows, order, cursor and the
`inbox feed assembled` fields (inbox.ts:2604-2625) are identical with the
prefetch on or off: the prefetch only warms three promise caches
(inbox.ts:865-941), never writes loop state (`drops`, `emittedContacts`,
`rows`, cursor), the caches never reject (each IIFE catches), the worker
catches defensively, and the loop performs the same awaits in the same order.
No unhandled rejection is possible. Work is bounded by the chunk
(`chunkSize <= FETCH_BATCH = 100`).

**What is wrong.**
- The workers are not paced to the loop. Everything they reach before
  `stop()` is read even if the page fills earlier (up to the rest of the chunk
  x 3 reads), and chains in flight at `stop()` finish after the HTTP response.
- A failure in any of those reads logs a WARN (inbox.ts:885, :916, :936) that
  the sequential path never emits, for a conversation that is not on the page,
  and it can land after the request's `inbox feed assembled` line. The comment
  "with the same WARN" (inbox.ts:786-792) holds per key, not per request.
- The equivalence suite (inboxFeed.test.ts:2419-2571) compares prefetch-on to
  prefetch-off, but both arms read through the new promise caches. In
  particular `resolveContact` is now memoized per (phone, email) pair
  (inbox.ts:897-923) where main looked up per conversation; nothing pins the
  new arm against main's behavior (the code comment at inbox.ts:901-906 says
  as much for the key). Observable only for two open conversations sharing a
  pair under a transient lookup failure.

**Implies.** Log readers can be misled by WARNs for rows the page never used;
DynamoDB read spend per request exceeds the page. LOW.

## 6. LOW - Incomplete head reads keep a restored list unarmed and stale

**What is wrong.** Branch I carries `autoLoadArmed` when the list has rows
(inboxListMerge.ts:138) and a restore always mounts unarmed
(useInbox.ts:188-189). After a restore whose reconcile is INCOMPLETE,
auto-load stays off until a complete head read or a manual Load more that
delivers new rows. Branch I also "removes nothing", so rows that left the
filter (read elsewhere, on another device or by another operator) keep their
stale counts on the Unread tab until a clean head read.

When is the Unread head read incomplete? Whenever `truncated` is set, and
`if (unresolvedDrops > 0) truncated = true;` (inbox.ts:1749). A lag-shaped drop
on a page that is already full is counted unresolved WITHOUT a retry
(inbox.ts:1654-1660) - which is the shape of a reconcile fired right after an
inbound on a busy (>= 100 unread) inbox, i.e. the moment the reconcile exists
for. Unknown (tiny partitions) and Groups rarely hit their budgets.

**Implies.** Transient (the next clean head read fixes both), hence LOW; but
the trigger correlates with the busiest moments rather than being random.

## 7. LOW - SEEN_SET_MAX comment computes the unread reach for 30-row pages

inbox.ts:257-272: "ends the feed at ~4 pages (120+ unread contact rows)". At
the dashboard's new 100 the depth cap trips at the end of page two (page one
holds <= 100 ids and still mints a cursor; page two exceeds 100 and returns
`nextCursor: null, truncated: true`), so the reach is up to ~200 contact rows
in two pages. The transport bound the comment defends is unaffected (a cursor
never carries more than 100 ids regardless of page size). Stale numbers only.

## 8. LOW - The action overlay covers the new time on hover and on focus

`.actions` is now `position: absolute` over the row's right end with an
opaque `background: var(--c-surface)` (InboxRow.module.css:214-229) and is
shown on `.row:hover` and `.row:focus-within` (InboxRow.module.css:230-235).
The time column is the row's right end (InboxRow.tsx:146-150), so the time -
and on an unread row, depending on the button's width, part of the unread
count beside it - is covered exactly on the row the operator is pointing at
or has tabbed to. The `<time title>` tooltip sits under the overlay. (On main
the actions box took layout width, `flex: 0 0 auto`, and covered nothing.)

## 9. LOW - The time label has no clock

The label is computed at render (InboxRow.tsx:77) and a memoized row relabels
only when the Inbox re-renders with a new `dayKey` (Inbox.tsx:215). With no
timer, an idle screen that crosses midnight keeps yesterday's rows showing a
bare clock time ("11:58 PM"), which reads as today, until any unrelated
re-render (the first SSE reconcile of the morning). The day-key test
(Inbox.test.tsx, "a render after local midnight relabels an unchanged row")
forces the re-render itself.

## 10. LOW - The phone-name no-shrink rule is NANP-only

`isPhoneName = /^\(\d{3}\) \d{3}-\d{4}$/` (InboxRow.tsx:74) matches only the
NANP display form; `formatPhoneForDisplay` returns the raw E.164 for any other
number (app/src/lib/phone.ts:73-77). A non-NANP stub contact therefore still
takes the name's shrink share and can ellipsize its last digits - the SQ-1
defect the rule was added for.

## 11. LOW - Source-text CSS pins and a pixel-pitch-dependent e2e count

- InboxRow.styles.test.ts and Inbox.styles.test.ts regex the TOP-LEVEL rule
  text. They pass if a later or more specific rule overrides the declaration,
  and they cannot see a missing dependency - e.g. the overlay pin checks
  `.actions { position: absolute }` but not the positioned ancestor
  (`.row { position: relative }`, InboxRow.module.css:10-11). The files say
  they are pins, not measurements; listed so they are not counted as layout
  coverage.
- e2e test 6 (inbox-rows-timestamps.spec.ts:387-417) asserts exact cursor
  request counts (1, then 2) derived from a measured 56.5 px row pitch at
  1280x400 (spec:393-395). A row-height change alters the scenario (the
  sentinel may stay in the margin and chain) and turns the test red or, worse,
  lets it pass on a different path.

---

## Verified sound (walked, no finding)

- **Head read commits while a page is in flight.** `firstPageGenRef` bumps on
  every head commit (useInbox.ts:359, :408); the page is refused
  (`reconcileStale`, useInbox.ts:527-530) and `loadingMore` clears in
  `finally` (useInbox.ts:545), re-enabling auto-load, whose epoch moved while
  disabled, so it re-observes once (useAutoLoad.ts:121-126). One wasted page
  when the head read was incomplete and kept the same cursor; harmless.
- **Filter change mid-request.** The effect bumps `filterGenRef`, aborts both
  requests, moves `activeFilterRef`/`keyRef` before fetching, and applies
  `loading` before the empty commit, so no empty snapshot is saved
  (useInbox.ts:433-466). Under React Router 7's transition rendering there is a
  window where the new filter is committed but the effect has not run; any
  commit landing in it writes the OLD list under the OLD key - consistent.
- **StrictMode.** Restore path: the replay takes the no-reset branch (the key
  matches `restoredKeyRef`), one live head read, the simulated unmount saves
  the shown scroll position (seeded only for POP, useInbox.ts:248). Fresh
  path: the simulated unmount saves nothing (status `loading`).
- **Sign-out.** Layout destroys of the deleted subtree (the unmount save,
  useInbox.ts:481-490) run in the mutation phase; AuthGate's clear is a
  passive effect of the surviving gate (AuthGate.tsx:23-25). React 19
  schedules the passive flush after the commit, so a promise settling between
  them sees `aliveRef` still true and can save - but the clear runs later in
  that same passive flush and wins; after it, `aliveRef` is false and every
  commit point refuses (useInbox.ts:358, :530, :660, :702).
- **Two operators / privacy.** Keys carry the operator id
  (inboxListStore.ts:187-189, Inbox.tsx:58); the store is in-memory only (no
  Web Storage); no new logging. /api/inbox is requireAuth only and
  operator-agnostic (app/src/routes/api.ts:1167-1186; aggregateInbox takes no
  principal), so even a cross-operator restore would show only what that
  operator can fetch. `?limit` is 1..100 on both sides and the server's
  parseLimit is unchanged. Two tabs share nothing (module scope per realm).
- **404 vs 500, with and without rows.** With rows rendered both keep the
  rows and raise the banner (useInbox.ts:395-399); without rows a 404 goes
  pending (after `applyStatus`, so no empty snapshot) and a 500 goes to error.
  Unchanged from main for the empty-list cases.
- **Unknown empty-page-with-cursor.** Branch I on an empty list takes the
  cursor and stays unarmed (inboxListMerge.ts:135-138); Load more renders on
  `hasMore` alone; the sentinel renders but cannot fire until a click delivers
  rows.
- **Stale restore.** Honest: a failed or 404 reconcile raises the banner over
  the restored rows. A hanging reconcile leaves stale rows with no indicator
  (no request timeout) - pre-existing request semantics, not new.
- **Auto-load report consumption.** Re-observe runs before consume in the same
  commit and marks queued reports consumed (useAutoLoad.ts:121-134); a real
  IntersectionObserver's pending entry is drained by `takeRecords` on
  re-observe and disconnect (useAutoLoad.ts:64-73).
- **Server caches shared with unread/unknown.** `contactConvsCache.delete` for
  the lag retry (inbox.ts:1651) works identically on a promise cache (the
  first read has settled by then). `latestRaw` memoization does not change the
  unread retry: a lag-dropped candidate returns before `buildContactRow`, so
  no latest-message read is cached for it. The unknown branch reads threads
  through `conversationsForContact` directly (inbox.ts:1880), outside the
  caches.
- **Perf classifier.** Exact `limit=100` arms for the four filters, badge by
  path, cursor reads refused by arity (collect.ts:180-191); the harness loads
  each source with `page.goto`, so the in-memory store cannot short-circuit a
  measured sample.
