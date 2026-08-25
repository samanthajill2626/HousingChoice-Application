# Per-recipient delivery visibility on multi-party message bubbles

Status: DESIGN rev 4 (folds design review rounds 1-3 - 48 findings, 46 accepted)
Date: 2026-08-24
Branch: `feat/per-recipient-delivery`  Worktree: `W:\tmp\per-recipient-delivery`
Base: `main` @ f0e5ab46
Adjudications: `.superpowers/design-review/adjudications.md`

## 1. Why

On 2026-08-23 the founder sent a photo twice into a two-member relay tour group
(conv-07e4f611). Both times the bubble showed one neutral chip reading
`delivered 1/2`. The founder concluded the message had reached Wolf and not
Shamanic. The truth was the exact inverse: Shamanic (Verizon) got it in six
seconds both times, and Wolf's leg (Dish Wireless) stuck at `sent` with no error
code and no receipt - see `mms-silent-drop-dish-textnow`.

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
rule of its own.

## 2. Scope

Dashboard-only. No backend change, no schema change, no API change, no new
dependency. `delivery_recipients` reaches the client intact on the two paths
that can carry it: `useRelayThread.ts:66` and, through the shared
`buildRelayItems`, `useGroupThread.ts:188`.

The two contact-timeline paths also carry the field
(`buildTimelineFallback.ts:88`, `contactTimeline.ts:422`) but can never deliver
a populated map, because both filter multi-party threads out by type first
(`contactTimeline.ts:1058`, `useContactTimeline.ts:190-194`). That is why the
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

- **The inbound half of the feature.** S1's gate begins with `outbound`,
  inherited from the rollup, and that is NOT a no-op. An INBOUND relay source
  message carries a real, populated fan-out map: `twilio.ts:610` seeds it and
  `relayFanOut` fills the slots as it relays that member's message on to
  everyone else. `Timeline.test.tsx:701-716` pins exactly that shape on an
  inbound fixture. So on member-authored relay traffic - most of a relay group's
  volume - there is no rollup, no escalation, and no list. If a member's message
  is the one silently dropped, the dashboard shows nothing.

  **The honest reason for deferring is scope and review budget, not mechanism.**
  An earlier draft said widening it "would newly render a chip on inbound
  bubbles". That is true of the ROLLUP and false of the LIST: S1's gate is now
  independent of the rollup (the entire point of that fix), so dropping
  `outbound` from the LIST's gate alone would render no chip - only rows inside
  a disclosure that is closed by default. And per-recipient information already
  ships on inbound multi-party bubbles: the opt-out note is not outbound-gated
  (`Timeline.tsx:666`), reads the same map (`:588`), and is pinned on inbound
  fixtures (`Timeline.test.tsx:701`/`:718`). A revealed row list would not be a
  new CLASS of statement there, just the same class with names. It is deferred
  because it widens a design already three review rounds deep. FILE IT, and
  record that it is cheaper than it looks.
- **The bubble reveal is not keyboard-reachable.** The bubble is a `div` with an
  `onClick` and no `role`, `tabIndex`, or `aria-expanded`
  (`Timeline.tsx:619-623`). PRE-EXISTING, and this design makes the consequence
  worse: what sits behind the inaccessible control today is a nicety (transport /
  number / time, whose time is already in the cluster label), and after this
  change it is the payload of the feature. S6 limits the damage; it does not
  erase it. The honest fix collides with the interactive children already nested
  in the bubble (a Link at `:631`, a Retry button at `:687`). File it.
- **A relay-observed 21610 keeps the raw code.** `twilio.ts:2386` writes
  `errorCode: '21610'` on a relay leg, while the group path translates the same
  event to `contact_opted_out` (`groupReceipts.ts:419`). Only the translated
  form is excluded from the denominator. Real, pre-existing. File it.
- Carrier-fallback behavior belongs to `mms-silent-drop-dish-textnow`.
- Reusing the broadcasts `DeliveryBadge`. It is broadcast-typed
  (`status: BroadcastRecipient['status']`), runs `presentRecipientStatus` from
  `broadcasts/broadcastFormat.js` rather than the comms presenter, and carries
  its own CSS module (`DeliveryBadge.tsx:19-31`). Reuse would mean widening its
  prop type and dragging a second CSS module into the bubble.

## 3. Locked decisions (human, 2026-08-24)

1. **The breakdown folds into the EXISTING bubble reveal.** No second click
   target inside the bubble.
2. **Opted-out members appear in the list**, labelled as not sent, and stay OUT
   of the N/M denominator exactly as today.
3. The rollup escalates when a leg goes quiet.

### 3.1 The tradeoff decision 1 accepts, and what delivers it

Folding into the reveal means nothing on the chip advertises the answer behind
it. That is acceptable only because decision 3 makes the chip escalate on its
own: the founder sees a red `delivered 1/2 - 1 not confirmed` without clicking,
and clicks only to learn WHO.

Rev 1 did not deliver that. Staleness is computed during render against
`Date.now()` (`deliveryStatus.ts:88`), and no timeline surface schedules a
render as time passes - the only production interval in the conversation routes
is `GroupTextView.tsx:152-166`, a member-panel poll. A silently dropped leg
produces no further receipt BY DEFINITION, so no `message.persisted`, no SSE
refetch, no re-render. S7 supplies the tick. If S7 were dropped, decision 1
would have to be revisited.

## 4. Behavior

### S1 - The per-recipient list, and exactly when it renders

**The gate is ONE predicate, independent of the rollup's value:**

```
outbound AND the map has at least one slot AND delivery_status !== 'queued_pending'
```

Deliberately NOT "whenever the rollup is present". Passing the three gates at
`Timeline.tsx:600-603` does not make the rollup non-null: `presentRelayDelivery`
returns null for an all-opted-out map as well as an empty one
(`deliveryStatus.ts:128-129`). Gating on the rollup would delete locked
decision 2 in the one case where the opted-out members are the only information
the bubble has.

Consequences, all intended:

- **Empty map `{}`** (seeded on every relay inbound source message,
  `twilio.ts:610`): no slots, no list.
- **All-opted-out map**: the list renders. The rollup stays `null`, so the
  message-level chip still renders (`Timeline.tsx:644`, unchanged) reading
  "Undelivered - Everyone here has opted out - nothing was sent", and the count
  note still renders. Three elements, three jobs: the chip states the aggregate,
  the note counts, the rows NAME. No row restates the aggregate, so this is not
  the "third chip fighting the other two" that section 5 forbids.
- **`queued_pending` hold**: no list, matching the rollup's exclusion. Its slots
  are pre-seeded placeholders (`api.ts:1684-1686`); nothing was fanned out.

**The list is CONDITIONALLY RENDERED on the revealed state** - in the DOM only
while the bubble is revealed. It does NOT copy the meta line's `display:none`
mechanism (`Timeline.module.css:296-305`). Three reasons: a conditional render
makes presence/absence a real unit assertion where a `css:false` environment can
prove nothing about visibility (6.2); it keeps hidden row text out of the DOM
that the existing group e2e specs match with page-scoped `getByText` (6.3); and
a collapsed bubble then carries no claims at all. (Rev 2 also claimed the CSS
approach would hide the rows from assistive technology even when open. That was
FALSE - `.bubble.revealed .metaText { display: inline }` puts the element back
in the accessibility tree. The two approaches differ only while collapsed.)

One row per slot, in ROSTER ORDER, with slots whose key matches no roster member
last in map-key order. Each row carries the member's label (S2), their own state
(S4), a timestamp when one exists, and a reason when the row is a failure.

Timestamps: `deliveredAt` on a delivered leg, and `sentAt` on ANY leg that has
one - not only a `sent` leg. Under the S3 table a `queued` leg can be stale ONLY
if it carries `sentAt`, so restricting the timestamp to `sent` legs would render
the new `Queued - not confirmed` row (S4a) as a red state with no time, while
the identical fact one status over showed one. The row is the answer to "why is
the chip red"; it must not withhold the very evidence that justifies it. This
keeps S1's timestamp rule tracking S3's eligibility rule instead of diverging
from it.

Group-text legs never have `sentAt` (S5), so many rows still show a state with
no time. Correct; do not back-fill from the message's time, which would present
a message-level fact as a per-leg one.

**Rows do NOT `stopPropagation`.** They are children of the bubble div whose
`onClick` is the toggle (`Timeline.tsx:619-623`), so clicking a row collapses
the list - which is ordinary disclosure behavior and is what locked decision 1
asks for. The two existing interactive children DO opt out (the closed-group
Link at `:635`, the Retry button at `:691`), so a builder could reasonably add
it defensively; this sentence exists to stop them. Staff selecting a phone
number are already protected: `toggleMeta` early-returns while a text selection
exists (`Timeline.tsx:614-617`).

### S2 - Naming a recipient

Every row must carry a label; a blank row defeats the feature. `senderLabel`
(`lib/memberAttribution.ts:60`) is NOT reusable as-is: for `kind = 'relay'` it
returns `undefined` for a nameless member, on purpose
(`memberAttribution.ts:55-59`, invariant 6).

**THREE cases, in order. The load-bearing distinction is between case 2 and
case 3** - an absent roster is not the same fact as an absent member:

1. **Roster present and non-empty, key matches a member.** Label with
   `groupMemberLabel(member)` (`lib/groupThread.ts:60`) - name, else formatted
   number. Match EITHER key convention: a relay key is `relayMemberKey`, which is
   the opaque `contactId` when the member has one and otherwise falls back to
   `phone#<E164>` (`messagesRepo.ts:156-160`); a group-text key is ALWAYS
   `phone#<E164>` (`app/src/services/groupMembers.ts:32,43`). Those two shapes
   are exhaustive - no third exists in `app/`. Because a contactless RELAY member
   is phone-keyed, the phone branch must be decided by the KEY's `phone#` prefix
   and never by `rosterKind`. The superset match at `memberAttribution.ts:75-77`
   is the behavior to reuse - EXTRACT it, do not re-implement it.
2. **Roster present and non-empty, no match** - a member removed since this
   message was sent, because the roster is CURRENT membership while the map is
   historical. Phone-keyed: show the formatted number, marked a former member.
   ContactId-keyed: a former member with no name.
3. **Roster ABSENT or EMPTY.** Make NO membership claim.
   `TourConversation.tsx:425` and `PlacementConversation.tsx:281` both
   initialise `members` to `[]` and swallow a roster fetch failure, so two of
   the four list-rendering surfaces can render with an empty roster
   indefinitely. `ConversationDetail.tsx` reaches this state by a NARROWER
   route than an earlier revision claimed: `:180` seeds `members` from
   `header.participants ?? []` and its `.catch` (`:218-221`) sets only
   `membersStatus`, so a roster fetch FAILURE there leaves the header roster in
   place; it reaches case 3 only when `header.participants` is itself
   absent/empty, including the window before the fetch resolves. Construct case
   3 in tests with Placement/Tour semantics (an empty roster prop), never by
   failing `getConversationMembers` on ConversationDetail. Treating
   absent-roster as no-match
   would assert EVERY recipient of EVERY message a former member - a confident
   false statement from the feature built to stop confident false readings, and
   worse than the chip it replaces because it looks like an answer. Phone-keyed:
   the formatted number. ContactId-keyed: a neutral unnamed-recipient label.
   Neither says anything about membership.

**Decision taken explicitly (invariant 6).** Case 1 applies the number fallback
to relay rows, which `memberAttribution.ts:55-59` reserved as "a product
decision on its own". This design takes it: a blank row is useless, and
`undefined` is only tolerable for an attribution chip that may render nothing.
The resulting split is accepted - a nameless relay member is unnamed as an
AUTHOR and shown by number as a RECIPIENT. `lib/groupThread.ts:53-58` warns
about that drift; here it is deliberate, because the two surfaces answer
different questions.

### S3 - Staleness, per leg and in the rollup

#### The eligibility rule

A leg is STALE when **it has a clock that proves the leg itself started, and
that clock has been quiet for at least `STALE_SENT_AFTER_MS`** (15 minutes,
`deliveryStatus.ts:54`).

Concretely, given `sentAt` on the slot and `at` on the message:

| leg status | has a PARSEABLE `sentAt` | ages from | can go stale |
| --- | --- | --- | --- |
| `sent` | yes | `sentAt` | yes |
| `sent` | no | `msg.at` | yes |
| `queued` | yes | `sentAt` | yes |
| `queued` | no | - | **NO** |
| `queued_pending` | either | - | no |
| terminal (`delivered`/`failed`/`undelivered`) | either | - | no |

The table is EXHAUSTIVE over `DeliveryStatus`, which has six members
(`messagesRepo.ts:110-116`, mirrored at `api/types.ts:1508-1518`). A
`queued_pending` slot never occurs today - `api.ts:1684-1686` seeds slots
`{ status: 'queued' }` even under a `queued_pending` PARENT - but it gets a row
anyway, on the same "true by construction rather than by luck" standard S5
applies to the imported guard. A hold has not been dispatched, so it cannot be
overdue.

"PARSEABLE" is load-bearing, not decorative. `isQuietSince` carries the
`Number.isFinite` guard, so a `sentAt` that is present but does not parse would
yield a NaN clock and silently never age - it must fall to the no-clock rows
instead, where the rule is explicit. (Unreachable on today's relay data:
`providerTs` is a non-optional string
(`app/src/adapters/messaging.ts:87`) produced as
`(message.dateCreated ?? new Date()).toISOString()` (`:660`). The gap is in the
rule's construction, not in the data.)

**Why row 2 does not re-open the hazard rows 4-5 exist to forbid.** Row 2 ages a
clock-less `sent` leg from `msg.at`, which is exactly the ageing the `queued`
rows refuse. It is safe only because a RELAY leg cannot reach `sent` without a
`sentAt`: the fan-out writes both on the same object (`relayFanOut.ts:539-543`),
and the DLR path is child-field-only and never clears it
(`messagesRepo.ts:2775-2792` sets `status`/`errorCode`/`deliveredAt`/`sid`,
never `sentAt`). So row 2 is reached only by a native group-text leg, whose
`msg.at` IS its send time - group sends are not held. This reasoning is the
load-bearing part of row 2 and must not be lost if either write path changes.

**Why a `queued` leg with no `sentAt` must never age.** Rev 2 aged every
non-terminal leg from `msg.at` when `sentAt` was absent, and that is wrong in
two ways that only appear at the write paths:

1. **A released connect-when-ready hold would render instant red.**
   `relayQueuedMessages.ts:87-95` transitions the parent `queued_pending ->
   queued` and only THEN enqueues the fan-out. In that window the parent is
   `queued` (so S1's gate passes and the rollup runs), every slot is still the
   seeded `{ status: 'queued' }` (`api.ts:1684-1686`), no slot has `sentAt`, and
   `msg.at` is the ORIGINAL compose time - days old, because connect-when-ready
   waits on a number warming and A2P-registering. Every leg would read stale and
   the bubble would announce `delivered 0/N - N not confirmed` for a message not
   yet handed to the provider once. Connect-when-ready's whole contract is that
   a queued message is never lost (`api.ts:1676-1679`); this would greet its
   release by claiming nobody got it.
2. **A receipts-webhook outage would redden history permanently.** A native
   group-text leg is seeded `{ status: 'queued' }` (`groupSend.ts:612`) and
   never receives `sentAt` at all (S5). After a webhook outage - misconfigured
   URL, rotated token, the failures `groupSendStaleness.ts:5-10` enumerates -
   every leg of every send in that window rests at `queued` for ever. Aging them
   from `msg.at` turns every one of those bubbles danger, retroactively and
   permanently, for messages that in all likelihood arrived. Restoring the
   webhook repairs nothing: no receipt is redelivered for a send that already
   happened.

Requiring `sentAt` fixes both, because `sentAt` is only ever written after a
real provider send returned (`relayFanOut.ts:542`, `relayAnnouncements.ts:266`).

**The accepted cost - this is a TRADE, not a fix, and this paragraph is what is
being signed off.** The rule silences the ENTIRE "our dispatch never happened"
class, on BOTH products. No leg that never got a provider response can ever
escalate. That covers at least:

- **A native group text after a receipts-webhook outage.** Every leg of every
  send in the window rests at `queued` for ever (`groupSend.ts:612` seeds it,
  and no `sentAt` is ever written on that product).
- **A relay fan-out that was never enqueued.** `api.ts:1796-1804` catches and
  LOGS an enqueue failure without throwing - the message row is already
  committed with every slot at `{ status: 'queued' }` and no `sentAt`, and
  nothing will ever run. The app's own ERROR log says "message persisted, not
  relayed" while the bubble says, for ever, a neutral `delivered 0/N`.
- **A fan-out job that died or DLQ'd** after a successful enqueue. The repo
  already carries this shape for the sibling channel
  (`docs/issues/email-outbound-stuck-queued-on-crash.md`).

**The rule cannot do better, and that is the honest framing.** The released-hold
state and the never-dispatched state are BYTE-IDENTICAL at the data layer:
parent `queued`, every slot `{ status: 'queued' }`, no `sentAt`, `msg.at`
arbitrarily old. Nothing in the row distinguishes "about to send" from "will
never send", so one answer must serve both. This design picks silence, on the
judgement that a false red on a message that is about to send is worse than
silence on one that never will - a false red trains staff to ignore the cue,
which is the failure mode that produced the incident in the first place.

The dashboard is therefore quieter than the server on this class: `classifyStuck`
returns ERROR for a `queued` leg and only WARN for an all-`sent` one
(`groupSendStaleness.ts:24-28`, `:119-125`). Accepted because the server alarm
already covers it and it is our plumbing failing rather than a carrier - but it
IS a coverage gap, not a solved problem.

A transient deferral is safely un-aged for a different and better reason: it is
actively retrying and reaches a terminal `transient_cap` failure on its own
(`relayFanOut.ts:568-578`). The whole-slot SET at `relayFanOut.ts:527`
(`messagesRepo.ts:2721`) would also clear any `sentAt`, but at that line there
is nothing to clear - the write happens in the `catch` of a send that THREW, so
no `providerTs` was ever obtained. Do not rely on a clearing path that never
runs.

#### The mechanism

Rev 2 ordered ONE shared predicate for both callers AND a `sent`-only 1:1 rule.
Those cannot both hold, and `deliveryStatus.test.ts:197-201` pins the side that
would break ("leaves every OTHER status alone no matter how old", asserting a
`queued` 1:1 message stays neutral no matter its age). Resolution - one shared
CLOCK COMPARISON, two thin predicates over it:

- `isQuietSince(atMs, nowMs)` - exported. The single copy of
  `nowMs - atMs >= STALE_SENT_AFTER_MS`, with the `Number.isFinite` guard.
- `presentDeliveryStatus` keeps its `sent`-only gate, now expressed through
  `isQuietSince`. **`deliveryStatus.test.ts:197-201` must keep passing
  verbatim.**
- `isStaleLeg(slot, messageAtMs, nowMs)` - exported. Encodes the table above and
  calls `isQuietSince`.

One threshold, one comparison, no divergent copy, and the 1:1 rule untouched.

**The staleness inputs on `presentRelayDelivery` are OPTIONAL**, mirroring
`presentDeliveryStatus`'s `sentAtMs?` (`deliveryStatus.ts:85-89`). A call that
omits them behaves exactly as today. This is what keeps all ELEVEN existing
`presentRelayDelivery` assertions in `deliveryStatus.test.ts` green (6.1) - but
see 6.1 for what "green" then means, because the only production caller
(`Timeline.tsx:602`) always passes the clock.

**Typecheck item:** counting J requires each slot's own clock, so
`RelayDeliverySlot` (`deliveryStatus.ts:102-106`, today
`{ status: DeliveryStatus; errorCode?: string }`) must gain `sentAt?: string`.
`npm run typecheck` is a required gate and this is the type it will fail on
first.

#### The rollup's branches - ALL SIX, in evaluation order

Branch 0 already exists and is UNCHANGED. It is named because rev 1 omitted it
and a builder rewriting from the list would have dropped it:

| # | Condition | label | tone | isFailure | reason |
| --- | --- | --- | --- | --- | --- |
| 0 | no non-suppressed legs (empty map, or all opted out) | - | - | - | returns `null`, UNCHANGED (`deliveryStatus.ts:129`, pinned by `deliveryStatus.test.ts:123`) |
| 1 | any hard-failed leg, no stale leg | `delivered N/M - K failed` | danger | true | joined failure reasons (unchanged) |
| 2 | any hard-failed leg AND any stale leg | `delivered N/M - K failed, J not confirmed` | danger | true | joined FAILURE reasons only |
| 3 | any stale leg, no hard failure | `delivered N/M - J not confirmed` | danger | false | none |
| 4 | every leg delivered | `Delivered M/M` | success | false | none |
| 5 | otherwise | `delivered N/M` | neutral | false | none |

Branch 3 is `isFailure: false` on purpose, following
`STALE_SENT_PRESENTATION`'s documented reasoning (`deliveryStatus.ts:64-73`): no
receipt is not proof of failure, and `isFailure` is what offers a Retry that
could double-send. Branch 2 is `isFailure: true` because a real failure exists.

Opted-out legs stay excluded from N, M, K and J, keyed on
`errorCode === 'contact_opted_out'` ALONE (`deliveryStatus.ts:120-127`).

**The rendered chip strings.** `Timeline.tsx:660-662` appends the reason inline
after the label, so branch 2 is the longest string this design produces:

```
delivered 0/3 - 1 failed, 1 not confirmed - Number not registered for A2P 10DLC (error 30034)
```

Reason LAST, after both counts - it belongs to the failed legs only, and putting
it between the counts would attach it to the wrong one. The meta row wraps via
`.meta { flex-wrap: wrap }` (`Timeline.module.css:283-284`; the wrap sentence
rev 2 mis-cited to `:308-313` is in the `.metaText` comment at `:293-295`).
Because `.metaText` is `display:none` while collapsed, the long chip is ALONE in
the meta row when collapsed and shares it only when revealed - which after S1 is
also when the rows render. Verify the wrap in that state.

### S4 - Per-leg labels

Per-leg state reuses `presentDeliveryStatus` so a leg and a 1:1 message never
disagree about what a status means, EXCEPT for the two cases below.

**(a) The stale row.** `presentDeliveryStatus` will not produce a stale
presentation for a `queued` leg, because the 1:1 rule stays `sent`-only. So the
per-leg presenter renders both stale strings itself:

- stale `sent` leg: `Sent - not confirmed` (matching
  `STALE_SENT_PRESENTATION`, `deliveryStatus.ts:69-73`)
- stale `queued` leg: `Queued - not confirmed`

They must differ. "Sent - not confirmed" on a leg the provider never reported
sent asserts an event that did not happen. Both are `tone: danger`,
`isFailure: false`, for branch 3's reason.

**(b) The opted-out row.** Identified by `errorCode === 'contact_opted_out'`
alone, on either `failed` (relay, `relayFanOut.ts:456`) or `undelivered` (group,
`groupDelivery.ts:59`). It reads as not sent rather than as a failure, and it is
PRODUCT-AWARE, mirroring the split the note above it already makes
(`Timeline.tsx:666-685`) because the mechanism genuinely differs: on a group
text Twilio skips the participant, on a relay the app itself declines to send.
`rosterKind` is in scope at `Timeline.tsx:539`.

- `group_text`: `Not sent - opted out (Twilio skips them)`
- `relay`: `Not sent - opted out`

**This row does NOT go through `deliveryReason`.** That maps
`contact_opted_out` to "Everyone here has opted out - nothing was sent"
(`deliveryStatus.ts:192-194`), copy written for the message-level AGGREGATE and
documented as such at `:180-186`. On the row of the one member in five who opted
out it would be a fresh instance of the misread class this feature exists to
kill.

**Both new labels live in the NEW per-leg presenter, never inside
`presentDeliveryStatus`** - see the caller list in section 5.

A reason renders on a row only when that row's presentation `isFailure`,
mirroring `Timeline.tsx:579`. An `errorCode` does NOT imply failure:
`relayFanOut.ts:527` writes `{ status: 'queued', errorCode: <transient code> }`,
and printing a carrier code beside a still-retrying leg would be its own
misread.

### S5 - Which clock, and why it differs by product

`sentAt` is written ONLY by the two relay send paths (`relayFanOut.ts:542`,
`relayAnnouncements.ts:266`) and holds the PROVIDER's timestamp string.
`deliveredAt` is written ONLY on the `delivered` transition
(`messagesRepo.ts:2786`) and holds OUR server clock. A native group-text leg
never has `sentAt`: its seed is a bare `{ status: 'queued' }` and the receipts
path writes only status, errorCode, deliveredAt and sid.

- **`sentAt` and `deliveredAt` must never be subtracted FROM ONE ANOTHER**, or
  presented as a duration: they come from different clocks. This does NOT
  forbid `isQuietSince`, which subtracts a `sentAt` from the browser's
  `Date.now()`. That cross-clock comparison is already the shipped 1:1 behavior
  (`Timeline.tsx:577` parses `provider_ts` against `Date.now()`), both are UTC
  wall clocks, and a 15-minute budget swamps any plausible skew.
- `imported` rows carry no `delivery_recipients` at all, so the imported-row
  suppression at `Timeline.tsx:577` has no per-leg equivalent to break. Carry
  the same guard anyway - withhold the clock when the parent is imported - so
  the rule stays true by construction.

### S6 - Accessible summary while collapsed

The always-visible delivery chip carries the per-recipient summary as an
accessible name, so a screen-reader user gets the facts without opening a
disclosure they cannot reach by keyboard.

**Mechanism: `role="img"` plus `aria-label` on the chip span.** A bare `<span>`
maps to `role=generic`, on which ARIA prohibits an author-provided name, so
rev 1's plain `aria-label` was the one construct guaranteed not to work.
`role="img"` makes the chip a leaf in the accessibility tree and supports a name
from the author. This is already the repo's pattern -
`dashboard/src/routes/contact/AutoBadge.tsx:25` is
`<span role="img" aria-label="Auto" title={title} className={styles.badge}>`.

Rejected alternative: visually-hidden `.srOnly` text
(`Timeline.module.css:954`). It works and the repo uses it elsewhere, but it
puts duplicate text in the DOM permanently, which is the hazard 6.3 manages for
the e2e locators. `role="img"` adds no text nodes.

**WHICH chip.** Whichever one is actually rendered:

- rollup present (branches 1-5): the rollup chip (`Timeline.tsx:656-664`);
- rollup null with a non-empty map (branch 0, all opted out): the MESSAGE-LEVEL
  chip (`Timeline.tsx:644-655`), because no rollup chip exists there. This is
  the bubble S1 was rewritten to serve - without this clause the one case where
  the rows are the only thing naming anyone would give a screen-reader user the
  aggregate sentence and no names.

**The name's shape:** the visible label, then each recipient and their state,
e.g. `delivered 1 of 2. Shamanic Davis: delivered. Wolf: sent, not confirmed.`
Where the visible chip carries a reason in `title` (`Timeline.tsx:659`), the
`title` stays for mouse users and the reason is folded into the `aria-label`,
which supersedes it as the accessible name.

**Three consequences of that shape, stated because they are not obvious:**

1. **S2 runs UNCONDITIONALLY.** The name needs every slot's label, so the roster
   match and the `groupMemberLabel` fallback execute on every outbound
   multi-party bubble whether or not it is revealed. S1 and S2 otherwise read as
   though naming is work the reveal triggers. It is not.
2. **The label uses S2 case 3's neutral wording, and that is a real cost.** A
   screen-reader user on a surface whose roster failed to load
   (`TourConversation.tsx:425`, `PlacementConversation.tsx:281`) hears
   "unnamed recipient" once per member per message - the audible form of the
   degraded state case 3 exists to keep honest. It is still the right wording:
   an invented name would be the false reading case 3 forbids. Where the roster
   is absent AND every slot is contactId-keyed, the name may omit the
   per-recipient clause entirely and carry only the count, rather than recite
   "unnamed recipient" N times.
3. **S1's second justification is weakened, deliberately.** S1 partly justifies
   the conditional render by keeping row text out of the DOM; S6 puts the same
   information back as an ATTRIBUTE on every such bubble, always. The specific
   e2e hazard does not recur - Playwright's and RTL's `getByText` match text
   content, not attributes - but `getByRole('img', { name })` and
   `getByLabelText` DO, and 6.2 asks for `toHaveAccessibleName` assertions, so
   the string is now part of the tested surface. S7 also recomputes it on every
   tick for every bubble.

### S7 - A clock that ticks

Without this, S3 computes an escalation nothing ever renders (3.1). Verified
favourable: there is no `React.memo` in `Timeline.tsx`, so a state bump in the
timeline genuinely re-renders every `MessageBubble` and recomputes staleness.

- The interval is COARSE (order of a minute) and drives only a re-render; it
  fetches nothing and must not touch the network.
- **Run condition: at least one rendered outbound leg is non-terminal AND
  ELIGIBLE TO AGE AND NOT YET STALE.** All three clauses are required, and each
  fixes a different non-termination:
  - *non-terminal* alone (rev 2) never terminates, because a stale leg stays
    non-terminal for ever.
  - *non-terminal AND not-yet-stale* (rev 3's first attempt) never terminates
    either, for the legs S3 makes permanently un-ageable: a `queued` leg with no
    `sentAt` is non-terminal and not-yet-stale FOR EVER, so the interval would
    run forever on exactly the threads S3's cost paragraph describes - a group
    text after a webhook outage, and a relay message whose fan-out never ran.
  - *eligible to age* closes it. A leg with no ageing clock schedules nothing,
    exactly like a terminal one. Concretely: the leg must be a row of the S3
    table for which `isStaleLeg` COULD become true later, and must not be true
    yet.

  Staleness is monotonic and any real receipt arrives as an SSE refetch rather
  than a tick, so the tick only ever has to carry a leg ACROSS the boundary.
- **Visibility-gated**, matching the documented precedent in the same route
  folder (`GroupTextView.tsx:152-166`: "polling a hidden tab spends N contact
  reads a minute to update pixels nobody is looking at"). That interval fetches,
  so its cost argument is stronger, but the pixels argument applies verbatim -
  and thread paging means the re-rendered timeline grows without bound as staff
  load older pages.
- Cleaned up on unmount.
- The tick is a rendering concern and belongs beside the timeline, not in the
  pure presenter module. `deliveryStatus.ts` stays pure and clock-injectable.

**It runs normally under test.** Rev 2 told the builder to suppress it in test
environments on the theory that the pinned clock would make it spin. That
diagnosis was wrong: `dashboard/src/test/setup.ts:13-15` is explicit that a bare
`vi.setSystemTime` mocks ONLY `Date` and leaves timers genuinely real, and a
~60s real interval never fires inside a suite whose `testTimeout` is 15000
(`vite.config.ts:101`). Suppressing it would have converted an untested feature
into an untestable one and invited `import.meta.env.MODE` sniffing into a
production component. See 6.2 for how it IS tested.

## 5. Invariant sweep

The protected state is the per-recipient delivery truth. Both the readers of the
STATE and the callers of the CHANGED FUNCTIONS are enumerated - the second set
is where the out-of-scope blast radius lives.

### Readers of `delivery_recipients` (dashboard) - verified exhaustive

1. `contact/Timeline.tsx:588` - the opted-out count feeding the note. UNCHANGED,
   and keep it exactly as-is: it is NOT outbound-gated (`Timeline.tsx:666`) and
   `Timeline.test.tsx:701`/`:718` exercise it on INBOUND fixtures, where the
   list never renders. It is the only carrier there, not a redundant one.
2. `contact/Timeline.tsx:600-603` - the rollup. CHANGED (S3).
3. `contact/Timeline.tsx:644` - the per-message chip's suppression, gated on the
   rollup being non-null. UNCHANGED as a gate; it additionally gains the S6
   accessible name on the branch-0 bubble.
4. `contact/deliveryStatus.ts:119` - `presentRelayDelivery`. CHANGED (S3).

### Callers of the changed FUNCTIONS - must not move

- `presentRelayDelivery` - `Timeline.tsx:602` only.
- `presentDeliveryStatus` - `Timeline.tsx:577` (the bubble),
  **`Timeline.tsx:920` (`EmailCard`)**, and
  **`broadcasts/broadcastFormat.ts:108`**. Both of the latter pass NO timestamp,
  so they opt out of staleness and stay unaffected by an additive change. They
  are why S4 puts the new labels in the NEW per-leg presenter.
- `deliveryReason` - `Timeline.tsx:579`, `Timeline.tsx:921`, and
  **`broadcasts/DeliveryBadge.tsx:31`**.

Broadcasts are readers of the MODULE (`broadcastFormat.ts:13`,
`DeliveryBadge.tsx:7`) though not of the state.

### Writers - not touched, but the design depends on their exact output

`api.ts:1685`/`:1761`/`:1796-1804` (the caught enqueue failure),
`relayQueuedMessages.ts:87-95` (the hold release), `twilio.ts:610`/`:2381`,
`relayFanOut.ts:456/513/520/527/539/568-578` and its `markRecipient` helper at
`:708`, `relayAnnouncements.ts:240/263/281` and its `markSlot` helper at `:314`,
`groupSend.ts:612`, `groupDelivery.ts:59`, `groupReceipts.ts:419`/`:467`
(`setRecipientDeliverySid`), `messagesRepo.ts:2721/2744/2820`. Each was read.

The three helper hops matter because S3's arguments depend on them: both
`markRecipient` and `markSlot` pass their argument straight through to the
whole-slot SET, and `setRecipientDeliverySid` writes only `sid` under
`attribute_not_exists(...#sid)` (`messagesRepo.ts:2826-2832`), so none of them
can add or remove a `sentAt`.

### Confirmed unaffected

The inbox row collector, Today, and the group-send staleness alarm (server-side,
its own threshold; S3 now states where the two deliberately disagree).

## 6. Test strategy

### 6.1 The re-baseline census - exactly three assertions, across two files

`dashboard/src/test/setup.ts` pins the clock to `2026-07-01T12:00:00Z` and
`RELAY_OUT` (`Timeline.test.tsx:890-906`) is dated `2026-06-08` with
`c2: { status: 'sent' }`. That leg is three weeks quiet, ages from `msg.at`
(no `sentAt`), and goes stale.

**THE RULE: an assertion moves only if its fixture contains a leg that is STALE
under the S3 table - which requires `sent`, or `queued` WITH a `sentAt`. Every
other rollup assertion must keep passing unchanged, and any other failure is a
REGRESSION, not a re-baseline.**

| File | Assertions | Move? |
| --- | --- | --- |
| `Timeline.test.tsx:910` (`shows a "delivered N/M" summary`) | 1 | YES - c2 `sent`, stale |
| `Timeline.test.tsx:999` (`keeps the in-flight rollup neutral`) | 1 | YES - same fixture. Its INTENT is the neutral branch, so RE-DATE the fixture near the pinned clock rather than rewriting the expectation |
| `Timeline.test.tsx` `:932`, `:949`, `:962`, `:976`, `:991`, `:1021` | 6 | NO - all terminal legs, or `queued_pending` with no rollup. Do not touch |
| `deliveryStatus.test.ts` - ELEVEN `presentRelayDelivery` calls (`:39`, `:42`, `:48`, `:54`, `:64`, `:71`, `:85`, `:99`, `:114`, `:123`, `:125`), three with non-terminal legs (`:38-40`, `:41-43`, `:63-65`) | 11 | NO - the staleness inputs are OPTIONAL (S3), so a call that omits them behaves exactly as today. All eleven stay green |

**What "green" means there, and why it is not enough.** `Timeline.tsx:602` is
the only production caller and it ALWAYS passes the clock. So after this change
all eleven existing assertions exercise a no-clock mode with ZERO production
callers, and three of them assert outcomes that are wrong for the same slot
arrays in production:

| line | slots | asserts today | with a clock, aged |
| --- | --- | --- | --- |
| `:38-40` | `[{delivered},{sent}]` | `delivered 1/2`, neutral | branch 3, danger |
| `:41-43` | `[{queued},{queued}]` | `delivered 0/2`, neutral | branch 3 if the legs carry `sentAt`, else branch 5 |
| `:62-65` | `[{undelivered},{queued}]` | branch 1 | branch 2 if the `queued` leg carries `sentAt` |

Keep the eleven as the explicit no-clock contract, and ADD clock-passing twins
for those three rows - same arrays plus `sentAt` and a `nowMs`. Cheap, and without
them the file 6.2 calls "where the real coverage belongs" states the rule for a
mode nothing calls.
| `GroupTextView.test.tsx:1017` | 1 | Passes either way - `getByText(/delivered 1\/2/)` is a SUBSTRING regex that still matches `delivered 1/2 - 1 not confirmed`. TIGHTEN it to prove the new label rather than leave a test that cannot fail |

The optional-inputs decision is what keeps this census small. If a builder makes
the clock required instead, all eleven pure-layer call sites need editing and two
change VALUE - do not.

### 6.2 Unit

- `deliveryStatus.test.ts` - the pure layer, where the real coverage belongs:
  all six rollup branches including branch 0; the boundary at exactly
  `STALE_SENT_AFTER_MS`; the full S3 eligibility table, especially that a
  `queued` leg with NO `sentAt` never goes stale (the released-hold and
  receipts-outage cases); `isQuietSince` and `isStaleLeg`; that
  `presentDeliveryStatus` is unchanged for `queued` (`:197-201` verbatim);
  opted-out exclusion from every counter; both stale row strings; both
  product-aware opted-out labels; and the transient-code-without-failure case.
  Keep the whole-object `toEqual` style.
- `Timeline.test.tsx` - rows per member with correct names under BOTH key
  conventions; roster order; all three S2 naming cases, especially case 3 (empty
  roster must NOT say "former member"); no list for `queued_pending`, for an
  empty map, or on an inbound bubble; a list for the all-opted-out map ALONGSIDE
  the message-level chip.
  **Every list assertion - positive AND negative - must drive the reveal
  first.** The list is conditionally rendered, so a `queryBy...`-is-absent
  assertion written without a click passes on a completely broken build. Phrase
  the negative cases as "revealed, and still no list". The bubble is a `div`
  with no role, name or test id (`Timeline.tsx:619-623`), so reach it through a
  child - clicking the body text bubbles to `toggleMeta`.
- **S7's ticker** - release the `Date` pin and use fake timers, the sequence
  `dashboard/src/test/setup.ts:27-30` documents: `vi.useRealTimers()` then
  `vi.useFakeTimers()`. Render a bubble whose leg is non-terminal and NOT yet
  stale, advance past the boundary, assert the chip escalates with no refetch
  and no re-mount. Also assert the interval STOPS once every non-terminal leg is
  stale, and that a thread with only terminal legs schedules nothing. This is
  what proves acceptance 2.
- **S6's accessible name** - jsdom has no accessibility tree, but jest-dom is
  registered (`setup.ts:3`), so assert `toHaveAttribute('role', 'img')` and
  `toHaveAccessibleName(...)` on both the rollup chip and the branch-0
  message-level chip.
- `GroupTextView.test.tsx` - one group-text-keyed case. That file uses bare
  `vi.fn()` with `mockReset().mockResolvedValue()` re-arming in `beforeEach` and
  a `cleanup()`-before-`restoreAllMocks()` teardown order. New tests must re-arm
  every mock they touch, or adopt the `AnyAsyncMock` form from
  `ConversationDetail.test.tsx:34-47`. This is the shape that caused
  `conversationdetail-members-mock-suite-flake`.
- `ConversationDetail.test.tsx` has ZERO delivery-chip coverage. One relay-arm
  case closes a real hole.

`css:false` (`vite.config.ts:99`) means `display` rules do not exist in jsdom.
Never write a `toBeVisible()` assertion about the reveal - it would be vacuous.

### 6.3 E2E

No seed row in ANY profile carries a `delivery_recipients` map, so a mixed state
cannot come from seed data. A stuck leg is armed with
`setDeliveryOutcome(request, { partyNumber, profile: { kind: 'stall' } })`
(`e2e/fixtures/fakeTwilio.ts:258`), which stalls at `sent`. The fixture's
declared profile exposes `failState` while the engine's option is `stallAt`, so
a leg stuck at `queued` cannot be armed through the documented signature - prove
that half in the unit layer.

The e2e proves what jsdom cannot: reveal the bubble, the rows appear, and they
name the right member against the right state. Staleness stays in the unit layer
(15 real minutes is not an e2e). Do NOT add a stale fixture to the `lean`
profile - it is the byte-stable e2e world.

**Scope the two existing locators.** `group-text-stop.spec.ts:133` and `:136`
already disambiguate two surfaces carrying "1 member opted out" text, and a
revealed bubble adds a third string to the same page. Scope them to their
elements rather than leaving them page-wide.

Add a `selectors.md` row: neither the delivery chip nor the bubble reveal is
documented there today.

## 7. Acceptance

1. On the 8/23 shape - two members, one delivered, one `sent` and quiet for over
   15 minutes - the bubble shows a danger `delivered 1/2 - 1 not confirmed` with
   no interaction, and revealing it names Shamanic delivered with a time and
   Wolf not confirmed.
2. That escalation appears on a bubble ALREADY on screen when the boundary
   passed, with no reload, navigation or inbound message. Proven by the S7
   ticker unit test (6.2), not in a browser.
3. A released connect-when-ready hold does NOT render any "not confirmed" state
   before its fan-out has run.
3a. A thread whose only non-terminal legs are INELIGIBLE to age (a `queued` leg
   with no `sentAt`) schedules NO interval - the ticker must be provably absent
   there, not merely harmless.
4. An opted-out member appears as a row saying they were not sent to, with
   product-aware copy, and the denominator is unchanged from today.
5. An all-opted-out send renders the message-level chip AND names the members,
   and that chip carries the accessible summary.
6. A fully delivered group still reads `Delivered M/M` in success tone; a
   `queued_pending` hold still shows only its own queued chip with no list.
7. The four list-rendering surfaces render it correctly in a browser, and the
   contact page is verified UNCHANGED (it can never render a list - section 2).
8. The four gates pass from the worktree: `npm run typecheck`, `npm test`,
   `npm run smoke`, `npm run e2e`.
