# Dashboard research findings - relay 30003 retry lineage (T5-T10)

Read-only verification of the DASHBOARD half of the spec
(`docs/superpowers/specs/2026-09-02-relay-30003-retry-lineage-design.md`, Sec 4-5,
D17-D22) and the plan (Tasks 5-10) against the live tree in
`W:\tmp\relay-30003-retry-lineage`.

Only contradictions and gaps are recorded here. Byte-exact anchors and the full
Part C invariant table are in the gitignored
`.superpowers/sdd/worklist-dashboard.md`.

Severity counts: **1 BLOCKING, 4 MUST-HANDLE, 4 NOTE.**

---

## 1. BLOCKING - `EffectiveRelayLeg extends RelayDeliverySlot` cannot carry two of the five fields the plan says it must

**Where:** plan Task 6 "Interfaces" block (`docs/superpowers/plans/2026-09-02-relay-30003-retry-lineage.md:681-687`).

**What the plan says:** `EffectiveRelayLeg extends RelayDeliverySlot` and
"Consumers need `sentAt`, `deliveredAt`, `transportAggregationState`,
`requestedTransport` and `actualTransport`".

**What the tree holds:** `RelayDeliverySlot`
(`dashboard/src/routes/contact/deliveryStatus.ts:151-157`) declares exactly five
members - `status`, `errorCode?`, `sentAt?`, `deliveredAt?`,
`transportAggregationState?`. It has **no `requestedTransport`, no
`actualTransport` and no `sid`**. Those three live only on
`RelayRecipientDelivery` (`dashboard/src/api/types.ts:1764-1773`).

**Why it is BLOCKING rather than cosmetic.** The two transport fields are read by
`presentRecipientTransport` (`dashboard/src/lib/messageTransport.ts:59-77`),
which is called with `row.slot` at `Timeline.tsx:591` (the recital) and
`Timeline.tsx:1119` (the per-recipient row), and `RecipientRow.slot` is typed
`RelayRecipientDelivery` (`Timeline.tsx:477`). Task 9 points both positions at
the projected legs. Because every member of `RelayRecipientDelivery` except
`status` is optional, an `EffectiveRelayLeg` value is **structurally assignable**
to it - so TypeScript accepts the substitution and reports nothing. If the
projection SPREADS the original slot the values survive at runtime by accident;
if it constructs the leg field-by-field (which the declared interface invites,
since the type says those fields do not exist) `presentRecipientTransport` falls
to its `return 'Unknown'` at `messageTransport.ts:76` on every
`transport_schema_version === 1` relay row and recital, silently, with a green
typecheck. Task 6's own guard test ("preserves every slot field it did not
decide") asserts only `sentAt` and `transportAggregationState`
(plan `:770-776`), so it would not catch it either. The same presenter serves the
FENCED native group-text product.

**Fix direction:** declare `EffectiveRelayLeg extends RelayRecipientDelivery`
(all eight fields), or keep `RelayDeliverySlot` as the base and widen Task 6's
preservation test to assert `requestedTransport` and `actualTransport` explicitly.

---

## 2. MUST-HANDLE - `hasTickableLeg` carries THREE counts, not two, and one of them is already wrong on `main`

**Where:** spec D18 ("It adds a clause to a predicate that carries TWO counts, and
both move", spec `:531-534`) and plan Task 9 Step 4 ("Extend BOTH counts in the
comments", plan `:1117-1118`).

**What the tree holds - three counts in two files:**

1. `dashboard/src/routes/contact/Timeline.tsx:749` - "Four distinct
   non-terminations have been shipped-and-caught behind this one line" - and then
   enumerates **FIVE**, items 1-5 at `:751-772` (the fifth being the futurity
   bound). **Already stale on `main`.**
2. `dashboard/src/routes/contact/Timeline.tsx:781-782` - "FIVE clauses carry that
   mirror" - four bullets at `:784-796` covering five code guards
   (`:799`, `:800`, `:801`, `:803`, `:808`). Currently CORRECT. This is the count
   the spec names.
3. `dashboard/src/routes/contact/Timeline.tsx:1806` - "see `hasTickableLeg` for
   the four non-terminations that predicate closes". This is the second count the
   spec names, and it is stale in the same way as (1).

A fourth restatement is in the ticker suite header,
`dashboard/src/routes/contact/Timeline.ticker.test.tsx:11` ("has failed to
terminate four distinct ways across four review rounds").

**Consequence:** a builder who updates exactly the two counts the plan names
leaves `Timeline.tsx:749` saying "four" above a list of six, in the same docblock
they just edited - the drift the spec added this instruction to prevent. Decide
whether (1) and (3) are being corrected as part of this change or deliberately
left; do not leave them half-updated.

---

## 3. MUST-HANDLE - the ticker termination test calls `rerender` with a props object; the harness has no such helper

**Where:** plan Task 9 Step 2, third test (plan `:1088-1092`):

```
  const { rerender } = renderTimeline({ items: [outboundOriginal, queuedRetryRow] });
  rerender({ items: [outboundOriginal, deliveredRetryRow] });
```

**What the tree holds:** `renderTimeline` in
`dashboard/src/routes/contact/Timeline.ticker.test.tsx:50-67` returns
`render(<MemoryRouter><Timeline .../></MemoryRouter>)` directly. RTL's `rerender`
takes a `React.ReactElement`, not a props bag, so the call is a type error and
would not re-render the component. No props-taking rerender helper exists in this
file (nor in `Timeline.test.tsx:21-37` or `Timeline.delivery.test.tsx:24-40`,
which share the same shape).

This is the test that proves the NEW ticker clause TERMINATES - spec test
intention 20, which the spec states separately precisely because it is not the
same assertion as "`unconfirmed` eventually appears". It needs either a local
element-returning helper (`Timeline.test.tsx:39-57` `imageTimeline` is the
in-repo precedent for a helper that returns the ELEMENT) or an unmount/remount
formulation.

---

## 4. MUST-HANDLE - Task 10's tour test does not match the tour host's harness in three ways

**Where:** plan Task 10 Step 1 (plan `:1153-1169`), which states "Follow the host
suite OWN harness: `TourConversation.test.tsx` defines `renderConvo(props)`
(`:178`) and drives content through `vi.mock('../../api/index.js')` (`:44`)".
Those two citations are correct; the test body written under them is not.

**What the tree holds:**

- `renderConvo(props: TourConversationProps, draft?)` at
  `dashboard/src/routes/tours/TourConversation.test.tsx:178` **requires** its
  `props` argument. The plan's body calls `renderConvo();` twice with none.
- There is no `mockThread` helper. The api mock at `:44-56` exposes
  `getConversationMessages`, seeded `getConversationMessages.mockResolvedValue([])`
  in `beforeEach` at `:199`.
- **`getConversationMessages` returns RAW `Message[]` wire rows**, which then pass
  through `buildRelayItems` -> `toTimelineMessage`
  (`dashboard/src/routes/conversation/useRelayThread.ts:139-151`, `:69-135`). So
  the fixtures fed here must be snake_case raw rows (the shape at
  `useRelayThread.test.tsx:57-87`), **not** the `TimelineItem` fixtures Tasks 7
  and 9 use (`Timeline.test.tsx:1177-1193`). Passing a `TimelineItem` through
  `toTimelineMessage` yields a row with `at: ''` and no `delivery_recipients`
  reachable, which would fail for the wrong reason.
- The Group pane only mounts when `channels.group.conversationId` is non-null;
  `makeChannels` defaults it to `null` (`TourConversation.test.tsx:154`). The one
  existing group-tab test overrides it at `:716`
  (`makeChannels({ group: { conversationId: 'g1', unread: 5 } })`) - that is the
  pattern to copy.

---

## 5. MUST-HANDLE - `TourConversation.test.tsx` does not mock the roster read, so the tour Group tab renders with an EMPTY relay roster

**Where:** Task 10, and any assertion it inherits from Task 9 Step 1.

**What the tree holds:** the tour suite's api mock
(`dashboard/src/routes/tours/TourConversation.test.tsx:44-56`) mocks only
`getContactTimeline`, `getAllConversations`, `getConversationMessages`,
`sendMessage`, `ensureContactConversation` and `useEventStream`. The Group pane
calls `getConversation` (`TourConversation.tsx:430`) and
`getConversationMembers` (`:435`), and `useRelayThread` calls
`getConversationScheduled` (`useRelayThread.ts:332`) - **none of the three is
mocked**, so they fall through to `importActual` and are swallowed by the
best-effort `.catch`es. `relayRoster` therefore arrives as `[]`.

**Consequence:** with an empty roster and contactId-keyed slots every
`RecipientRow` resolves `unidentified`, and `recipientSummaryName` takes its
case-3 early return at `Timeline.tsx:583-584`, returning only the spoken headline
with **no per-member recital at all**. Any accessible-name assertion of the form
`toHaveAccessibleName(/<Member>: Delivered on retry/)` (the Task 9 Step 1 shape)
passes on the ConversationDetail/Placement hosts and fails on the tour host - for
harness reasons, not a product defect. The sibling suite
`PlacementConversation.test.tsx` mocks all three (`:42-44`, seeded `:169-172`)
and is the model to copy.

Task 10's own two assertions (chip text and `findAllByText(BODY)` length) are not
affected; this bites only if a recital assertion is added there.

---

## 6. NOTE - the ticker-harness citation in Task 9 Step 2 points at the wrong lines

Plan Task 9 Step 2 (plan `:1064-1067`) cites
`Timeline.ticker.test.tsx:98-119,157-203` for the `setInterval`/`clearInterval`
spy pattern "and its own comments explain why `vi.getTimerCount()` is unusable
here".

Live: `startFakeClock` is `:96-100`, `spyOnIntervals` is **`:105-110`**, and
`:118-124` is the `afterEach` restore-ORDER note. The `vi.getTimerCount()`
rationale is in the FILE HEADER at **`:16-20`**, not anywhere near `:98-119`. The
capture-the-id pattern the plan wants is at **`:157-187`** and repeated at
`:189-204` (the plan's `:157-203` clips the second one).

---

## 7. NOTE - the milestone-merge citation for the tour host points at a comment, not the merge

Spec D20 (spec `:648-650`) and plan Task 10 (plan `:1142-1143`) both cite
`TourConversation.tsx:463-467` as where the tour host "passes a MILESTONE-MERGED
item list".

Live: `:463-465` is a comment about `paging` coming off `thread` rather than
`items`, and `:466-469` is the return statement plus `items={items}`. The merge
itself is `withMilestones` at **`:94-100`**, called in a `useMemo` at
**`:421-424`**; the `<Timeline>` mount spans `:466-485`.

A builder reading `:463-467` to understand the merged shape finds the wrong code.
The item shapes actually in that list are `kind: 'message'` and `kind: 'call'`
(from `buildRelayItems`; email returns `null` at `useRelayThread.ts:70`) plus
`kind: 'milestone'` from `tourMilestones`. A `TimelineMilestone`
(`api/types.ts:2559-2565`) has no `tsMsgId`, no `delivery_recipients` and no
`retry_of`, so D20's predicate must narrow on `i.kind === 'message'` first -
exactly as the existing `visible` memo does at `Timeline.tsx:1791` and `:1797`.

---

## 8. NOTE - four line citations are off by a small amount

None of these changes a decision; they are listed so a builder does not conclude
the file drifted under them.

| citation | says | live |
| --- | --- | --- |
| spec D18 `:513`, plan Task 9 `:1113` | `tickerArmed` at `Timeline.tsx:1851-1854` | `:1850-1853` (refresh effect `:1844-1849`, interval effect `:1854-1876`) |
| plan Task 5 `:592` | `TimelineMessage ~:2474+` in `api/types.ts` | interface opens `:2463`, closes `:2520` |
| spec Sec 2 `:73` | `messageTransport.ts:43-56` "the funnel every projected entry passes through" | `isRecipientExcludedFromPresentation` `:43-47`, `includedRecipientEntries` `:49-57` |
| plan Task 5 `:608` | `presentMessageTransport`'s aggregate `:78-96` | `presentOutboundRecipientAggregate` `:79-109` (the `expected`/`complete` block is `:83-94`) |

Every other dashboard citation in the spec and plan verified exact, including
`deliveryStatus.ts:58`, `:128-141`, `:191-201`, `:351`, `:394-456`, `:407`,
`:410-416`, `:433-436`, `:453-455`, `:508-545`, `:671-681`, `:688-692`,
`:731-733`; `Timeline.tsx:734-742`, `:798-812`, `:814-835`, `:837`, `:934-940`,
`:937`, `:948-951`, `:959-968`, `:978-989`, `:993-1004`, `:1036`, `:1068-1070`,
`:1095`, `:1112-1115`, `:1538-1552`, `:1787-1800`, `:1806`;
`useRelayThread.ts:69-135`, `:101`, `:133`, `:167-186`;
`contactTimeline.ts:406-464`; `buildTimelineFallback.ts:64-104`;
`ConversationDetail.tsx:480`; `PlacementConversation.tsx:320`;
`api/types.ts:1764-1773`.

---

## 9. NOTE - a hidden-only history page renders the thread's EMPTY state

Part C surface the plan does not name. `Timeline.tsx:2263-2265` renders
`emptyLabel ?? 'No messages yet.'` from `status === 'ready' && visible.length === 0`
- and `visible` is the D20-filtered set. A relay history page consisting only of
hidden retry rows therefore shows "No messages yet." on a thread that has
messages, until the operator loads an older page.

Bounded and unlikely: three rungs per failed leg means roughly seventeen failed
legs to fill a 50-row page, and paging still works because both the `before`
bound and `hasOlder` read the RAW page
(`useRelayThread.ts:355`, `:360`, `:411-414`). Spec Sec 9 records the paging
dilution ("Load older grows the transcript by less than a page") but not this
consequence of it. Recording, not requesting a change.

---

## What the invariant sweep did NOT find

No dashboard reader of `retry_of`, `delivery_recipients`, `relay_sender_key`,
`direction`/`author`, `items.length`, `items[0]` or `items[items.length-1]`
misbehaves on a hidden retry row. The full table is in
`.superpowers/sdd/worklist-dashboard.md` Part C. Three specific hazards are
closed by decisions rather than by luck, and each has exactly one place it can be
reopened:

1. **`retry_of` must stay off the retry row.** `Timeline.tsx:1791-1792` collects
   it into `supersededIds` and `:1797` deletes the named row - stamping it would
   delete the ORIGINAL bubble and invert the contract. (D20 already says this;
   it is repeated here because it is the sweep's single load-bearing finding.)
2. **D9's opt-out refusal must write `retry_opted_out`, never
   `contact_opted_out`.** `deliveryStatus.ts:408-409` drops
   `contact_opted_out` legs from `fanned` and returns `null` for an
   all-opted-out map, so reusing that code on a single-entry retry row would make
   the entire retry bubble render no rollup at all, and `Timeline.tsx:903-905`
   would print the "1 member opted out" note on it. D15's four new codes avoid
   this; a builder reaching for the existing constant would not.
3. **D13's media-pointer suppression is the ONLY defence for the gallery.**
   `useContactMedia.ts:39-41` and `:109-110` dedupe on `${providerSid}:${index}`,
   and every rung has its own synthetic provider SID, so the same photo re-sent
   on three rungs would NOT collapse client-side. Nothing on the dashboard can
   compensate if the server writes the pointer rows.
