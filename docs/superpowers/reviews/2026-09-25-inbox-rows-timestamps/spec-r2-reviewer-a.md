# Spec R2 adversarial review (reviewer A) - inbox rows + timestamps

Spec: `docs/superpowers/specs/2026-09-25-inbox-rows-timestamps-design.md` (DRAFT 3)
Inputs also read: `spec-r1-adjudications.md`, `spec-r1-reviewer-b.md`.
Repo read at: worktree `W:\tmp\inbox-rows-timestamps` (base cd8e8ddd).
Posture: adversarial, read-only. Every claim about current code cites a
file:line that was read; anything not verified is marked UNVERIFIED.

Order: new problems first (sections 1-17), then the adjudication contest
(section 18), then a verdict on whether the R1 fixes are correct (section 19).

---

## 1. [HIGH] Auto-load can run away on the All tab: the growth re-check plus Chromium scroll anchoring plus pages landing above old group rows chain page after page with no scroll

**What is wrong.** Three DRAFT 3 decisions compose into a loop that none of
them causes alone:

- 5.9 (accepted from R1-A14) states that on All, appended pages interleave
  ABOVE page one's older group/relay rows, so "the bottom of the list can stay
  old group rows".
- 5.2 adds a programmatic re-check: whenever `rowsVersion` (the rendered row
  count) changes, the sentinel is unobserved and re-observed, which delivers a
  fresh callback with the current intersection state.
- The scroller is `main.content` (`dashboard/src/app/AppFrame.module.css:383-387`),
  which has no `overflow-anchor` rule; the only `overflow-anchor: none` in the
  dashboard is on the contact timeline stream
  (`dashboard/src/routes/contact/Timeline.module.css:142`).

Walk it. The operator scrolls to the bottom of page one, which is the wall of
old group rows. The sentinel intersects, page two loads, and its 100 contacts
are sorted in ABOVE the group rows (`useInbox.ts:533-534` sorts the whole
accumulation). With CSS scroll anchoring on (the default), the browser keeps the
visible group rows fixed by raising `scrollTop` by the inserted height, so the
viewport still shows the group wall and the sentinel is still inside the 400px
margin. `rowsVersion` changed, so 5.2 re-observes, the fresh callback reports
intersecting, `enabled` is true, and page three loads. This repeats until the
appended contacts become OLDER than the oldest group row on page one (then rows
land below the anchor and push the sentinel out) or `hasMore` goes false. On an
org whose page one carries the 50th-newest group text from months back (the
spec's own "132 group threads", section 2 of R1), that is every contact active
since then: many 100-row server reads and a DOM far past the "100-300 rows"
that justified no virtualization (4.2).

**Evidence.** Spec 5.2 (re-check rule), 5.9 (consequence paragraph), 4.2
(virtualization out of scope); code cited above.

UNVERIFIED: whether Chromium selects an anchor node in this layout. The repo's
own measurement in `Timeline.module.css:118-142` records a case where Chromium
149 did NOT anchor, so anchor selection is heuristic. The consequence if it
does anchor is large enough to decide in the spec, not in self-QA.

**What it implies.** Either put `overflow-anchor: none` on the inbox scroller
content (and prove the re-check stops), or make the growth re-check fire only
when the sentinel was pushed out and came back. Add an e2e case at the
old-group-wall shape (fresh parties newer than the lean group rows, `?limit=2`,
scroll to bottom, assert a bounded number of cursor requests).

---

## 2. [HIGH] The 5.6 boundary rule assumes every tab's page one is cut by `lastActivityAt`; that is false on Unknown and on Unread

**What is wrong.** `keep(oldRow, wasInHead)` decides whether an absent head row
"slid out" by `oldRow.lastActivityAt < boundary`, with `boundary` the minimum
displayed `lastActivityAt` over `pagedP`. That is only meaningful when the
server's page one is the newest-N by the same field.

- **Unknown** pages in QUEUE order, not activity order: "IT IS NOT THE ORDER THE
  OPERATOR SEES ... Untriaged-first is a property of the FETCH"
  (`app/src/routes/inbox.ts:2230-2246`); the partition is byTypeStatus, hash
  `type`, range `status` (`app/src/lib/unknownQueue.ts` header, "byTypeStatus is
  (hash: type, range: status)"), and new contacts get a random id
  (`app/src/repos/contactsRepo.ts:1157`, `contact-${randomUUID()}`). A new
  unknown number - the tab's main event - can land anywhere in page one and
  push the last page-one row out. That row's activity is unrelated to the
  boundary (the OLDEST activity among 100 queue-ordered rows is typically old),
  so it is usually "at or above the boundary" and DROPPED. With a tail loaded,
  the kept cursor is past it: the row is gone for the session. Conversely a
  triaged row (re-typed out of the partition) with old activity is KEPT as a
  stale "Needs triage" row.
- **Unread** walks the byUnread index by the newest UNREAD thread, but a
  contact row DISPLAYS its newest thread of any state: "The stream ordered them
  by newest UNREAD activity, and for a multi-thread contact whose newest thread
  is read the two differ" (`inbox.ts:1622-1628`; identity is the seen-set, not
  newest-conversation, `inbox.ts:1434-1438`). Such a contact sits low in the
  walk but displays a recent time. When new unread arrivals push it off page
  one, its displayed time is above the boundary, so keep() drops it; the kept
  tail cursor's seen-set already contains it (the old chain emitted it,
  `inbox.ts:1552`), so no later page re-emits it. Lost for the session.

The "Why this delivers the guarantees" paragraph and invariant 1 ("rows slide,
they do not vanish") are claimed for all tabs. They hold on All (the pager walks
byLastActivity, `inbox.ts:2305-2310`) and presumably Groups (UNVERIFIED: the
group partition's sort was not read). They do not hold on Unknown or Unread.

**What it implies.** On Unknown and Unread either keep every absent head row
unless `C === null`, or define the boundary in each branch's own ordering. The
7.1 merge tests must include an Unknown case and an Unread multi-thread case.

---

## 3. [HIGH] Tail rows are never refreshed, and the spec's stated exits from staleness do not exist in the mechanism

**What is wrong.** Under 5.6 a row that is in the tail and absent from `P` is
kept whenever `C !== null` (`!wasInHead -> true`). A tail row is refreshed only
if it re-enters page one: new activity on it, or so many newer rows closing
that page one reaches back to it. The spec says a stale tail row lasts "until it
scrolls out or a head read's boundary reaches it" (5.6, section 8). Neither
happens:

- Rows never "scroll out": `head`/`tail` are arrays that nothing prunes, and the
  store (5.8) carries them across every navigation for the whole page session.
- The boundary is the OLDEST row of the newest page; as activity arrives it
  moves NEWER, away from tail rows, not toward them.

So on a busy inbox a loaded tail is frozen for the day. Concretely:

- **The operator's own actions.** The row an operator opens is very often a
  tail row (that is why she scrolled). On the contact page she triages it (an
  unknown row keyed `u:<phone>` becomes a contact keyed `c:<id>`,
  `useInbox.ts:104-108`), deletes it, renames it, or changes its placement. None
  of those is activity. Back (POP) restores the snapshot, the reconcile keeps
  the tail row, and the pre-action row (old name, "Needs triage", no "Deleted")
  stays on screen indefinitely. The optimistic patches cover only mark-read and
  mark-unread (5.6 bullet). Today the Back re-mount replaces the list with page
  one, so the stale row is never shown.
- **Other operators.** A row another staff member reads keeps its red count on
  Sam's All tab, and on her Unread tab stays listed as unread (a tail row is
  kept, and the Unread narrowing reads its stale `unreadCount`), while the
  server-counted badge says otherwise.

**What it implies.** The trade-off in section 8 is described as bounded and it
is not. Either bound the tail's life (drop the tail on a store restore and let
auto-load rebuild it, or re-read tail pages on POP), or restate the trade-off
honestly as "tail rows are frozen until a reload" and put it in front of Sam.

---

## 4. [MEDIUM] The cursor rule `cursor ?? C` reopens paging over rows the list already holds whenever the list was fully loaded

**What is wrong.** 5.6: `cursor := newTail.length > 0 ? (cursor ?? C) : C`. A
null old cursor with a non-empty tail means the tail reaches the END of the
feed, not "no cursor". Installing `C` then re-walks from the head boundary over
rows the list holds.

Walk 7.3 test 2 itself: four contacts plus the two multi-party rows are fully
loaded (`cursor = null`). A fifth party's inbound triggers a head read at
`limit=2`: `P = [p5, p4, relay, group]`, `C` non-null, `headComplete` true;
p3 slides to the tail; `newTail` is non-empty; `cursor := null ?? C = C`. Load
more reappears, auto-load re-reads p3/p2, then p1/Tasha, every row deduplicated
away (5.5), until the cursor is null again. The test still passes (row counts
survive the dedupe) while the defect ships. At `limit=100` on a fully loaded
All tab, that is two or three wasted 100-row reads after EVERY SSE event.

Side effects:

- On a fully cleared Unread list the empty copy switches from `emptyCopy` to
  `emptyClearedCopy` because `hasMore` is spuriously true (`Inbox.tsx:64-66`).
- A tail that ended on the Unread depth cap (null cursor + `truncated`,
  `inbox.ts:1655-1660`) loses its end state; the head's `truncated` replaces
  the flag (5.6) and the re-walk rediscovers the cap.
- Arming on an all-duplicate page is undefined (pre- or post-dedupe count).

The same holds in the budget-short case the rule was written for: if the old
cursor was null, the kept rows already reach the end.

**What it implies.** `cursor := newTail.length > 0 ? cursor : C`. There is no
case walked here where `?? C` is right.

---

## 5. [MEDIUM] A zero-row budget-exit head read on Unread has `C === null`, so `headComplete` wipes the whole list

**What is wrong.** On Unread the server nulls the cursor on ANY zero-row page
(`inbox.ts:1714`), including a budget-spent walk, which it reports as an early
end with `truncated: true` (`inbox.ts:1634-1645`, "Consuming nothing while the
budget died first is a real early end"). `headComplete := C === null || ...` is
therefore true, and `keep()` returns false for every absent row (`C === null`
arm), so `head` and `tail` both empty. With `serverRowCount === 0 &&
truncated`, `Inbox.tsx:79` and `:220` render "We couldn't load your inbox." over
what was a healthy list - the exact outcome decision 7 forbids, reached by a
SUCCESSFUL read. `headComplete` never consults `truncated`.

**What it implies.** `headComplete` must be false whenever the page says
`truncated` (a non-natural end). Pin it in the 7.1 merge tests.

---

## 6. [MEDIUM] `rowsVersion` (the rendered row count) is the wrong re-check trigger; the promised re-issue of a discarded `loadMore` usually never happens

**What is wrong.** 5.6 and section 8 say a head read that discards an in-flight
`loadMore` is recovered because "auto-load's growth re-check then re-issues it
if the sentinel is still in view". The re-check fires only when the rendered
row COUNT changes. Most head reads do not change it: a text from a contact
already on screen moves that row to the top; a mark-read on All changes a count
pill. The page is discarded (`useInbox.ts:339-342`), `loadingMore` clears, the
sentinel is still intersecting, no crossing occurs, no re-observe happens, and
auto-load stalls until the operator scrolls away and back or clicks. The
unchanged-count case is the common case, so section 8's "the delay is one head
read, not a starvation" is false as specified. The same stall follows a page
whose rows were all deduplicated (finding 4).

**What it implies.** Trigger the re-check on a page-commit counter (every
committed head read or `loadMore`), not on the row count. That still excludes
failed pages, which is what the no-tight-loop argument needs.

---

## 7. [MEDIUM] Commit-point saves outlive the hook instance: zombie writes after unmount and after sign-out's `clear()`

**What is wrong.** 5.8 saves at "the `loadMore` commit, the optimistic commit and
rollback in `markRead`/`markUnread`". Those continuations outlive the component:

- `loadMore` is NOT aborted on unmount. The filter effect's cleanup aborts only
  the head read (`useInbox.ts:311`); `loadMoreAbortRef` is aborted only on a
  filter change (`useInbox.ts:291`). A page in flight when the operator clicks
  a row resolves after unmount, passes both staleness guards (nothing bumped
  them), and reaches the commit-point save.
- `markRead`/`markUnread` POSTs resolve in `.then`/`.catch` after unmount
  (`useInbox.ts:462-476`, `509-517`); the row click that navigates is exactly
  what starts one (`InboxRow.tsx:94`, `onClick={() => onOpen(row)}`).

Consequences: (a) after sign-out the AuthGate passive `clear()` runs, and a
late continuation then writes a snapshot back - invariant 7's first clause
("Sign-out clears the store") is false; the operator-id key only limits who can
restore it. (b) Open a row, Back quickly: instance B restores and commits a
fresh snapshot; instance A's late continuation then overwrites it with A's older
state, and the next restore shows the older list.

**What it implies.** Saves must be dropped once the instance has unmounted (an
alive ref checked at every save), and `loadMore` should be aborted in the
unmount cleanup.

---

## 8. [MEDIUM] Commit-point saves have no specified source for the committed value

**What is wrong.** 5.8 forbids "a generic effect over `base`" and requires saves
at the commit points. But those commit points install state with functional
updates whose results React has not applied yet (`setBase((prev) => [...prev,
...pageData.rows])`, `useInbox.ts:343`; the markRead commit, `:470`). A save
written next to those calls that reads the current state or mirror refs
persists the PRE-commit rows while the same save writes the POST-commit cursor
(taken from the page). Restoring that snapshot yields a list with a hole: the
cursor points past a page whose rows are not in the snapshot, and they are never
fetched again. The spec gives no mechanism (a reducer that computes the next
state explicitly, or a layout effect keyed on a commit token that carries the
captured key).

**What it implies.** Name the mechanism. A layout effect keyed on a commit
counter, with the key captured at commit time, satisfies both "never a generic
effect over base" and "save the committed value".

---

## 9. [MEDIUM] The scroll ref must be seeded from the restored value, or StrictMode's simulated unmount (and any exit before a scroll event) saves 0

**What is wrong.** 5.8 moves the unmount save into a LAYOUT-effect cleanup and
feeds `scrollTop` from a ref kept current by a passive scroll listener. Section 2
states the app runs under StrictMode in development and in the e2e harness.
StrictMode replays effects on mount: layout cleanups run, then layout effects
run again. On every store-hit mount the unmount save therefore runs once
immediately, before any scroll event - the restore's programmatic `scrollTop`
write dispatches its `scroll` event asynchronously, and the listener is attached
in a passive effect. Unless the ref starts at the snapshot's value, that save
writes `scrollTop: 0` into the store. Whether the visible restore survives
depends on whether the restore effect re-reads the store on its replay, which
the spec does not say. Independently of StrictMode: Back (restored to row 180),
then open another row before any scroll event has fired - the save writes the
ref's initial value.

7.3 test 3 does one round trip, so it cannot see the second case.

**What it implies.** Seed the ref from the restored snapshot and update it when
the restore writes `scrollTop`; add a second round trip to test 3.

---

## 10. [MEDIUM] `.name { max-width: 40% }` resolves against `.head`, not the link: every name gets truncated with dead space beside it

**What is wrong.** 5.4 gives `.name` "max-width: 40% of the link". `.name` is a
child of `.head`, not of the link (`InboxRow.tsx:96-100`), so a percentage
max-width resolves against `.head`'s used width. `.head` becomes `flex: 0 1
auto`, so its basis is its max-content width (the full name plus chip plus
tags; a cyclic percentage is ignored for that intrinsic contribution). The name
is then capped at 40% of a box sized to hold all of it. A contact row always
has a chip ("Text", `InboxRow.tsx:101`), so a 150px name next to a 30px chip is
cut to about 75px with about 75px of blank space before the chip - at every
width, on every row, including when there is plenty of room.
UNVERIFIED in a browser; this is the CSS sizing rule for percentages in the
child of a flex item.

**What it implies.** Put the cap on `.head` (a child of the link), or cap the
name with a length, and add a wide-viewport assertion that an ordinary name is
not ellipsized.

---

## 11. [LOW] "Refs written every render" fails the repo's lint gate; the repo's alternative reopens a one-commit stale window

5.2 keeps `enabled` and `onLoad` "in refs written every render". The dashboard
lints non-test files with `recommended-latest` (`eslint.config.mjs:48-51`),
which includes `react-hooks/refs` at error severity ("not reading/writing during
render"; `node_modules/eslint-plugin-react-hooks/cjs/eslint-plugin-react-hooks.development.js:18232-18239`),
so gate 5 fails on the new `useAutoLoad.ts`. The repo's precedent writes the
ref in a passive effect (`dashboard/src/api/useEventStream.ts:20-27`). Then an
observer callback delivered between a commit and that effect calls the previous
`loadMore`, whose closure still has `loadingMore: false`; it aborts the live
page and re-issues it (`useInbox.ts:327`). Not a loop, but the spec's "no stale
closure can ... abort a live page" is not what the lint-clean version delivers.
Use a layout effect for the ref write, or state the window.

## 12. [LOW] Arming: the mount reconcile re-arms at once, so the restore protection lasts one round trip

5.2 says "a restored list restores `autoLoadArmed` with it, so the Unknown tab
does not re-fire a cursor that just returned an empty budget page". 5.6 then sets
`autoLoadArmed := P.length > 0` on every head read, and 5.8 runs a head read
immediately on every store-hit mount. On Unknown, P is non-empty, so the list
re-arms within one round trip, and with a kept tail cursor (5.6) the next
re-check fires the same empty-budget cursor again. The same happens after every
SSE head read. Bounded (one wasted budget read per head read), but the stated
consequence is not what the rules produce. Arm from `loadMore` results only,
or keep the disarm while the cursor is unchanged.

## 13. [LOW] Boundary ties: strict `<` drops a slid row whose `lastActivityAt` equals the new boundary

If the row that slides out shares its timestamp with the new last row of `P`,
`keep()` returns false ("one at or above it would have been returned"). With a
tail loaded, the kept cursor is past it, so it is lost. Ties are real where
timestamps are written in bulk (the importer writes historical activity,
`app/src/lib/import/apply.ts:1101`, `:1213`; the lean seed uses fixed instants,
`app/src/lib/seed/lean.ts:18-30`). Use `<=` together with the rowKey check.

## 14. [LOW] "The server returns EVERY additive row on EVERY head read" is false

`listRelayGroups` failures are swallowed with a WARN (`inbox.ts:2384-2390`), and
the relay list has a page budget that omits groups (`inbox.ts:2392-2397`). A head
read with a transient relay-list failure returns no relay rows and no signal, so
keep()'s `additive -> false` drops every relay row until the next read. Today's
`setBase(P)` does the same, so this is not a regression, but the stated
rationale for the additive arm is wrong and invariant 1 inherits it. Say so.

## 15. [LOW] 5.10 prefetch details that can break "identical"

- `latestMessageOf` returns `deriveLatest(latest, conv)`, which falls back to
  `conv.last_message_preview` (`inbox.ts:663-666`, `:722-736`). The prefetch
  calls it with the chunk's byLastActivity image; the loop calls it with
  `maxConv`, the participant-GSI image (`inbox.ts:970`). Memoizing the DERIVED
  result by conversation id bakes one image's fallback preview into the other
  call. Only the raw `messages.listByConversation` read may be memoized. The
  immediate-resolving fakes (`app/test/inboxFeed.test.ts:3`) serve identical
  images and cannot catch it.
- Section 2 and 5.10 speak of an existing "contact cache"; there is none -
  `findByPhone`/`findByEmail` run uncached per conversation inside one try/catch
  (`inbox.ts:1079-1086`). Caching them means restructuring that block, and a
  degraded value logged inside a prefetch adds WARN lines for conversations the
  loop never consumes.
- The window keeps issuing chains after the page fills and after the response
  is sent (bounded at one chunk, about 300 reads).
- The caches are shared closures used by the unread branch too
  (`inbox.ts:1388`, `:1591`), so "the unread and unknown branches are not
  touched" is loose; the lagged-retry cache delete must keep working on a
  promise cache.

## 16. [LOW] Factual and scope slips in DRAFT 3

- The key uses `me.id`; the type is `me.userId` (`dashboard/src/api/types.ts:10-14`).
- `useInbox(filter, limit)` would need the session for the key; calling
  `useAuth()` inside it throws in every existing hook test, which mounts no
  provider (`dashboard/src/app/AuthContext.tsx:57-63`;
  `useInbox.test.tsx:15-33` mocks only the api and UnreadContext).
- `AuthGate.tsx` is edited (5.8, 7.1) but is not in 4.1's in-scope list.
- "The sidebar takes 220px": it is 240px (`dashboard/src/ui/tokens.css:145`), so
  at 768px the row is about 480px, not "at least about 500px"; 800x720 is not
  "the tightest one-line band" (768 is).
- `max-width: 767px` versus the shell's `767.98px` (`useNavChrome.ts:17`)
  leaves a sub-pixel band in drawer mode with the one-line row.

## 17. [LOW] 7.3 test 2's "never detached" assertion cannot be made with a Locator

Playwright Locators re-resolve on every use, so "keep a locator handle and
assert its row count only grew" cannot detect a detach-and-rerender. It needs an
ElementHandle checked with `isConnected`, or a MutationObserver installed in the
page before the inbound.

---

## 18. Contest of the adjudications

- R1-A17, mockup half (REJECT): concede. 5.4 now describes both layouts in
  buildable terms.
- R1-A19, pinning test (PARTIAL): concede. Updating the issue is proportionate
  for a LOW, and the strict `>` holds (`inbox.ts:1655`).
- No other finding of mine was rejected. Accepted findings whose fixes
  introduced new problems are raised above as new findings (1, 3, 4, 6, 7, 8,
  9, 10), not as reopenings.

## 19. Are the R1 fixes correct?

- R1-A1/B1 (row loss on All): FIXED for All. Walked: page one plus
  groups, one new contact - c100 is kept at the front of the tail and the
  cursor still addresses after it; a second head read keeps both slid rows.
  Not fixed on Unknown/Unread (finding 2).
- R1-A2/B2 (budget-short heads): fixed for a short page with a cursor; not for
  Unread's zero-row budget exit (finding 5).
- R1-A3/B4 (Retry refresh): correct. With rows, no `'loading'`; a failure keeps
  `'ready'` and the banner; the generation guard can discard a retry, but the
  mark-read's own SSE reconcile then clears the banner (`useInbox.ts:218-223`).
- R1-A4 (sign-out order): correct as specified for the layout-cleanup save and
  a passive AuthGate effect (passive unmounts, then passive mounts). Broken by
  late continuations (finding 7).
- R1-A5/B3 (observer lifecycle): the no-tight-loop argument now holds; the
  re-check trigger is wrong (finding 6) and interacts with scroll anchoring
  (finding 1).
- R1-A6/A7/B5 (5.10): the prefetch design is sound in principle (the loop,
  dedupe and drops are untouched); see finding 15 for the memo key.
- R1-A8 (Unread re-emission): correct; the append-time dedupe closes it.
- R1-A9/B7/B8 (store mechanics): the key capture and the StrictMode
  `restoredKeyRef` rule are correct as walked (store hit: reconcile on both runs,
  one survives; store miss: reset, abort, replay reconcile). The save content
  source (finding 8) and zombie saves (finding 7) remain.
- R1-A10/B6 (scroll capture): correct capture point; seeding is missing
  (finding 9).
- R1-A11 (POP): correct.
- R1-A13/B9 (layout): the actions overlay fixes the ragged column; the name cap
  is mis-specified (finding 10).
- R1-A15 (test isolation): correct; the new auth dependency adds a second
  isolation need (finding 16).
- R1-A16/B10 (Playwright): tests 2-5 are now runnable against the lean world;
  test 2 exercises finding 4 without detecting it.
- R1-A20/A21, B16, B17: correct.
