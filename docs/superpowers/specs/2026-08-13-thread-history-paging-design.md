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
ever dropped, which closes the gap. Result ordering stays chronological by the
existing sort.

Accepted consequence: an entry deleted server-side lingers in an open thread
until the operator navigates away. Messages are not deleted in this product, and
a stale-but-present bubble is a far smaller defect than a hole in the middle of
a transcript. This gets a code comment where the merge lives.

Switching conversations resets the slice outright rather than merging. Each hook
tracks the `conversationId` (or `contactId`) its state belongs to and replaces
instead of merging on the first fetch for a new id.

### 4.2 API client

`getConversationMessages` gains paging and moves to the `(id, opts, signal)`
shape already used elsewhere in `endpoints.ts` (`getTourActivity` at :2291,
`getContacts` at :292):

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

All three gain the same three members on their returned state:

- `hasOlder: boolean` - whether a "Load older" control should render.
- `loadingOlder: boolean` - a fetch is in flight; the control is disabled.
- `loadOlder: () => Promise<void>` - fetch and merge one older page.

`useRelayThread` and `useGroupThread` page with `before = <oldest held id>` and
`limit = 50`.

`useContactTimeline` keeps `page.nextCursor` in state and passes it back with
the current `kinds` filter. `upcoming` and `timezone` remain first-page-only:
the server deliberately gathers the scheduled bucket only when `cursor` is
absent (`app/src/routes/contactTimeline.ts:955-959`), so an older page must not
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
disappears. The label can therefore be momentarily wrong; it is never wrong in
the dangerous direction, because a full page always means more may exist and a
short page always means the end has been reached. No history is ever unreachable
as a result.

The honest alternative - fetch `limit + 1` server-side, trim, and return
`hasMore` - is deferred, not rejected. It is roughly six lines plus a route
test. If the false label proves irritating in practice, that is the fix.

The contact timeline is unaffected: it uses its authoritative `nextCursor`.

### 4.5 Timeline UI and scroll anchoring

`Timeline.tsx` gains three optional props - `hasOlder`, `onLoadOlder`,
`loadingOlder`. Callers that pass none are behaviorally unchanged, which covers
every caller not in scope here.

The control renders above the first cluster with the accessible name
"Load older messages", per the accessibility-first selector rule in
`e2e/support/selectors.md`.

The subtle part is scroll. To reach the button the operator must scroll UP, so
`atBottomRef.current` is false. The existing layout effect at
`Timeline.tsx:1132-1153` reacts to a grown item count by setting `hasNewBelow`,
which would fire a spurious "new messages" pill for a PREPEND - content that
landed above them, not below.

The prepend path therefore:

1. records `el.scrollHeight` immediately before invoking `onLoadOlder`;
2. after the layout pass, sets `el.scrollTop += el.scrollHeight - recorded`, so
   the bubble the operator was reading stays exactly where it was;
3. suppresses the `hasNewBelow` pill for that pass.

The existing bottom-pinning, conversation-switch reset, and "new below" pill
behavior for appends are untouched.

### 4.6 Plumbing

`ConversationDetail`, `GroupTextView`, and `ContactCommsPane` pass the three new
props from their hook state into `<Timeline>`. `TourConversation` and
`PlacementConversation` inherit the fix through `useRelayThread` and
`ContactCommsTab`; the build must confirm both forward the props rather than
assuming inheritance is automatic.

## 5. Verification

### 5.1 Unit

- `useRelayThread` / `useGroupThread`: `loadOlder` prepends and merges; a live
  refetch preserves loaded older pages; the window-shift case from section 4.1
  leaves NO gap; `hasOlder` flips false on a short page; conversation switch
  resets rather than merges.
- `useContactTimeline`: `nextCursor` is kept and sent back; `kinds` is carried
  onto the older-page request; `upcoming` / `timezone` survive an older-page
  load; the fallback path reports `hasOlder: false`.
- `Timeline`: the control renders only when `hasOlder`; a prepend holds the
  scroll anchor; a prepend raises no "new below" pill; an append still does.

### 5.2 End to end

One spec that builds its own long thread rather than touching a seed fixture:
it posts roughly 55 inbound messages from a fresh, unseeded number through the
fake-phone webhook seam, producing a single conversation past the ceiling. It
then asserts the newest 50 are present, clicks "Load older messages", and
asserts the oldest message is reachable and the button is gone.

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
