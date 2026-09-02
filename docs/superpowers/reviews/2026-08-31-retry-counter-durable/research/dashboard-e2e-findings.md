# Research findings - dashboard delivery-reason presenters + relay 30003 e2e

Subsystem: `dashboard/src/routes/contact/deliveryStatus.ts`,
`dashboard/src/routes/contact/Timeline.tsx`,
`dashboard/src/routes/broadcasts/DeliveryBadge.tsx`, and the e2e seam for the
relay 30003 chip test (plan slices 5a, 5b, and the e2e half of slice 7).

Read-only pass over the live tree at HEAD `8c8b7100`. **This file records ONLY
what the tree holds that the spec or plan got wrong or omitted.** Byte-exact
quotation, the verified six-site table, test skeletons and the e2e arming
sequence are the separate reference artifact at
`.superpowers/sdd/research/dashboard-e2e-reference.md` (gitignored, one file one
kind).

**All six of the plan's `deliveryReason` anchors are EXACT** against this tree -
`deliveryStatus.ts:416`, `Timeline.tsx:582 / :849 / :1045 / :1390`,
`DeliveryBadge.tsx:31` - and they are the COMPLETE set. `presentLegDelivery`'s
signature is at `deliveryStatus.ts:500-505` as stated. Two anchors given in the
dispatch drifted: the `contact_opted_out` interception is at
`deliveryStatus.ts:520-531` (not ~:505-516) and the invariant comment is at
`Timeline.tsx:1037-1042` (not ~:1035-1042). D19 is independently confirmed from
the call site: `app/src/routes/webhooks/twilio.ts:2433-2437` returns on the
relay-pointer branch before the 30003 retry branch at `:2546-2570`.

---

## F1 - `rosterKind`'s operative default is `Timeline.tsx:1519`, not `:796`, and THREE production callers depend on it

Plan slice 5a: "`rosterKind` **DEFAULTS to `'relay'`** (~Timeline.tsx:796), so
the group-text exclusion holds only because one site opts out - pin it
explicitly."

The pin is right; the mechanism named is wrong, and the caller count is wrong.

- `Timeline.tsx:2083` passes `rosterKind={rosterKind}` to every `StreamItem`
  UNCONDITIONALLY. `StreamItem` forwards it under a spread guard at
  `Timeline.tsx:1481` that can therefore never be false, so `MessageBubble`'s
  own default at `Timeline.tsx:796` is DEAD in production. The default that
  actually decides the product for every bubble is the `Timeline` component's
  destructuring default at `Timeline.tsx:1519`.
- Exactly one production caller opts out - `GroupTextView.tsx:461`. **THREE
  callers rely on the default and the plan names none of them:**
  `ConversationDetail.tsx:480-498` (the relay conversation view, `relayRoster`
  at `:488`, no `rosterKind`), `TourConversation.tsx:475`, and
  `PlacementConversation.tsx:328`. The last two are the relay-group tabs on the
  tour and placement hubs; they inherit the 5a override implicitly and are not
  in the spec's Sec 2 scope list or the plan's file list.

Consequence for the build: a group-text pin written against `:796` (e.g. by
rendering `MessageBubble` directly) proves nothing about production. Pin it the
way `Timeline.test.tsx:1314-1346` already does - through `<Timeline>`, relay by
omission versus an explicit `rosterKind: 'group_text'`.

## F2 - 5a does not state the precedence between the new relay map and `MMS_ERROR_CODE_REASONS`

`deliveryStatus.ts:635-637` resolves the mapped reason as a single `??` chain:
the media map when `opts.media === true`, else `ERROR_CODE_REASONS`. A relay
override has to be inserted into that chain, and the plan says only "a
relay-scoped map consulted the way `media` already selects
`MMS_ERROR_CODE_REASONS`" - which describes the mechanism, not the ORDER.

Today the order is unobservable: the media map holds only 30005/30006
(`:581-584`) and the relay map would hold only 30003, so the sets are disjoint.
That is exactly why the order must be written down now. If the relay map is
consulted FIRST and a later change adds 30005 or 30006 to it, it silently
inverts the prod-2026-08-24 MMS hedge that `deliveryStatus.ts:552-583` and
`app/src/routes/webhooks/twilio.ts` were both changed to preserve, on the
surface (`Timeline.tsx:1045`) whose own comment at `:1037-1042` calls that
contradiction the thing it exists to prevent.

Ask: pin `media` first, relay second, base last, and add a relay-MMS-30003 case
so the interaction is covered rather than merely disjoint.

## F3 - 5b's positions are under-counted, and one of slice 7's own follow-ups would add another

Plan 5b's test line reads "both internal codes render as prose in all three
positions with no tail".

`transient_cap` / `enqueue_failed` are written into recipient SLOTS
(`closeRelay` -> `markRecipient`, `closeBroadcast` -> `recordRecipient`), so
they surface at FOUR sites, not three: the relay rollup
(`deliveryStatus.ts:416`), the accessible-name recital (`Timeline.tsx:582`), the
per-recipient row (`Timeline.tsx:1045`), and the broadcast badge
(`DeliveryBadge.tsx:31`). The plan names the badge separately in 5b's prose, so
this is a counting slip in the test line rather than a missing requirement - but
a builder writing "three" will write three.

The sharper half: slice 7 files a follow-up asking "whether `closeRelay` should
also drive the hub message's own `delivery_status` to terminal". **If that
follow-up is ever taken, the code reaches a FIFTH position** -
`Timeline.tsx:849`, the message-level chip - which the six-site table marks
"none". Worth recording in that follow-up's own text so the next mission does
not ship a raw token at `:849`.

## F4 - `Timeline.tsx:849` is safe by a DATA fact in a fenced file, not because it is "the 1:1 bubble"

The plan's table labels `Timeline.tsx:849` "1:1 bubble" and changes nothing
there. The site is not 1:1-only: it lives inside `MessageBubble` and runs on
every outbound bubble including multi-party ones, feeding the message-level chip
at `:988` and the branch-0 accessible name at `:933-943`.

It cannot show a relay 30003 today for two independent reasons, both external to
this site: a relay source message's own `error_code` is never written from a leg
(the relay path writes slots only), and the aggregate that WOULD propagate a
leg's code up to the message row -
`app/src/services/groupDelivery.ts:113`, which copies the worst leg's
`errorCode` onto the message-level rollup - is called only from
`groupReceipts.ts:348` and `groupSend.ts:617`, i.e. NATIVE GROUP TEXT. On a
group text D20 deliberately keeps "will retry", and the chip is suppressed
anyway while a rollup renders (`Timeline.tsx:978`).

So the table row is correct, but "none" hides that its correctness rests on
group-delivery behavior in files this branch does not edit. Pin it with a test
(a relay bubble whose slot carries 30003 leaves the message-level chip alone)
rather than leaving it as a table assertion.

## F5 - the plan omits `e2e/support/selectors.md`, which is the documented contract for the strings 5a and 5b change

`e2e/support/selectors.md:49` enumerates the per-recipient row state strings as
the harness's single source: "`Failed`/`Undelivered` (with the reason and raw
code appended)", plus the note that a mixed state is armed with
`setDeliveryOutcome` because "no seed profile carries a `delivery_recipients`
map".

Slice 5a changes what a relay 30003 row reads and 5b introduces two new codes
that can appear in that position. `selectors.md` appears in neither the spec's
Sec 2 scope list nor the plan's slice-5 or slice-7 closure list. Every other
copy change in this repo that altered a documented row string updated it in the
same change.

## F6 - slice 7's e2e names no spec, and neither candidate is free

Plan slice 7: "E2E: a relay leg that failed 30003 shows no retry promise. Arm
with `setDeliveryOutcome` (fake-twilio), not seed data."

The arming works - `setDeliveryOutcome` is keyed on the DESTINATION number and
consumed once (`fake-twilio/src/engine/engine.ts:167-169` and `:458-459`), so a
relay fan-out leg from the pool number is armable exactly like a 1:1 send, and
`profile: { kind: 'fail', failState: 'undelivered', errorCode: '30003' }`
produces queued -> sent -> undelivered(30003) with the ErrorCode on both the
stored message and the status callback (`fake-twilio/src/engine/delivery.ts:18-20`,
`engine.ts:474-500`). But no spec renders a RELAY leg's per-recipient delivery
today, and the two candidates each carry a cost the plan does not weigh:

- `e2e/tests/dashboard-next/relay-group-view.spec.ts` has the only OPEN relay
  group whose transcript starts EMPTY (its own comment, `:120-121`), so arming
  cannot be contaminated by a create-time intro fan-out. Cost: it reseeds
  `?profile=full` per test (`:36-40`, `:57-59`) - the demo world, which AGENTS.md
  fences from lean assumptions - and restores lean in `afterAll` (`:63-66`).
- `createGroupOpen` (`e2e/fixtures/relayConnect.ts:162-186`) gives a lean-lane
  group, but its create sends an intro to every member, so the arming must wait
  for that intro to SETTLE first or it is consumed by the wrong message. The
  settle pattern is `relay-open-stop.spec.ts:141-145`.

Also note the existing per-recipient e2e,
`e2e/tests/dashboard-next/group-text-per-recipient-delivery.spec.ts:25-29`,
justifies choosing native group text because it "is the only one where a stalled
leg is armable end to end". That claim is about a STALL (whose `stallAt` the
fixture does not expose), not about a FAIL, so it is not evidence against a
relay 30003 spec - but a builder reading it will think it is.

## F7 - the e2e bullet does not mention the disclosure, which is the shape that passes vacuously

D21 requires all three relay positions to change together, and the three have
DIFFERENT visibility:

- the rollup chip renders always (`Timeline.tsx:991-1005`);
- the accessible name is computed unconditionally, revealed or not
  (`Timeline.tsx:913-923`);
- **the per-recipient row list is CONDITIONALLY RENDERED on
  `showRecipients && revealed` (`Timeline.tsx:1028`), where `revealed` is
  bubble-local `useState(false)` (`:814`) toggled by a click on the bubble body
  (`:954-957`) - a bare `div` with no role, name or test id.**

An absence assertion on the row written without the click passes on a completely
broken build. `selectors.md:48-49` says so in bold, and
`group-text-per-recipient-delivery.spec.ts:134-138` encodes the guard
(`toHaveCount(0)` before the reveal). The plan's one-line e2e bullet mentions
none of it.

Second-order: the assertion that actually proves 5a is a NEGATIVE
(`not.toContainText('will retry')`) at all three positions. A test that only
asserts the new copy is present at one position leaves the D21 contradiction
reachable.

## F8 - a relay 30003 is still classified "transient-retrying" in the log taxonomy, which the chip fix now contradicts; `twilio.ts` is fenced, so it must be FILED

`app/src/routes/webhooks/twilio.ts:286` puts `30003` in
`TRANSIENT_RETRYING_DELIVERY_CODES`, and the relay-leg failure marker at
`:2377-2386` uses that set to log a failed relay leg at WARN rather than ERROR -
explicitly on the grounds that it is "transient-retrying".

D19 establishes that no relay retry exists and none is added. After 5a the chip
stops promising a retry while the server still classifies the same leg as
retrying, and - the operational half - keeps it OUT of the error-logs alarm and
the Recent Errors panel on that basis. The severity call may still be the right
one (a relay leg that fails 30003 is not obviously alarm-worthy), but the
JUSTIFICATION recorded in the code is now false for the relay path.

`routes/webhooks/twilio.ts` is fenced in its ENTIRETY (spec Sec 2), so this is
file-not-fix. It is not in the spec Sec 8 post-merge obligation list and it is
not one of the sweep exceptions named in advance in Sec 9; it should join the
obligations, or ride the `relay-30003-retry-lineage` update that slice 7 already
owes.

## F9 - NIL: `fanout_attempt` needs no dashboard type change (confirmed, not assumed)

Recorded because the plan asks the question. `dashboard/src/api/types.ts:1651-1657`
(`RelayRecipientDelivery`) is untouched by construction - D2/D3 put the counter
at the TOP LEVEL of the app's item types, never in a recipient slot. The
dashboard's `Message` / `TimelineMessage` are hand-mirrored SUBSETS (see the
sync-by-hand note at `:1640-1641`), and TypeScript's excess-property check fires
on object literals, not on a value parsed from a response and asserted to the
type - so an extra wire property is invisible to `npm run typecheck`. `grep
fanout_attempt dashboard/src` returns nothing. No dashboard field is needed, and
adding one would put an app-internal ladder counter on a staff-facing DTO with
no consumer.
