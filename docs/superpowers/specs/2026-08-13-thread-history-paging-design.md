<!-- HISTORICAL-RECORD -->
> **HISTORICAL RECORD - completed, merged, and frozen (2026-08-16).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.

# Thread History Paging - Design and Scope

- Date: 2026-08-13
- Status: Ready for human review
- Owner: Cameron Abt
- Branch: `feat/thread-history-paging`

## 1. Problem

Staff cannot reach conversation history older than the newest 50 entries through
the dashboard. The records exist and both backend endpoints already page
backwards; the frontend never asks.

Three data hooks read exactly one page and expose no way to ask for another:

- `dashboard/src/routes/conversation/useRelayThread.ts:196` calls
  `getConversationMessages(conversationId, signal)`.
- `dashboard/src/routes/conversation/useGroupThread.ts:128` does the same.
- `dashboard/src/routes/contact/useContactTimeline.ts:141` receives a real
  `nextCursor` from the server and discards it, returning only
  `{items, upcoming, upcomingTimezone, source}`.

The client function itself has no paging parameters at all:
`getConversationMessages` at `dashboard/src/api/endpoints.ts:481` accepts only
`(conversationId, signal)`. The capability is missing from the call, not merely
unused by the caller.

The servers are correct and already support the older pages:

- `GET /api/conversations/:conversationId/messages` (`app/src/routes/api.ts:1817`)
  takes `limit` (default 50, max 100) and `before`, an exclusive `tsMsgId` bound
  that pages backwards.
- `GET /api/contacts/:id/timeline` (`app/src/routes/contactTimeline.ts:938-942`)
  computes and returns `nextCursor` whenever the candidate pool exceeded the
  page.

No UI affordance for older history exists anywhere under `routes/conversation`
or `routes/contact`. The only paging controls in the dashboard are the
Broadcasts list and the Unmatched Email triage queue.

### 1.1 Who is affected

All five surfaces that render the shared `<Timeline>` from a capped hook:

| Surface | Component | Hook |
| --- | --- | --- |
| Relay conversation | `conversation/ConversationDetail.tsx:465` | `useRelayThread` |
| Group text | `conversation/GroupTextView.tsx:434` | `useGroupThread` |
| Contact file | `contact/ContactCommsPane.tsx:319` | `useContactTimeline` |
| Tour comms | `tours/TourConversation.tsx:464` | `useRelayThread` + `ContactCommsTab` |
| Placement comms | `placements/PlacementConversation.tsx:320` | `useRelayThread` + `ContactCommsTab` |

The tour and placement hubs are the operator's most-open pages and inherit the
ceiling through the shared hooks.

### 1.2 Why it is easy to miss

SSE appends push a thread past 50 entries while it is open, so the truncation
only appears after a reload or a navigation away and back. QA on a live session
will not surface it; a staff member returning to a long-running conversation
will.

## 2. Goal

Staff can reach every message and timeline entry in a conversation through the
dashboard, on all five surfaces, without losing their place when a live message
arrives.

## 3. Locked decisions

1. **Explicit button, not infinite scroll.** A "Load older messages" control
   renders above the oldest entry and only when older entries exist. It follows
   the existing `loadMore` precedent in `routes/broadcasts/BroadcastsList.tsx`
   and `routes/email/useUnmatchedEmail.ts`. Scroll-triggered auto-loading is out
   of scope; it needs the same anchor math plus scroll listeners that are flaky
   under jsdom and Playwright.
2. **Loaded history survives live events.** A live refetch never discards older
   pages the operator has loaded.
3. **One merged state slice, not two.** See section 4.1 - the two-slice version
   has a correctness hole.
4. **Page size is 50**, the server default, for both the button and the initial
   load.
5. **`hasOlder` for conversations is a client-side heuristic.** See section 4.4,
   including its one accepted trade-off.
6. **The contact-timeline fallback path shows no button.** The 404-assembled
   fallback in `useContactTimeline` has no cursor to page with.
7. **Frontend-only change.** No route, repo, or schema changes.

## 4. Design

### 4.1 State: merge, never replace

The obvious design - hold older pages in their own state slice and let the SSE
refetch replace only the newest-page slice - has a gap bug.

The newest page is *the newest 50*, not a fixed window. If the operator has
loaded three older pages and five new messages then arrive, the refetched
newest-50 no longer contains the five oldest messages it contained a moment ago.
Those five are not in the older slice either, because they were never fetched as
part of an older page. They would silently disappear from the middle of the
thread, leaving a hole between the older pages and the newest page.

The fix is to keep ONE slice and make every fetch a merge keyed by message id:

```
setServerItems(prev => mergeById(prev, freshPage))   // SSE refetch
setServerItems(prev => mergeById(prev, olderPage))   // Load older
```

`mergeById` unions by id and prefers the FRESHEST copy for ids present in both,
so delivery-status updates still land. Nothing the client has already seen is
ever dropped, which closes the window-shift gap above. Result ordering stays
chronological by the existing sort.

**What merging does NOT guarantee** (corrected after the final review; the
original wording here overclaimed): it fills no gap it never fetched. If more
than ONE PAGE of new entries lands between two refetches, the newest page no
longer overlaps what is held, and the union is two blocks with an unfetched hole
between them - and unlike the truncation this feature replaces, that hole is
invisible, because the transcript reads as continuous. Volume alone does not
reach it, since every persisted message schedules a refetch; the realistic
trigger is a gap in the SSE stream (a backgrounded tab, a sleep, a reconnect),
which has no replay and no resync. Tracked as
`thread-merge-leaves-a-hole-after-an-sse-gap`. Merging remains the right default
- it strictly dominates replacing, which dropped paged-in history on every
refetch - but it is a mitigation, not a proof of continuity.

Accepted consequence: an entry deleted server-side lingers in an open thread
until the operator navigates away. Messages are not deleted in this product, and
a stale-but-present bubble is a far smaller defect than a hole in the middle of
a transcript. This gets a code comment where the merge lives.

Switching conversations resets the slice outright rather than merging. Each hook
tracks the `conversationId` (or `contactId`) its state belongs to and replaces
instead of merging on the first fetch for a new id.

### 4.2 API client

`getConversationMessages` gains paging and moves to the `(id, opts, signal)`
shape already used elsewhere in `endpoints.ts` (`getTourActivity` and
`getPlacementHistory`; located by name, because line numbers drift - an earlier
revision of this spec cited `getContacts`, which actually takes `(params, signal)`
with no leading id and is NOT the precedent):

```ts
export async function getConversationMessages(
  conversationId: string,
  opts: { limit?: number; before?: string } = {},
  signal?: AbortSignal,
): Promise<Message[]>
```

Three non-test call sites update. TypeScript rejects a missed site, because an
`AbortSignal` is not assignable to the opts type.

### 4.3 Hooks

All three gain the same four members on their returned state:

- `hasOlder: boolean` - whether a "Load older" control should render.
- `loadingOlder: boolean` - a fetch is in flight; the control is disabled.
- `loadOlder: () => Promise<void>` - fetch and merge one older page.
- `olderPagesLoaded: number` - incremented only when an older page has merged.
  This is the renderer's ONLY reliable signal that a prepend happened; see
  section 4.5 for why nothing observable from the item list can replace it.

`useRelayThread` and `useGroupThread` page with `limit = 50` and
`before = <oldest RAW fetched tsMsgId>`, tracked in a ref from the last element
of each newest-first `Message[]` page.

The bound must come from the raw page, NOT from the mapped `TimelineItem[]`:
`toTimelineMessage` drops calls and email, so a page of 50 can map to fewer
items - or, in the limit, to none. Deriving `hasOlder` from the raw count while
deriving `before` from mapped items would let a fully-dropped page render a
button that can never page, which would contradict section 4.4's guarantee that
no history is unreachable. Both values come from the same collection.

`refresh()` on `useGroupThread` is a REPLACE, not a merge: it clears the
loaded-id ref before refetching, so the error-state retry cannot union a stale
transcript into a fresh one.

`useContactTimeline` keeps `page.nextCursor` in state and passes it back with
the current `kinds` filter. `upcoming` and `timezone` remain first-page-only:
the server deliberately gathers the scheduled bucket only when `cursor` is
absent (`app/src/routes/contactTimeline.ts:964`, a three-part condition - :955-959
is only the comment above it), so an older page must not
clobber them. `source` is unchanged by paging.

The 404-assembled fallback path reports `hasOlder: false`.

### 4.4 The `hasOlder` heuristic and its trade-off

`GET /api/conversations/:id/messages` returns a bare `{messages}` array with no
`hasMore` flag, unlike the timeline route's real `nextCursor`. Rather than
change a hot route for a cosmetic signal, the client infers it:

> A page that came back FULL (returned count === requested limit) means there
> are probably older entries.

**Accepted trade-off, to be recorded as a code comment at the computation:** on
a thread whose length is an exact multiple of the page size, the button shows
once when nothing older exists. Clicking it fetches an empty page and the button
disappears. The label can therefore be momentarily wrong; it is not wrong in the
dangerous direction, because a full page always means more may exist and a short
page means the end has been reached.

**One caveat on "a short page means the end", carried in the code comments
beside the computation** (`useRelayThread.ts`, `useGroupThread.ts`): that half is
a property of `messagesRepo.listByConversation`, which passes `Limit` to a
DynamoDB Query and DISCARDS `LastEvaluatedKey`. A Query that hits DynamoDB's 1MB
read cap returns fewer items than `Limit`, so a capped page would also read as
end-of-history - the control retires and the pages behind it become unreachable
without a reload. At `limit=50` and a realistic 1-3KB per message row the cap is
roughly an order of magnitude away, so this is not called live; it is why the
rule is a heuristic rather than an invariant, and it is a second reason to prefer
the alternative below. Outside that cap, no history is unreachable as a result of
the heuristic.

The honest alternative - fetch `limit + 1` server-side, trim, and return
`hasMore` - is deferred, not rejected. It is roughly six lines plus a route
test. If the false label proves irritating in practice, that is the fix.

The contact timeline is unaffected: it uses its authoritative `nextCursor`.

### 4.5 Timeline UI and scroll anchoring

`Timeline.tsx` gains ONE optional prop, `paging?: TimelinePaging`, carrying
`hasOlder`, `loadingOlder`, `olderPagesLoaded`, and `onLoadOlder`. Callers that
pass nothing are behaviorally unchanged, which covers every caller not in scope
here.

One object rather than four sibling props, because the four are meaningless
apart: `loadingOlder` disarms a stale anchor and `olderPagesLoaded` consumes it,
so a caller supplying only `hasOlder` and `onLoadOlder` gets a control whose
scroll anchoring silently never fires - typecheck-green and invisible in review.
As four optional props that contract can only be prose; as one object the
compiler enforces it.

The control renders above the stream with the accessible name
"Load older messages", per the accessibility-first selector rule in
`e2e/support/selectors.md`. Because it sits outside the scroll container it is
always visible while older history exists, rather than something the operator
must scroll up to find. Clicking it while pinned at the bottom is legitimate and
its only feedback is the label change to "Loading..." and, at the end of
history, the control retiring - the transcript deliberately does not move.

It stays visible when the stream renders empty. That is not a cosmetic slip: if
the "Comms only" filter hides every entry on the current page, the control is
the only way to reach the pages behind it WITHOUT abandoning the filter. Turning
the filter off also reveals them, but requiring that would mean the operator has
to give up the view they chose in order to keep reading.

It sits OUTSIDE the scroll container (in `.streamWrap`, above `.stream`), not
inside it. Inside, the control would contribute to `el.scrollHeight` and then
unmount in the same commit as the final prepend - the pass where `hasOlder`
flips false - so the restored offset would under-shoot by the control's own
height on the last "Load older" of every thread. Outside, only prepended content
changes the height, and the delta math is exact.

**Corrected after live measurement.** The delta math IS exact outside the
container - that half held. What this reasoning missed is that the control's
unmount still REFLOWS the container it sits above: `.streamWrap` is a flex
column, so when the row disappears on the final click `.stream` grows into the
vacated space and its top edge moves up by the control's height. Measured at
41.78px in Chromium, against 0.69px on every non-final click. Moving the control
outside converted a scroll-offset error into a layout shift of the same
magnitude rather than eliminating it. No unit test can see it (jsdom performs no
layout) and the e2e assertion compares `scrollTop` to `scrollHeight`, both
internal to `.stream`. Tracked as
`load-older-control-unmount-jumps-the-reader`, deferred by the human with the
remedy left open.

The subtle part is scroll. The existing layout effect at
`Timeline.tsx:1132-1153` reacts to a grown item count by setting `hasNewBelow`,
which would fire a spurious "new messages" pill for a PREPEND - content that
landed above the operator, not below.

The prepend path therefore:

1. records `el.scrollHeight` immediately before invoking `onLoadOlder`;
2. consumes that anchor on the layout pass where the hook reports that an older
   page actually merged, setting `el.scrollTop += el.scrollHeight - height` so
   the bubble the operator was reading stays exactly where it was;
3. suppresses the `hasNewBelow` pill for that pass;
4. on every intervening pass, RE-BASELINES `height` to the current
   `el.scrollHeight`, so anything that lands between the request and the prepend
   is excluded from the restore delta.

**Consumption is driven by a fact, not a heuristic.** Each hook exposes
`olderPagesLoaded`, a counter incremented only when an older page has merged
into state, and `Timeline` consumes the anchor on the render where that counter
changes. Two weaker rules were tried and both are wrong:

- Keyed on "the next pass where the count grew": the hooks refetch on a 300ms
  SSE debounce, so an inbound message easily lands WHILE the older page is in
  flight. It would steal the anchor - scrolling the reader by the height of a
  message that arrived below them, swallowing that message's pill, and leaving
  the real prepend to raise the spurious one this section exists to prevent.
- Keyed on "the first rendered item id changed": `clusters` derives from the
  FILTERED `visible`, not from `items`, so the "Comms only" toggle and
  retry-collapse both change the first rendered item with no prepend at all.

A counter from the hook is immune to all of it: appends, filter toggles, retry
collapses, and empty older pages leave it untouched.

Accepted residual, stated in full: if an append and the older page land in the
SAME batched render, the consume branch both counts the append's height into the
restore delta AND returns before the pill logic, absorbing the new count. So the
reader is mis-positioned by the height of whatever arrived - a 300ms debounce can
coalesce a burst, so "one message" is the floor, not the bound - and that
message's "New messages" pill is skipped. It cannot lose or duplicate content,
and it requires an inbound to arrive inside the older page's flight window.
Closing it would mean anchoring to a measured element position, which jsdom
cannot exercise, so it would ship untested.

A settle effect clears a stale anchor once `loadingOlder` goes false, covering
an older page that returns nothing at all. Callers therefore pass all four
paging props together or none - `loadingOlder` is what disarms the anchor.

The existing bottom-pinning, conversation-switch reset, and "new below" pill
behavior for appends are untouched.

### 4.6 Plumbing

Five files pass the `paging` object into `<Timeline>`: `ConversationDetail`,
`GroupTextView`, `ContactCommsPane`, `TourConversation`, and
`PlacementConversation`.

The tour and placement hubs do NOT inherit the fix. They mount `useRelayThread`
and `ContactCommsTab`, so they inherit the paging at the HOOK layer - but each
renders `<Timeline>` directly, hand-listing every prop, so an unpassed prop is
an unshipped control on the operator's two most-open pages. Only
`ContactCommsPane` is genuinely covered by one edit: it receives the whole
`ContactTimelineState` object, and its three owners pass it whole.

## 5. Verification

### 5.1 Unit

- `useRelayThread` / `useGroupThread`: `loadOlder` prepends and merges; a live
  refetch preserves loaded older pages; the window-shift case from section 4.1
  leaves NO gap; `hasOlder` flips false on a short page; a double click fires ONE
  request (the guard is a ref, so it holds within a single render); conversation
  switch resets rather than merges.
- `useContactTimeline`: `nextCursor` is kept and sent back; `kinds` is carried
  onto the older-page request; `upcoming` AND `timezone` both survive an
  older-page load; the fallback path reports `hasOlder: false`; a `kinds` change
  resets rather than merging across filters.
- All three hooks: `olderPagesLoaded` bumps on a merged older page and NOT on a
  first load, an SSE refetch, or a failed older read. It is the renderer's only
  prepend signal, so a phantom bump breaks scroll anchoring everywhere.
- `Timeline`: the control renders only when `hasOlder`; a prepend holds the
  scroll anchor; a prepend raises no "new below" pill; an append still does; an
  append arriving while an older page is in flight does NOT consume the prepend
  anchor, and neither does a "Comms only" toggle that changes the first rendered
  item (section 4.5).

### 5.2 End to end

One spec that builds its own long thread rather than touching a seed fixture.
It targets a RELAY GROUP: `createGroupOpen` provisions an open group with a pool
number - given TWO members, matching every existing caller and the fixture's own
"a fresh pair" contract - then roughly 55 inbound messages from one member
through the fake-phone webhook seam push it past the ceiling.

The spec must raise its own timeout. `createGroupOpen`'s fresh path polls up to
30s for a warming number and then up to 60s for the group to open, against a 30s
per-test default with `retries: 0`. It asserts the newest page is present and
the oldest message is not, clicks "Load older messages", then asserts the oldest
message is reachable and no control remains under either label.

The surface choice is deliberate. A plain 1:1 conversation cannot be used:
`/conversations/:id` REDIRECTS a 1:1 to its owning contact page, which runs
`useContactTimeline` - the path with an authoritative cursor. That would leave
the `before` paging and the section 4.4 heuristic in `useRelayThread` and
`useGroupThread` with no end-to-end coverage at all, which is precisely the
riskier half of the change. A relay group renders `useRelayThread` directly.

Accepted coverage gap, stated rather than hidden: the contact-timeline cursor
path is covered by unit tests only.

Both the member number and every `MessageSid` must be per-run unique, following
the `uniquePhone` / `uniqueSid` convention in
`e2e/tests/dashboard-next/a2p-compliance.spec.ts`. The hermetic launcher reuses
its DynamoDB container across boots and never clears it, so `sid#<providerSid>`
dedup pointers accumulate; a hardcoded SID makes the inbound silently DROP on
every run after the first.

This keeps the byte-stable lean world untouched and avoids the global wipe that
`POST /__dev/performance/reseed` would inflict on every other spec in the run.

### 5.3 Gates

Built in an isolated `W:\tmp` worktree. `npm run typecheck`, `npm test`, and
`npm run e2e` all run bare from that worktree before handback.

## 6. Out of scope

- Scroll-triggered auto-loading (section 3, decision 1).
- A server `hasMore` flag for the messages route (section 4.4).
- The wider inefficiency that every SSE event re-reads the whole open page
  instead of applying the delta. Filed as
  [`thread-hooks-refetch-whole-page-per-event`](../../issues/thread-hooks-refetch-whole-page-per-event.md).
  That issue and this work touch the same code; the merge in section 4.1 is
  written so a later delta-applying hook can replace the refetch without
  reworking the paging.
- The unfiltered SSE trigger, already filed as
  [`contact-timeline-sse-refetch-unfiltered`](../../issues/contact-timeline-sse-refetch-unfiltered.md).
