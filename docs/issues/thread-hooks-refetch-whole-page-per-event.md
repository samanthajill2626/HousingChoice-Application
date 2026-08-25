---
id: thread-hooks-refetch-whole-page-per-event
title: Thread hooks and the inbox list re-READ the whole page on every SSE event instead of applying the delta - and the inbox half is blocked on a row-keyed event
type: improvement
severity: med
status: open
area: dashboard
created: 2026-08-13
refs: dashboard/src/routes/conversation/useRelayThread.ts:196, dashboard/src/routes/conversation/useRelayThread.ts:238, dashboard/src/routes/conversation/useGroupThread.ts:128, dashboard/src/routes/conversation/useGroupThread.ts:188, dashboard/src/routes/contact/useContactTimeline.ts:141, dashboard/src/routes/contact/useContactTimeline.ts:318, dashboard/src/routes/placements/usePlacements.ts:244, dashboard/src/routes/inbox/useInbox.ts:376, dashboard/src/routes/inbox/useInbox.ts:205
---

**CORRECTION 2026-08-24: this is no longer the leading explanation for
[`call-inbox-unread-detached-node-flake`](./call-inbox-unread-detached-node-flake.md)
sighting 1, and it is not evidence for anything in C1.** That issue attributed
its "element was detached, retrying" signature to this churn. The reproduction
on 2026-08-24 showed a different mechanism producing the identical signature -
the node detaches because the list is replaced by an EMPTY one, a stale-filter
page installed by `useInbox` - and the fix for that took the spec from a
1-in-38 failure rate to 250/250.

Stated at that strength deliberately: sighting 1 ran on a different branch under
different load and left no artifact that can settle which mechanism it was, so
"NOT this" would over-claim in the same direction the resolved issue has already
had to retreat from once. What mattered here was only that R11 must not be
sequenced as if a flake depended on it. R11 has since been CUT outright - see
the 2026-08-25 re-adjudication below.

**Re-adjudicated 2026-08-25 against main @88ac7b36.** The proposed inbox remedy
(rider R11: merge the refetched page onto the existing rows by `rowKey`) was cut
as a non-fix - it re-reads the identical page and only changes how the response
is installed - and the surviving merit of this issue was corrected from
"should not re-RENDER wholesale" to "should not re-READ wholesale", which is a
different and much narrower claim. Full ruling, evidence and consequences in the
section of that date below.

**Problem.** Every conversation-shaped hook - and `useInbox` - answers an SSE
event by re-fetching the whole page it already has. One new inbound text costs a
full re-read of up to 50 messages the client is already holding, and the 49
unchanged rows are re-queried, re-serialized and re-shipped to deliver one new
bubble.

Two things this issue does NOT claim, both of which earlier revisions of this
file did claim and neither of which survives inspection:

- It is not about state being replaced WHOLESALE. That was true when the issue
  was filed and has not been true since 2026-08-13 - see the UPDATE below.
- It is not about wholesale re-RENDERING or DOM churn. The inbox list is keyed
  by a stable identity (verified 2026-08-25), so React reuses each unchanged
  row's fiber and DOM node no matter how many fresh row objects a refetch
  installs. The cost is the READ - round trips, server work, bytes - not the
  render. This is the distinction the 2026-08-25 re-adjudication turns on, and
  getting it wrong is what produced a rider that would have saved nothing.
  Whether the three thread hooks' lists are keyed the same way was NOT checked
  in that pass; assume the same until someone verifies it, and do not resurrect
  a DOM-churn argument for them without evidence.

The pattern is identical in all three THREAD hooks (`useInbox` has the same
shape but a different event and a different blocker - see the 2026-08-25
section):

```ts
const fetchNow = useCallback(async () => {
  const messages = await getConversationMessages(conversationId, opts, signal);
  setServerItems((prev) => mergeTimelineItems(prev, buildRelayItems(messages)));
}, [conversationId]);                             // whole page still re-READ
// ...
useEventStream({ onMessagePersisted: scheduleRefetch, ... });
```

- `useRelayThread` (useRelayThread.ts:196) additionally re-fetches the scheduled
  bucket on the same trigger, so each event is two round-trips.
- `useGroupThread` (useGroupThread.ts:128) is the same shape, one round-trip.
- `useContactTimeline` (useContactTimeline.ts:141) is the most expensive: its
  route fans out to one `messages.listByConversation` per conversation the
  contact owns, plus - for a landlord - `units.listByLandlord` and one
  `audit.listByEntity` per owned unit (capped at 25).

For the three thread hooks the events are BELIEVED to carry the payload needed
to do better (asserted when this issue was filed, never re-verified).
`usePlacements.ts:244` is the in-repo counter-example: it wires
`onPlacementUpdated` to an `applyEvent` reducer that patches the row in place
instead of refetching the list.

**For the inbox list that is FALSE, and it is the whole reason the inbox half is
not buildable today** - `conversation.updated` carries no `contactId`, so it
cannot address an aggregated contact row. See the 2026-08-25 section.

Cost scales with the surfaces mounted, not with the change: the tour and
placement hubs mount `useRelayThread` and `ContactCommsTab` at once, so a single
inbound message can trigger several full-page re-reads across one operator's
screen. The 300ms debounce coalesces bursts but does not reduce the per-refetch
payload.

UPDATE 2026-08-13 (feat/thread-history-paging): the wholesale REPLACE is gone.
Every fetch now merges by id through `dashboard/src/routes/shared/threadPaging.ts`,
so a refetch can no longer discard older pages the operator has loaded. What
remains - and what this issue is still about - is that each event re-READS the
whole page to deliver one bubble. The merge was written so a delta-applying hook
can replace the refetch without reworking the paging: keep the same single state
slice, just feed it a one-item delta instead of a 50-item page.

**RE-ADJUDICATION 2026-08-25 - the INBOX half, against main @88ac7b36.**
The `2026-08-24-inbox-unread-read-path-design` spec proposed to build the inbox
half of this issue as rider R11: "Merge the refetched page onto the existing rows
by `rowKey` so an unchanged row keeps its DOM node, instead of replacing every
row on every event." **R11 is CUT.** Verdict: the defect is REAL, the remedy is
WRONG. All three findings below are from a read-only pass over the shipped code;
nothing was run.

**THE DECISIVE POINT, which outranks everything else here: the proposed change
saves ZERO round trips and ZERO bytes.** It leaves
`getInbox({ filter, limit: PAGE_LIMIT })` (`useInbox.ts:205`, `PAGE_LIMIT = 30`
at `useInbox.ts:94`) exactly as it is and alters only how the response is
installed into `base`. The round trip, the server's unread fill loop, the
per-candidate hydration and the 30 serialized rows all remain. This issue's title
is about re-READING the whole page per event; R11 re-reads the whole page. It is
not a smaller version of this issue's remedy, it is a different change that
leaves this issue's subject untouched.

**The defect itself does still reproduce on the inbox**, as a server/network
cost with no user-visible symptom. `useInbox.ts:376` wires
`useEventStream({ onConversationUpdated: scheduleRefetch })`; `scheduleRefetch`
(`useInbox.ts:366-372`) debounces 300ms (`REFETCH_DEBOUNCE_MS`,
`useInbox.ts:97`) and calls `fetchFirstPage`, which reads 30 rows and installs
them wholesale (`useInbox.ts:205`, `useInbox.ts:238-243`). Any
`conversation.updated` from anywhere in the org triggers it, for every mounted
inbox.

**Finding 1 - the DOM-node justification is false; the row already keeps its
node AND its component instance.** `Inbox.tsx:209-217` renders
`key={rowKey(row)}`, and `rowKey` (`useInbox.ts:104-108`) is a stable identity
(`g:` / `gt:` / `c:` / `u:`). A reconcile never passes through
`status: 'loading'` - `fetchFirstPage` (`useInbox.ts:199-243`) never calls
`applyStatus('loading')` on the success path; only the filter effect
(`useInbox.ts:299`) and `retry` (`useInbox.ts:315`) do - so the `<ul>` at
`Inbox.tsx:206`, gated on `status === 'ready' && rows.length > 0`, does not
unmount and remount around an event. With the status steady and the keys stable,
`setBase(pageData.rows)` hands React new objects under the SAME keys: React
matches by key, reuses the fiber and its host nodes, and writes only the
props/text that actually differ. The proof that the INSTANCE survives, not merely
the node, is local state: `InboxRow` holds
`const [revealed, setRevealed] = useState(false)` (`InboxRow.tsx:74`) for
swipe-to-reveal, and nothing resets a swiped-open row on an SSE event. Local
state survives a keyed update and is destroyed by a remount.

The re-render win R11 implies is uncollectable anyway, on three counts:
`InboxRow` is a plain function component with no `React.memo`
(`InboxRow.tsx:50`); `useInbox` derives `patched` / `visible` / `rows`
unmemoized on every render (`useInbox.ts:523-534`), so every row re-renders on
every parent render regardless of object identity; and a merge that installs the
server's fresh object does not preserve identity in the first place unless it
also deep-compares. R11 does none of the three.

The only two ways a node genuinely does go away today are REORDERING
(`sortByActivity`, `useInbox.ts:117-121`, which React services by MOVING the
existing node) and a key that legitimately changes (see finding 3). Neither is
addressed by a merge.

**Finding 2 - a merge breaks `serverRowCount`, which is a SERVER-PAGE statement
judged against a server-page flag.** `serverRowCount` is `base.length`
(`useInbox.ts:543`) and its contract (`useInbox.ts:68-81`) records that this
exact framing IS the fix for adversarial finding 4: `truncated` is the server's
statement about the page it just read, so the count paired with it must describe
the same page. `Inbox.test.tsx:134` states the rule in one line - "The gate is
`serverRowCount` - a server claim judged against a server claim". A merge makes
`base` an accumulation of every row the server has ever handed down for the
filter, minus nothing, and three things break:

1. `serverEndedEarlyEmpty` (`Inbox.tsx:42`,
   `serverRowCount === 0 && truncated`) becomes UNREACHABLE once any non-empty
   page has landed, so the "feed ended early" failure surface at
   `Inbox.tsx:183-190` can never render again. That surface exists precisely so
   a truncated empty unread feed is not mislabelled "all caught up".
2. The Unread truncation notice (`Inbox.tsx:160-167`) pairs a per-page flag -
   `truncated` is REPLACED by each page, never OR-ed (`useInbox.ts:242`,
   `useInbox.ts:346-348`) - with an all-time count. `Inbox.tsx:144-146`
   documents these two conditions as exact complements that "can never render
   together"; a merge removes one arm of that complement.
3. **The half nobody had noticed: a merge-by-key has no delete rule, so a row
   can never LEAVE.** Any row the server dropped from the page stays on screen
   forever - on `filter=unread`, every thread another operator (or the same
   operator in another tab, or an auto-read path) marks read; on any filter, a
   soft-deleted or merged contact, a relay thread that closed, or simply a row
   pushed off page one by newer activity. Narrowing as rows are cleared is the
   Unread tab's entire job.

**Finding 3 - what would go red, and the double render, so nobody rediscovers
them.** Two tests fail under a merge:
`dashboard/src/routes/inbox/useInbox.test.tsx:175-222` ("drops an in-flight
loadMore when an SSE reconcile lands under it") renders a first page of `[c1]`,
resolves the reconcile with `pageOf([mkRow({ contactId: 'c-fresh' })], null)`,
and asserts `count` is `1` at line 211 - under a merge it is 2, because `c:c1`
is retained; and `dashboard/src/routes/inbox/Inbox.test.tsx` pins
`serverRowCount` against `truncated` at lines 137, 313, 368 and 379, which is
finding 2 expressed as assertions.

The triaged-unknown DOUBLE RENDER: triage flips a row from `kind: 'unknown'`
(`app/src/routes/inbox.ts:880`) to `kind: 'contact'`
(`app/src/routes/inbox.ts:814`), which moves its key across namespaces from
`u:<phone>` to `c:<contactId>` (`useInbox.ts:105-107`). The wire type documents
the transition itself (`dashboard/src/api/types.ts:1546-1547`, "unknown_1to1 ->
tenant_1to1 after triage"). Today the `u:` row disappears with the page it was
on. Under merge-by-rowKey it has no key match in the new page and is RETAINED,
so the same person renders twice, one row permanently stale and permanently
"Needs triage".

One further edge for whoever revisits this: `loadMore` appends with
`[...prev, ...pageData.rows]` (`useInbox.ts:343`) and does NOT dedupe -
`useInbox.ts:155` already names the consequence ("duplicate rowKeys, silently
skipped rows - `rows` is not deduped"). Under a merge, `cursor` addresses
position 30 of the SERVER feed while `base` may hold more, so page two
re-delivers rows already present.

**WHAT ACTUALLY BLOCKS THE REAL REMEDY, and what would have to change.** This
issue's Suggested fix - apply the event instead of re-reading the page - cannot
be built on the inbox today. `useInbox.ts:6-14` already says why, and it checks
out: `conversation.updated` is PER-CONVERSATION and carries no `contactId`,
confirmed against the wire type (`dashboard/src/api/types.ts:1540-1567` -
`conversationId`, `last_activity_at`, `unread_count`, `preview?`, `type`,
`participant_display_name`, plus relay/group extras, and no contact id) and
against the single builder every emit site uses
(`toConversationUpdatedEvent`, `app/src/lib/events.ts:89-118`). An inbox contact
row is keyed `c:<contactId>` and is built per CONTACT by the inbox route
(`app/src/routes/inbox.ts:814`), aggregating that contact's threads, while the
event names one conversation. The delta cannot be routed to a row without a
lookup the client does not hold.

So the inbox half becomes buildable only if one of these lands first:

- **A row-keyed `inbox.updated` event** - the shape `useInbox.ts:11-13` already
  names as the thing that "would enable no-network patch-in-place". It is a new
  wire contract plus an enumeration of every emit site, so it is spec-gated work
  and not a rider.
- **Or, cheaper and independently worth doing, shrink the TRIGGER rather than
  the install.** The inbox has the same problem
  [`contact-timeline-sse-refetch-unfiltered`](contact-timeline-sse-refetch-unfiltered.md)
  files for the contact feed, in a worse form: any org-wide
  `conversation.updated` refetches every mounted inbox, including for
  conversations that appear on no rendered row. Filtering the trigger reduces
  real server work. Merging the response reduces none.

**Severity.** The frontmatter stays `med`, and that severity belongs to the
three conversation hooks this issue's `refs` actually name. Taken ALONE the
inbox half is `low`: a server-cost improvement with no user-visible symptom, no
correctness bug, and - since the 2026-08-24 correction at the top of this file -
nothing sequenced behind it. Do not scope the inbox half as a `med`.

Related but distinct: [`contact-timeline-sse-refetch-unfiltered`](contact-timeline-sse-refetch-unfiltered.md)
covers WHICH events trigger a refetch (any org-wide message event refetches every
mounted contact feed). This issue is about HOW MUCH each refetch re-reads once it
is correctly triggered. Fixing both compounds: filter the trigger, then shrink
the work each surviving trigger does.

**Suggested fix - THE THREE THREAD HOOKS ONLY.** This section is scoped to
`useRelayThread` / `useGroupThread` / `useContactTimeline`. It does NOT describe
buildable work on the inbox list: `useInbox` cannot apply
`conversation.updated` in place at all today, for the reason given in the
2026-08-25 section above, and the inbox's own next step is named there. Do not
scope inbox work off the paragraphs below.

Apply the event instead of re-reading the page, following the
`usePlacements` reducer precedent: on `message.persisted` for this conversation,
append/patch the single message the event describes. Keep a full refetch as the
fallback for events that cannot be applied cleanly (unknown id, a gap in
sequence, or the thread not yet loaded) so no state can silently drift.

If the event payload proves too thin to build a bubble from, the cheaper interim
is a bounded incremental read: refetch with a small `limit` (or an `after`
bound - not currently supported by
`GET /api/conversations/:id/messages`, which only pages backwards via `before`)
and merge by id - `mergeTimelineItems` already exists and is already wired into
all three hooks, so only the READ size would need to change. Adding an `after`
bound to that route would make the incremental read exact.
