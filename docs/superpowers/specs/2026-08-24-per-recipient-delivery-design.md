# Per-recipient delivery visibility on multi-party message bubbles

Status: DESIGN rev 2 (folds design review round 1 - 22 findings, 21 accepted)
Date: 2026-08-24
Branch: `feat/per-recipient-delivery`  Worktree: `W:\tmp\per-recipient-delivery`
Base: `main` @ f0e5ab46
Adjudications: `.superpowers/design-review/adjudications.md`

## 1. Why

On 2026-08-23 the founder sent a photo twice into a two-member relay tour group
(conv-07e4f611). Both times the bubble showed one neutral chip reading
`delivered 1/2`. The founder concluded the message had reached Wolf and not
Shamanic. The truth was the exact inverse: Shamanic (Verizon) got it in six
seconds both times, and Wolf's leg (Dish Wireless) stuck with no error code and
no receipt - see `mms-silent-drop-dish-textnow`.

Two defects made that misread possible.

**D1 - the rollup discards WHO.** `Timeline.tsx:602` computes the chip with
`presentRelayDelivery(Object.values(msg.delivery_recipients))`. `Object.values`
throws away the member keys, so the only surviving fact is a count. A 1-of-2
count is a coin flip, and the founder lost it. Everything a breakdown needs is
already in scope: the roster is in the component's closure as `relayRoster`
(`Timeline.tsx:538`), and each slot carries `status`, `errorCode`, `sid`,
`sentAt` and `deliveredAt` on the wire (`api/types.ts:1532-1538`). Of those,
`status` and `errorCode` are read today; `sid`, `sentAt` and `deliveredAt` are
read by no dashboard code at all.

**D2 - the escalation never reaches a multi-party chip.** The 15-minute
"Sent - not confirmed" rule added after the 2026-08-19 oversize-MMS incident
lives in `presentDeliveryStatus`. That function IS called on every outbound
bubble including multi-party ones (`Timeline.tsx:576-577`), and its result still
gates the Retry button (`Timeline.tsx:687`) - but the CHIP IT PRODUCES is
suppressed whenever a rollup exists (`Timeline.tsx:644`). So the escalation is
computed and then thrown away, and the rollup that replaces it has no staleness
rule of its own. A relay chip sits neutral forever and reads as "still in
flight" rather than "one recipient probably never got this".

## 2. Scope

Dashboard-only. No backend change, no schema change, no API change, no new
dependency. `delivery_recipients` reaches the client intact on the two paths
that can carry it: `useRelayThread.ts:66` and, through the shared
`buildRelayItems`, `useGroupThread.ts:188`.

The two contact-timeline paths also carry the field
(`buildTimelineFallback.ts:88`, `contactTimeline.ts:422`) but can never deliver
a populated map, because both filter multi-party threads out by type first
(`contactTimeline.ts:1058`, `useContactTimeline.ts:193`). That is why the
contact page is unaffected - not because of the roster prop.

### 2.1 One renderer, five mounts

There is exactly ONE SMS/MMS bubble renderer - `MessageBubble` in
`dashboard/src/routes/contact/Timeline.tsx:535`. Neither conversation view has
its own. Five callers mount the shared `Timeline`:

| Surface | Mount | Roster prop | rosterKind | Renders a list? |
| --- | --- | --- | --- | --- |
| Relay group | `conversation/ConversationDetail.tsx:488` | `members` | default `relay` | yes |
| Native group text | `conversation/GroupTextView.tsx:460` | `timelineRoster` | `group_text` | yes |
| Placement thread | `placements/PlacementConversation.tsx:328` | `members` | default `relay` | yes |
| Tour thread | `tours/TourConversation.tsx:475` | `members` | default `relay` | yes |
| Contact page | `contact/ContactCommsPane.tsx:319` | none | n/a | NO - must be unchanged |

`EmailCard` (`Timeline.tsx:915`) is a SECOND delivery-chip renderer in the same
file. It calls `presentDeliveryStatus(msg.delivery_status)` with no timestamp
(`Timeline.tsx:920`), so it opts out of staleness entirely and must keep doing
so. It is not a bubble and renders no list.

### 2.2 Out of scope, filed instead

- **The bubble reveal is not keyboard-reachable.** The bubble is a `div` with an
  `onClick` and no `role`, `tabIndex`, or `aria-expanded`
  (`Timeline.tsx:619-623`). That gap is PRE-EXISTING. This design does not fix
  it, and - stated honestly rather than waved away - it does make the
  consequence worse: what sits behind the inaccessible control today is a
  nicety (transport / number / time, whose time is already visible in the
  cluster label), and after this change it is the entire payload of the feature.
  S6 limits the damage; it does not erase it. The honest fix collides with the
  interactive children already nested in the bubble (a Link at `:631`, a Retry
  button at `:687`), which is its own design problem. File it.
- **A relay-observed 21610 keeps the raw code.** `twilio.ts:2386` writes
  `errorCode: '21610'` on a relay leg, while the group path translates the same
  event to `contact_opted_out` (`groupReceipts.ts:419`). Only the translated
  form is excluded from the denominator, so the relay case renders as a hard
  failure. Real, pre-existing, not caused by this work. File it.
- Carrier-fallback behavior (resending as a link to a Dish/TextNow line) belongs
  to `mms-silent-drop-dish-textnow`.
- Reusing the broadcasts `DeliveryBadge` component for the rows. It lives in the
  broadcasts route with broadcast-specific props and styling; importing it into
  the Timeline would couple two routes to save a span. The rows share the
  PRESENTER functions and `TONE_CLASS`, which is where the real duplication risk
  is.

## 3. Locked decisions (human, 2026-08-24)

1. **The breakdown folds into the EXISTING bubble reveal.** Tapping the bubble
   reveals the transport/number/time line and the per-recipient list together.
   No second click target inside the bubble.
2. **Opted-out members appear in the list**, labelled as not sent, and stay OUT
   of the N/M denominator exactly as today.
3. The rollup escalates when a leg goes quiet.

### 3.1 The tradeoff decision 1 accepts, and what actually delivers it

Folding into the reveal means nothing on the chip advertises that a who-got-it
answer exists behind it. That is acceptable only because decision 3 makes the
chip itself escalate: the founder sees a red `delivered 1/2 - 1 not confirmed`
without clicking anything, and clicks only to learn WHO.

That guarantee is not free, and rev 1 did not deliver it. Staleness is computed
during render against `Date.now()` (`deliveryStatus.ts:88`), and no timeline
surface schedules a render as time passes - the only production interval in the
conversation routes is `GroupTextView.tsx:162`, a member-panel poll. A silently
dropped leg produces no further receipt BY DEFINITION, so no `message.persisted`
event, so no SSE refetch, so no re-render. On the exact incident shape - send,
then watch the thread - the escalation would never appear. S7 supplies the tick
that makes the guarantee true. If S7 were dropped, decision 1 would have to be
revisited.

## 4. Behavior

### S1 - The per-recipient list, and exactly when it renders

**The gate is ONE predicate, independent of the rollup's value:**

```
outbound AND the map has at least one slot AND delivery_status !== 'queued_pending'
```

This is deliberately NOT "whenever the rollup is present". Passing the three
gates at `Timeline.tsx:600-603` does not make the rollup non-null:
`presentRelayDelivery` returns null for an all-opted-out map as well as an empty
one (`deliveryStatus.ts:128-129`). Gating the list on the rollup would delete
locked decision 2 in the single case where the opted-out members are the only
information the bubble has.

Consequences, all intended:

- **Empty map `{}`** (seeded on every relay inbound source message,
  `twilio.ts:610`): no slots, so no list. Nothing to name.
- **All-opted-out map**: the list renders. The rollup stays `null`, so the
  message-level chip still renders (`Timeline.tsx:644`, unchanged) reading
  "Undelivered - Everyone here has opted out - nothing was sent", and the count
  note still renders. Three elements, three different jobs: the chip states the
  aggregate outcome, the note counts, and the rows are the only thing that NAMES
  anyone. That is the point of decision 2, and it is not the "third chip
  fighting the other two" that section 5 forbids - no row restates the aggregate.
- **`queued_pending` hold**: no list, matching the rollup's own exclusion. Its
  slots are pre-seeded placeholders (`api.ts:1684-1686`); nothing was fanned out.

**The list is CONDITIONALLY RENDERED on the revealed state** - present in the
DOM only while the bubble is revealed. It does NOT copy the meta line's
`display:none` mechanism (`Timeline.module.css:296-305`). Four reasons: hidden
DOM is outside the accessibility tree, so the CSS approach would put the whole
feature out of reach of assistive technology even when open; a conditional
render makes presence/absence a real unit assertion where a `css:false`
environment can prove nothing about visibility (6.2); it keeps hidden row text
out of the DOM that the existing group e2e specs match with page-scoped
`getByText` (6.3); and a collapsed bubble then carries no claims at all.

One row per slot, in ROSTER ORDER, with slots whose key matches no roster member
last in map-key order. Each row carries the member's label (S2), their own state
(S4), a timestamp when one exists, and a reason when the row is a failure.

Timestamps: `deliveredAt` on a delivered leg, `sentAt` on a sent leg. Group-text
legs never have `sentAt` (S5), so many rows show a state with no time. That is
correct and must not be back-filled from the message's own time, which would
present a message-level fact as a per-leg one.

### S2 - Naming a recipient

Every row must carry a label; a blank row defeats the feature. `senderLabel`
(`lib/memberAttribution.ts:60`) is NOT reusable as-is: for `kind = 'relay'` it
returns `undefined` for a nameless member, on purpose
(`memberAttribution.ts:55-59`, invariant 6).

Four cases, in order. The distinction between cases 3 and 4 is load-bearing:

1. **Roster present and non-empty, key matches a member.** Label with
   `groupMemberLabel(member)` (`lib/groupThread.ts:61`) - name, else formatted
   number. Match EITHER key convention: a relay key is an opaque `contactId`
   (`messagesRepo.ts:156`) and a group-text key is always `phone#<E164>`
   (`groupMembers.ts:42`). The superset match at `memberAttribution.ts:75-77` is
   the behavior to reuse - EXTRACT it, do not re-implement it.
2. **Roster present and non-empty, no match** - a member removed from the group
   since this message was sent, because the roster is CURRENT membership while
   the map is historical. If the key is `phone#<E164>`, show the formatted
   number and mark the row as a former member. If the key is an opaque
   contactId, the row reads as a former member with no name.
3. **Roster ABSENT or EMPTY.** Make NO membership claim. `TourConversation.tsx:425`
   and `PlacementConversation.tsx:281` both initialise `members` to `[]` and
   swallow a roster fetch failure, so two of the four list-rendering surfaces
   can render with an empty roster indefinitely; `ConversationDetail.tsx` has a
   rendered "couldn't load the members" state, so it reaches this too. Under a
   rule that treated absent-roster as no-match, EVERY recipient of EVERY message
   would be asserted a former member - a confident false statement produced by
   the feature whose purpose is to stop confident false readings, and strictly
   worse than the chip it replaces because it looks like an answer. A
   phone-keyed row shows the formatted number; a contactId-keyed row shows a
   neutral unnamed-recipient label. Neither says anything about membership.

**Decision taken explicitly (invariant 6).** Case 1 applies the number fallback
to relay rows, which `memberAttribution.ts:55-59` reserved as "a product
decision on its own". This design takes it: a list row that renders blank is
useless, and `undefined` is only tolerable for an attribution chip that may
render nothing. The resulting split is accepted and documented - a nameless
relay member is unnamed as an AUTHOR (no attribution line) and shown by number
as a RECIPIENT. `lib/groupThread.ts:53-58` warns about exactly this kind of
drift; here it is deliberate, because the two surfaces answer different
questions.

### S3 - Staleness, per leg and in the rollup

A leg is STALE when its status is NON-TERMINAL and its clock has been quiet for
at least `STALE_SENT_AFTER_MS` (15 minutes, `deliveryStatus.ts:54`).

Non-terminal means `queued` or `sent` - the complement of
`GROUP_TERMINAL_DELIVERY_STATUSES` (`groupSendStaleness.ts:53-57`). **This
deliberately diverges from the 1:1 rule, which stays `sent`-only**, and the
divergence is the point: `queued` is a leg's ordinary resting state, not a
transient one. The relay fan-out writes `queued` whenever Twilio's create
response says so (`relayFanOut.ts:539-543`), the group-text seed is a bare
`{ status: 'queued' }` (`groupSend.ts:612`), and a leg whose fan-out job or
receipts webhook died never leaves it. The server's own detector treats a stuck
`queued` leg as the ERROR case while a stuck `sent` leg is only a WARN
(`groupSendStaleness.ts:24-28`); a `sent`-only chip rule would render neutral
for the shape the server alarms hardest on.

**Mechanism: extract ONE exported predicate** - `isStaleLeg(status, atMs, nowMs)`
- and put both `presentDeliveryStatus` and the rollup on it. Do not inline the
comparison, and do not string-compare the returned label: today the stale result
is a module-private constant (`deliveryStatus.ts:69`), and an inlined
`nowMs - t >= STALE_SENT_AFTER_MS` is a second copy of the gate, which is the
drift this instruction exists to prevent.

The per-leg clock is the slot's own `sentAt` when it parses, else the message's
`at`. Rationale in S5.

**The rollup's branches, ALL FIVE, in evaluation order.** Branch 0 already
exists and is UNCHANGED - it is named here because rev 1 omitted it and a
builder rewriting from the list would have dropped it:

| # | Condition | label | tone | isFailure | reason |
| --- | --- | --- | --- | --- | --- |
| 0 | no non-suppressed legs (empty map, or all opted out) | - | - | - | returns `null`, UNCHANGED (`deliveryStatus.ts:129`, pinned by `deliveryStatus.test.ts:123`) |
| 1 | any hard-failed leg, no stale leg | `delivered N/M - K failed` | danger | true | joined failure reasons (unchanged) |
| 2 | any hard-failed leg AND any stale leg | `delivered N/M - K failed, J not confirmed` | danger | true | joined FAILURE reasons only |
| 3 | any stale leg, no hard failure | `delivered N/M - J not confirmed` | danger | false | none |
| 4 | every leg delivered | `Delivered M/M` | success | false | none |
| 5 | otherwise | `delivered N/M` | neutral | false | none |

Branch 3 is `isFailure: false` on purpose, following the documented reasoning of
`STALE_SENT_PRESENTATION` (`deliveryStatus.ts:64-73`): no receipt is not proof
of failure, and `isFailure` is what offers a Retry that could double-send.
Branch 2 is `isFailure: true` because a real failure exists in it.

Opted-out legs stay excluded from N, M, K and J, keyed on
`errorCode === 'contact_opted_out'` ALONE (`deliveryStatus.ts:120-127`).

**The rendered chip strings.** `Timeline.tsx:660-662` appends the reason inline
after the label, so the branch-2 chip is the longest string this design
produces:

```
delivered 0/3 - 1 failed, 1 not confirmed - Number not registered for A2P 10DLC (error 30034)
```

Reason LAST, after both counts - it belongs to the failed legs only, and putting
it between the two counts would attach it to the wrong one.
`Timeline.module.css:308-313` already anticipates the length ("the status chip
wraps below if a reason makes the row too long"); verify that wrap in a browser
rather than assuming it.

### S4 - Per-leg labels

Per-leg state reuses `presentDeliveryStatus` so a leg and a 1:1 message never
disagree about what a status means, EXCEPT for the two cases below.

**The opted-out row.** Identified by `errorCode === 'contact_opted_out'` alone,
on either `failed` (relay, `relayFanOut.ts:456`) or `undelivered` (group,
`groupDelivery.ts:59`). It reads as not sent rather than as a failure, and it is
PRODUCT-AWARE, mirroring the split the note directly above it already makes
(`Timeline.tsx:666-685`) because the mechanism genuinely differs: on a group text
Twilio skips the participant, while on a relay the app itself declines to send.
`rosterKind` is in scope at `Timeline.tsx:539`.

- `group_text`: `Not sent - opted out (Twilio skips them)`
- `relay`: `Not sent - opted out`

**This row does NOT go through `deliveryReason`.** That function maps
`contact_opted_out` to "Everyone here has opted out - nothing was sent"
(`deliveryStatus.ts:192-194`), copy written for the message-level AGGREGATE and
documented as such at `:180-186`. On the row of the one member in five who opted
out it would be a fresh instance of the exact misread class this feature exists
to kill.

**The new label lives in the NEW per-leg presenter, never inside
`presentDeliveryStatus`** - see the caller list in section 5.

A reason renders on a row only when that row's presentation `isFailure`,
mirroring `Timeline.tsx:579`. An `errorCode` does NOT imply failure:
`relayFanOut.ts:527` writes `{ status: 'queued', errorCode: <transient code> }`
for a deferred retry, and printing a carrier code beside a still-retrying leg
would be its own misread.

### S5 - Which clock, and why it differs by product

`sentAt` is written ONLY by the two relay send paths (`relayFanOut.ts:542`,
`relayAnnouncements.ts:266`) and holds the PROVIDER's timestamp string.
`deliveredAt` is written ONLY on the `delivered` transition
(`messagesRepo.ts:2786`) and holds OUR server clock. A native group-text leg
never has `sentAt`: its seed is a bare `{ status: 'queued' }` and the receipts
path writes only status, errorCode, deliveredAt and sid.

- A group-text leg's staleness can only be measured from the message's `at`.
- The two timestamps come from different clocks and must never be subtracted
  from one another or presented as a duration.
- `imported` rows carry no `delivery_recipients` at all (the importer writes
  none), so the imported-row suppression at `Timeline.tsx:577` has no per-leg
  equivalent to break. Carry the same guard anyway - withhold the clock when the
  parent message is imported - so the rule stays true by construction.

### S6 - Accessible summary while collapsed

The always-visible rollup chip carries the per-recipient summary as an
accessible name, so a screen-reader user gets the same facts without opening a
disclosure they cannot reach by keyboard.

**Mechanism: `role="img"` plus `aria-label` on the chip span.** The chip is a
bare `<span>` today (`Timeline.tsx:656-664`), which maps to `role=generic`, and
the ARIA specification PROHIBITS an author-provided name on generic - so
`aria-label` alone, as rev 1 specified, is the one construct guaranteed not to
work. `role="img"` makes the chip a leaf in the accessibility tree and supports
a name from the author, replacing the terse "delivered 1/2" with the full
sentence.

Rejected alternative: visually-hidden text via the `.srOnly` class that already
exists at `Timeline.module.css:954`. It works, but it puts duplicate text in the
DOM permanently, which is the hazard 6.3 has to manage for the e2e locators.
`role="img"` adds no text nodes.

The chip's existing `title` (`Timeline.tsx:659`) stays for mouse users; the
`aria-label` supersedes it as the accessible name, so the reason must be folded
into the label rather than left only in `title`.

### S7 - A clock that ticks

Without this, S3 computes an escalation that nothing ever renders (3.1).

A coarse tick re-renders the timeline while any outbound multi-party leg is
non-terminal, so a bubble already on screen crosses the 15-minute boundary on
its own. Requirements:

- The interval is COARSE (on the order of a minute, not a second) and drives
  only a re-render; it fetches nothing and must not touch the network.
- It runs ONLY while at least one rendered outbound message has a non-terminal
  leg. A thread whose every leg is terminal, and a thread with no multi-party
  messages, must schedule nothing.
- It is cleaned up on unmount, and must not run in a test environment that has
  a pinned fake clock without the test asking for it - `dashboard/src/test/setup.ts`
  pins `2026-07-01T12:00:00Z`, and a live interval against a frozen clock is a
  spin with no progress.
- The tick is a rendering concern and belongs beside the timeline, not inside
  the pure presenter module. `deliveryStatus.ts` stays pure and clock-injectable.

## 5. Invariant sweep

The protected state is the per-recipient delivery truth. This design changes how
it is PRESENTED, so both the readers of the STATE and the callers of the CHANGED
FUNCTIONS are enumerated - rev 1 listed only the first set, and the second is
where the out-of-scope blast radius lives.

### Readers of `delivery_recipients` (dashboard) - verified exhaustive

1. `contact/Timeline.tsx:588` - the opted-out count feeding the note. UNCHANGED.
   Keep it, and keep it exactly as-is: it is NOT outbound-gated
   (`Timeline.tsx:666`) and `Timeline.test.tsx:701`/`:718` exercise it on INBOUND
   fixtures, where the list (which IS outbound-gated) never renders. It is the
   only carrier there, not a redundant one.
2. `contact/Timeline.tsx:600-603` - the rollup. CHANGED (S3).
3. `contact/Timeline.tsx:644` - the per-message chip's suppression, gated on the
   rollup being non-null. UNCHANGED. The list must not become a third element
   restating what the chip and the note already say.
4. `contact/deliveryStatus.ts:119` - `presentRelayDelivery`. CHANGED (S3).

### Callers of the changed FUNCTIONS - must not move

- `presentRelayDelivery` - `Timeline.tsx:602` only.
- `presentDeliveryStatus` - `Timeline.tsx:577` (the bubble),
  **`Timeline.tsx:920` (`EmailCard`)**, and
  **`broadcasts/broadcastFormat.ts:108`**. Both of the latter pass NO timestamp,
  so they opt out of staleness and stay unaffected by an additive change. They
  are the reason S4 puts the new opted-out label in the NEW per-leg presenter
  and not inside `presentDeliveryStatus`.
- `deliveryReason` - `Timeline.tsx:579`, `Timeline.tsx:921`, and
  **`broadcasts/DeliveryBadge.tsx:31`**.

Section 5 of rev 1 called broadcasts a "non-reader". True of the state, false of
the module: `broadcastFormat.ts:13` and `DeliveryBadge.tsx:7` import from it
directly.

### Writers - not touched, but the design depends on their exact output

`api.ts:1685`/`:1761`, `twilio.ts:610`/`:2381`,
`relayFanOut.ts:456/513/520/527/539/575`, `relayAnnouncements.ts:240/263/281`,
`groupSend.ts:612`, `groupDelivery.ts:59`, `groupReceipts.ts:419`,
`messagesRepo.ts:2721/2744/2820`. Each was read.

### Confirmed unaffected

The inbox row collector, Today, and the group-send staleness alarm (server-side,
its own 10-minute threshold; S3 now agrees with its non-terminal definition
rather than contradicting it).

## 6. Test strategy

### 6.1 The re-baseline this forces - exactly two assertions

`dashboard/src/test/setup.ts` pins the clock to `2026-07-01T12:00:00Z` and
`RELAY_OUT` (`Timeline.test.tsx:890-906`) is dated `2026-06-08` with
`c2: { status: 'sent' }`. That leg is three weeks quiet, so it goes stale and its
rollup moves from neutral branch 5 to danger branch 3.

**THE RULE: only a fixture containing a NON-TERMINAL leg (`queued` or `sent`)
moves. Every other rollup assertion must keep passing unchanged, and any other
failure is a REGRESSION, not a re-baseline.**

Exactly two assertions move, both on `RELAY_OUT`:

| Line | Test | Why it moves |
| --- | --- | --- |
| `Timeline.test.tsx:910` | `shows a "delivered N/M" summary` | c2 is `sent` and stale |
| `Timeline.test.tsx:999` | `keeps the in-flight rollup neutral` | same fixture; its INTENT is the neutral branch, so RE-DATE the fixture near the pinned clock rather than rewriting the expectation |

Rev 1 also named `:932`, `:949`, `:962`, `:976`, `:991` and `:1021`. All six are
fixtures whose legs are already terminal (or a `queued_pending` case with no
rollup at all), so none of them moves. Do not touch them.

`GroupTextView.test.tsx:1017` asserts `getByText(/delivered 1\/2/)` - a SUBSTRING
regex that still matches `delivered 1/2 - 1 not confirmed`. It will pass silently
and give no signal. TIGHTEN it to prove the new label rather than leaving a test
that cannot fail.

### 6.2 Unit

- `deliveryStatus.test.ts` - the pure layer, where the real coverage belongs:
  all six rollup branches including branch 0, the boundary at exactly
  `STALE_SENT_AFTER_MS`, `queued` staleness as well as `sent`, opted-out
  exclusion from every counter, the new `isStaleLeg` predicate, and the per-leg
  presenter including both product-aware opted-out labels and the
  transient-code-without-failure case. Keep the existing whole-object `toEqual`
  style.
- `Timeline.test.tsx` - rows appear per member with correct names under BOTH key
  conventions; roster order; all four S2 naming cases, especially case 3
  (empty roster must NOT say "former member"); no list for `queued_pending`, for
  an empty map, or on an inbound bubble; a list for the all-opted-out map
  ALONGSIDE the message-level chip.
- `GroupTextView.test.tsx` - one group-text-keyed case. That file uses bare
  `vi.fn()` with `mockReset().mockResolvedValue()` re-arming in `beforeEach` and
  a `cleanup()`-before-`restoreAllMocks()` teardown order. New tests must re-arm
  every mock they touch, or adopt the `AnyAsyncMock` default form from
  `ConversationDetail.test.tsx:34-47`. This is the shape that caused
  `conversationdetail-members-mock-suite-flake`.
- `ConversationDetail.test.tsx` has ZERO delivery-chip coverage. One relay-arm
  case closes a real hole.

Because the list is conditionally rendered (S1), presence and absence are REAL
unit assertions. What jsdom still cannot prove is visibility: `css:false`
(`dashboard/vite.config.ts:99`) means `display` rules do not exist there. Do not
write a `toBeVisible()` assertion about the reveal - it would be vacuous.

### 6.3 E2E

No seed row in ANY profile carries a `delivery_recipients` map, so a mixed state
cannot come from seed data. A stuck leg is armed with
`setDeliveryOutcome(request, { partyNumber, profile: { kind: 'stall' } })`
(`e2e/fixtures/fakeTwilio.ts:258`), which stalls at `sent`. Note the fixture's
declared profile type exposes `failState` while the engine's option is `stallAt`,
so a leg stuck at `queued` cannot be armed through the documented signature -
prove the `queued` half of S3 in the unit layer.

The e2e proves what jsdom cannot: reveal the bubble, the rows appear, and they
name the right member against the right state.

Staleness needs a 15-minute-old leg, which a live send cannot produce in-test.
Recommendation: prove staleness in the unit layer (where `nowMs` is already
injectable) and prove the LIST in the browser. Do not add a stale fixture to the
`lean` profile - it is the byte-stable e2e world.

**Scope the two existing locators.** `group-text-stop.spec.ts:133` and `:136`
already disambiguate two surfaces carrying "1 member opted out" text, and the new
rows add a third string to the same page when a bubble is revealed. Scope those
locators to their elements rather than leaving them page-wide.

Add a `selectors.md` row: neither the delivery chip nor the bubble reveal is
documented there today.

## 7. Acceptance

1. On the 8/23 shape - two members, one delivered, one non-terminal for over 15
   minutes - the bubble shows a danger `delivered 1/2 - 1 not confirmed` with no
   interaction, and revealing it names Shamanic delivered with a time and Wolf
   not confirmed.
2. That escalation appears on a bubble that was ALREADY on screen when the
   boundary passed, with no reload, no navigation and no inbound message (S7).
3. An opted-out member appears as a row saying they were not sent to, with
   product-aware copy, and the denominator is unchanged from today.
4. An all-opted-out send renders the message-level chip AND names the members.
5. A fully delivered group still reads `Delivered M/M` in success tone; a
   `queued_pending` hold still shows only its own queued chip with no list.
6. The four list-rendering surfaces render it correctly in a browser, and the
   contact page is verified UNCHANGED (it can never render a list - section 2).
7. The four gates pass from the worktree: `npm run typecheck`, `npm test`,
   `npm run smoke`, `npm run e2e`.
