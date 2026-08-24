# Per-recipient delivery visibility on multi-party message bubbles

Status: DESIGN (awaiting human spec gate)
Date: 2026-08-24
Branch: `feat/per-recipient-delivery`  Worktree: `W:\tmp\per-recipient-delivery`
Base: `main` @ f0e5ab46

## 1. Why

On 2026-08-23 the founder sent a photo twice into a two-member relay tour group
(conv-07e4f611). Both times the bubble showed one neutral chip reading
`delivered 1/2`. The founder concluded the message had reached Wolf and not
Shamanic. The truth was the exact inverse: Shamanic (Verizon) got it in six
seconds both times, and Wolf's leg (Dish Wireless) stuck at `sent` forever with
no error code and no receipt.

Two separate defects made that misread possible, and this design fixes both.

**D1 - the rollup discards WHO.** `Timeline.tsx:602` computes the chip with
`presentRelayDelivery(Object.values(msg.delivery_recipients))`. The
`Object.values` call throws away the member keys, so the only surviving fact is
a count. A 1-of-2 count is a coin flip, and the founder lost it. Every input a
breakdown needs is already in scope at that line: the roster is in the
component's closure as `relayRoster`, and each slot already carries `status`,
`errorCode`, `sid`, `sentAt` and `deliveredAt` on the wire, all currently unread
by any dashboard code.

**D2 - the rollup never goes stale.** The 1:1 path escalates a message stuck at
`sent` to a red "Sent - not confirmed" after `STALE_SENT_AFTER_MS` (15 minutes),
added deliberately after the 2026-08-19 oversize-MMS incident
(`outbound-mms-stalls-at-sent-with-no-receipt`). That rule lives only in
`presentDeliveryStatus`, which a multi-party bubble never calls: its per-message
chip is suppressed whenever a rollup exists (`Timeline.tsx:644`). So a relay
chip sits at neutral `delivered 1/2` forever and reads as "still in flight"
rather than "one recipient probably never got this". A carrier that silently
discards a message sends no receipt and no error, so the age of the leg is the
only signal that exists - see `mms-silent-drop-dish-textnow`.

## 2. Scope

Dashboard-only. No backend change, no schema change, no API change, no new
dependency. `delivery_recipients` already reaches the client intact on every
path (`useRelayThread.ts:66`, `useGroupThread.ts:188` via the shared
`buildRelayItems`, `buildTimelineFallback.ts:88`, `contactTimeline.ts:422`).

### 2.1 One renderer, five surfaces

There is exactly ONE bubble renderer - `MessageBubble` in
`dashboard/src/routes/contact/Timeline.tsx:535`. Neither conversation view has
its own. Five callers mount the shared `Timeline` and pass a roster, and all
five inherit this change:

| Surface | File | Roster prop | rosterKind |
| --- | --- | --- | --- |
| Relay group | `conversation/ConversationDetail.tsx:488` | `members` | default `relay` |
| Native group text | `conversation/GroupTextView.tsx:460` | `timelineRoster` | `group_text` |
| Placement thread | `placements/PlacementConversation.tsx:328` | `members` | default `relay` |
| Tour thread | `tours/TourConversation.tsx:475` | `members` | default `relay` |
| Contact page | `contact/ContactDetail` -> `Timeline` | none | n/a |

The contact page passes no roster and its 1:1 bubbles carry no
`delivery_recipients`, so it is unchanged in practice; it is listed because the
same component serves it and must not regress.

### 2.2 Out of scope, filed instead

- **Bubble reveal is not keyboard-reachable.** The bubble is a `div` with an
  `onClick` and no `role`, `tabIndex`, or `aria-expanded`
  (`Timeline.tsx:619-623`). That is a PRE-EXISTING gap - today's
  transport/number/time line already hides behind it. This design does not make
  it worse and deliberately does not fix it here, because the honest fix
  (promoting the bubble to a real disclosure control) collides with the
  interactive children already nested inside it (a Link at `:631`, a Retry
  button at `:687`), which is its own design problem. S6 mitigates the practical
  cost for screen-reader users; a new issue carries the rest.
- **A relay-observed 21610 keeps the raw code.** `twilio.ts:2386` writes
  `errorCode: '21610'` on a relay leg the carrier reports an opt-out for, while
  the group path translates the same event to `contact_opted_out`
  (`groupReceipts.ts:419`). Only the translated form is excluded from the
  denominator, so the relay case renders as a hard failure. Real inconsistency,
  pre-existing, not caused by this work. File it; do not fix it here.
- Any carrier-fallback behavior (auto-resend as a link to a Dish/TextNow line)
  belongs to `mms-silent-drop-dish-textnow`, not to this visibility work.

## 3. Locked decisions (human, 2026-08-24)

1. **The breakdown folds into the EXISTING bubble reveal.** Tapping the bubble
   reveals the transport/number/time line and the per-recipient list together.
   No second click target inside the bubble.
2. **Opted-out members appear in the list**, labelled as not sent, and stay OUT
   of the N/M denominator exactly as today.
3. The rollup escalates when a leg goes stale (from the approved investigation
   summary).

### 3.1 The tradeoff decision 1 accepts, and its mitigation

Folding into the bubble reveal means nothing on the chip advertises that a
who-got-it answer exists behind it. That is acceptable ONLY because S3 makes the
chip itself escalate: when a leg goes quiet the founder sees a red
`delivered 1/2 - 1 not confirmed` without clicking anything. The click answers
*who*; the chip already answered *whether*. If S3 were dropped, decision 1 would
have to be revisited.

## 4. Behavior

### S1 - Per-recipient list, revealed with the bubble

An outbound multi-party bubble renders a per-recipient list under the meta row.
It is present in the DOM whenever the rollup is present (same three gates as
`Timeline.tsx:600-603`: `outbound` AND map present AND parent status is not
`queued_pending`) and is shown only while the bubble is revealed, by the same
CSS mechanism the meta line already uses.

One row per entry in `delivery_recipients`, in ROSTER ORDER (the order members
appear in `relayRoster`), with any slot whose key matches no roster member last,
in map-key order. Each row carries:

- the member's display name (S2),
- their own delivery state chip (S4), using the same tone classes as the
  existing chips so the visual language does not fork,
- a timestamp when there is one: `deliveredAt` for a delivered leg, `sentAt` for
  a sent leg. Group-text legs have no `sentAt` at all (S5), so many rows show a
  state with no time. That is correct and must not be papered over with the
  message's own time, which would misrepresent a per-leg fact.
- a failure reason when the row's state is a failure, via the existing
  `deliveryReason`.

An empty-but-present map renders no list, matching the rollup's `null`. This is
a normal state: `twilio.ts:610` seeds `delivery_recipients: {}` on every relay
inbound source message, and the fan-out fills the slots later.

### S2 - Naming a recipient

Every row must carry a label - a blank row defeats the entire feature. The
existing `senderLabel` (`lib/memberAttribution.ts:60`) is NOT sufficient: for
`kind = 'relay'` it deliberately returns `undefined` for a nameless member
(invariant 6, `memberAttribution.ts:55-59`), which is right for an attribution
chip that may render nothing and wrong for a list row that must render
something.

Resolution order for a slot key:

1. Find the roster member the key belongs to. Match EITHER convention - the key
   is an opaque `contactId` on a relay leg and always `phone#<E164>` on a
   group-text leg (`messagesRepo.ts:156`, `groupMembers.ts:42`). The superset
   match `senderLabel` already performs (`memberAttribution.ts:75-77`) is the
   behavior to reuse; extract it rather than re-implement it.
2. Matched: label with the roster member's name, else their formatted number.
   That is exactly `groupMemberLabel` (`lib/groupThread.ts:60`), already the
   member-panel rule on both conversation views - reuse it, do not fork it.
3. No roster match (a member removed from the group after this message was
   sent - the roster is CURRENT membership, the map is historical): if the key
   is `phone#<E164>`, format that number. Otherwise the key is an opaque
   contactId we can no longer resolve, and the row reads as a former member
   without inventing a name.

Case 3 is not hypothetical: rosters change, and `ever_member_phones` on the
conversation exists precisely because past membership outlives current
membership.

### S3 - Staleness, per leg and in the rollup

A leg is STALE when its status is `sent` and its clock has been quiet for at
least `STALE_SENT_AFTER_MS`. Reuse the existing constant and the existing
`presentDeliveryStatus` staleness gate; do not introduce a second threshold.

The per-leg clock is the slot's own `sentAt` when it parses, else the message's
`at`. Rationale in S5.

The rollup's rules gain one branch and keep the rest. In priority order:

1. Any hard-failed leg -> danger. The label now names both problems when both
   exist, so a stale leg is never hidden behind a failure:
   `delivered N/M - K failed` when there are no stale legs, and
   `delivered N/M - K failed, J not confirmed` when there are.
2. Else any stale leg -> danger, `delivered N/M - J not confirmed`.
3. Else every leg delivered -> success, `Delivered M/M` (unchanged).
4. Else -> neutral, `delivered N/M` (unchanged).

Opted-out legs remain excluded from N, M, K and J, unchanged.

### S4 - Per-leg labels

Per-leg state reuses `presentDeliveryStatus` so a leg and a 1:1 message never
disagree about what a status means. One new label is needed, for the opted-out
row that decision 2 adds: it reads as not sent rather than as a failure,
consistent with `groupDelivery.ts`'s framing that Twilio never creates the leg.

The opted-out row is identified by `errorCode === 'contact_opted_out'` ALONE, on
either `failed` (relay, `relayFanOut.ts:456`) or `undelivered` (group,
`groupDelivery.ts:59`). This is the existing project-wide rule
(`deliveryStatus.ts:120-127`) and must not be tightened to require a status.

A reason renders on a row only when that row's presentation `isFailure`, mirroring
`Timeline.tsx:579`. This matters: an `errorCode` does NOT imply failure -
`relayFanOut.ts:527` writes `{ status: 'queued', errorCode: <transient code> }`
for a deferred retry, and printing a scary code next to a still-retrying leg
would be its own misread.

### S5 - Which clock, and why it differs by product

`sentAt` is written ONLY by the two relay send paths (`relayFanOut.ts:542`,
`relayAnnouncements.ts:266`) and holds the PROVIDER's timestamp string.
`deliveredAt` is written ONLY on the `delivered` transition
(`messagesRepo.ts:2786`) and holds OUR server clock. A native group-text leg
therefore never has `sentAt`: its seed is a bare `{ status: 'queued' }` and the
receipts path writes only status, errorCode, deliveredAt and sid.

Consequences the implementation must honor:

- A group-text leg's staleness can only be measured from the message's `at`.
  Falling back to `msg.at` is correct and is the only option.
- The two timestamps come from different clocks and must never be subtracted
  from one another or presented as a duration.
- `imported` rows carry no `delivery_recipients` at all (the importer writes
  none), so the imported-row staleness suppression at `Timeline.tsx:577` has no
  per-leg equivalent to break. Carry the same guard anyway - withhold the clock
  when the parent message is imported - so the rule stays true by construction
  rather than by luck.

### S6 - Accessible summary without a new control

The always-visible rollup chip gains an accessible label spelling out the
per-recipient summary in words, so the information is in the accessibility tree
without opening the disclosure and without adding the control S2.2 rules out.
Sighted users get the visual list; screen-reader users get the same facts from
the chip they already encounter.

## 5. Invariant sweep

The protected state is the per-recipient delivery truth. This design changes
where and how it is PRESENTED, so every reader/renderer of `delivery_recipients`
is enumerated here; the plan must task each one.

Readers (all in `dashboard/`):

1. `contact/Timeline.tsx:588` - the opted-out count feeding the note. Unchanged
   in rule, but now redundant with a list row. Keep it: the note is visible
   WITHOUT revealing the bubble; the list is not.
2. `contact/Timeline.tsx:600-603` - the rollup. Changed (S3).
3. `contact/Timeline.tsx:644` - the per-message chip's suppression, gated on the
   rollup being non-null. Must stay exactly as-is; the list must not become a
   third chip that fights the other two.
4. `contact/deliveryStatus.ts:119` - `presentRelayDelivery`. Changed (S3).

Writers are all app-side and are NOT touched by this work, but the design
depends on their exact output, so each was verified: `api.ts:1685` and `:1761`
(seeds), `twilio.ts:610` (empty seed) and `:2381` (relay DLR),
`relayFanOut.ts:456/513/520/527/539/575`, `relayAnnouncements.ts:240/263/281`,
`groupSend.ts:612`, `groupDelivery.ts:59`, `groupReceipts.ts:419`,
`messagesRepo.ts:2721/2744/2820`.

Non-readers confirmed unaffected: the inbox row collector, Today, broadcasts
(their own progress UI), and the group-send staleness alarm (server-side, its
own threshold, unrelated to the chip's 15 minutes).

## 6. Test strategy

### 6.1 The re-baseline this forces, and why it is correct

`dashboard/src/test/setup.ts` pins the clock to `2026-07-01T12:00:00Z`. The
relay fixtures in `Timeline.test.tsx:890-906` are dated `2026-06-08` and include
a leg at `status: 'sent'`. Under S3 that leg is three weeks quiet, so it becomes
stale and its rollup escalates from neutral `delivered 1/2` to a danger
`delivered 1/2 - 1 not confirmed`.

That is the new behavior working, not a regression. The affected assertions
(`Timeline.test.tsx` around :910, :932, :949, :962, :976, :991, :999, :1021, and
`GroupTextView.test.tsx:1017`) must be re-baselined DELIBERATELY, each with a
one-line note saying which rule moved it. A silent mass-update of expected
strings is the failure mode to avoid: it would hide a genuine break in the same
diff. Where a test's intent is to pin the NON-stale in-flight branch, the fixture
should be re-dated near the pinned clock rather than have its expectation
rewritten.

### 6.2 Unit

- `deliveryStatus.test.ts` - the pure layer, and where the real coverage
  belongs: the new rollup branches (failed only, stale only, both together,
  neither), the boundary at exactly `STALE_SENT_AFTER_MS`, opted-out exclusion
  from every counter, and the per-leg presenter including the opted-out label
  and the transient-code-without-failure case. Existing style is whole-object
  `toEqual` on `{label, tone, isFailure, reason?}`; keep it.
- `Timeline.test.tsx` - rendering: rows appear per member with the right names
  under both key conventions, roster-order, the unmatched-key fallbacks, and
  that the list is absent for `queued_pending` and for an empty map.
- `GroupTextView.test.tsx` - one group-text-keyed case. NOTE: that file still
  uses bare `vi.fn()` with `mockReset().mockResolvedValue()` re-arming in
  `beforeEach` and a `cleanup()`-before-`restoreAllMocks()` teardown order. New
  tests must re-arm every mock they touch, or adopt the `AnyAsyncMock` default
  form from `ConversationDetail.test.tsx:34-47`. This is the shape that caused
  `conversationdetail-members-mock-suite-flake`.
- `ConversationDetail.test.tsx` has ZERO delivery-chip coverage today. Adding
  one relay-arm case is cheap and closes a real hole.

**jsdom cannot prove the reveal.** `dashboard/vite.config.ts:99` runs with
`css: false`, so a `display:none` rule does not exist in the test environment
and `toBeVisible()` cannot see it. Unit tests may assert DOM presence and class
toggling ONLY. Any claim that the list is actually visible after a click is a
browser claim - see 6.3. A unit test asserting visibility here would be
vacuous, which is worse than absent.

### 6.3 E2E

No seed row in ANY profile carries a `delivery_recipients` map, so a mixed
delivered/stuck state cannot be observed from seed data. The two existing specs
that assert the chip (`group-text-reply-all.spec.ts:130`,
`group-text-stop.spec.ts:117`) only ever reach all-delivered or
delivered-plus-skipped.

The tool for a stuck leg already exists: `setDeliveryOutcome(request,
{ partyNumber, profile: { kind: 'stall' } })` (`e2e/fixtures/fakeTwilio.ts:258`),
documented at `selectors.md:101` and used by no group spec today. The e2e proves
what jsdom cannot: click the bubble, the per-recipient rows become visible, and
they name the right member against the right state.

Staleness needs a 15-minute-old leg, which a live send cannot produce inside a
test. Options for the plan to choose between, with a recommendation: seed a
purpose-built row rather than manipulate time - a lean-profile addition is
byte-stable-visible and must be weighed against the byte-stability rule, so if
it is taken it belongs in `full`, not `lean`. Proving staleness in the unit
layer (where `nowMs` is already injectable) and proving the LIST in the browser
is the cheaper split and the recommended one.

Add a `selectors.md` row: neither the delivery chip nor the bubble reveal is
documented there today, and both specs address the chip with a bare page-scoped
`getByText`.

## 7. Acceptance

1. On the 8/23 shape - two members, one delivered, one stuck at `sent` for over
   15 minutes - the bubble shows a danger `delivered 1/2 - 1 not confirmed`
   without any interaction, and revealing the bubble names Shamanic as delivered
   with a time and Wolf as not confirmed.
2. An opted-out member appears as a row saying they were not sent to, and the
   denominator is unchanged from today.
3. A fully delivered group still reads `Delivered M/M` in success tone, and a
   `queued_pending` hold still shows only its own queued chip with no list.
4. The four gates pass from the worktree: `npm run typecheck`, `npm test`,
   `npm run smoke`, `npm run e2e`.
5. All five mounting surfaces render the list correctly, verified in a browser,
   not inferred from the shared component.
