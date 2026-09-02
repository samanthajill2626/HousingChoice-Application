# Spec review R1-B (adversarial) - relay 30003 retry lineage

Spec under review: `docs/superpowers/specs/2026-09-02-relay-30003-retry-lineage-design.md`
Tree: `W:\tmp\relay-30003-retry-lineage` @ `484059cb` (base `bb54fdaa`, matches the
spec's stated base).

Every claim about existing behavior below cites a file:line I read in THIS
worktree. Anything I could not establish is marked UNVERIFIED.

---

## 1. [BLOCKING] The retry row's `direction` is never specified, and both choices break a stated guarantee

**What is wrong.** D1 says "A retry is a NEW source message row". D5 says "A retry
row inherits the original's sender key". D15 says the retry bubble reads
`delivered 1/1 on retry`. Nowhere does the spec state the retry row's
`direction`, `author`, `type` or message-level `delivery_status` - and the entire
display contract turns on `direction`.

**Evidence.**

- The rollup chip is gated on outbound: `dashboard/src/routes/contact/Timeline.tsx:934-940`
  (`outbound && msg.delivery_recipients && msg.delivery_status !== 'queued_pending'`),
  rendered at `:1052-1066`. `outbound` is `msg.direction === 'outbound'`
  (`Timeline.tsx:837`).
- Sender attribution is `resolveSenderLabel(msg.relay_sender_key, ...)`
  (`Timeline.tsx:973`), which renders a member's roster name for a member key.
- Every existing outbound relay source row carries `TEAM_SENDER_KEY` or
  `SYSTEM_SENDER_KEY` (`app/src/routes/api.ts:1726`, `:1818`;
  `app/src/services/relayAnnouncements.ts:239`). Every row carrying a MEMBER key
  is inbound (`app/src/routes/webhooks/twilio.ts:641`, `:646`;
  `app/src/routes/webhooks/voice.ts:949`, `:1024`).

**What it implies.** A member-originated original forces the builder to invent a
shape:

- `direction: 'inbound'` -> `deliveredSummary` is null, so the retry bubble shows
  no chip at all and D15's `delivered 1/1 on retry` cannot render.
- `direction: 'outbound'` with an inherited member `relay_sender_key` -> a shape
  that exists nowhere in the product today: an outbound bubble attributed to a
  member, on the outbound side of the thread, restating that member's own message.

The builder cannot proceed correctly without this decision, and the spec supplies
no way to derive it.

---

## 2. [BLOCKING] The display contract in Sec 5 does not exist for the dominant relay case

**What is wrong.** D15's four end states, D17's failed-count subtraction and
D18's ageing are all specified against "the original bubble"'s rollup chip. For a
MEMBER-originated relay message - the ordinary case, and the one D5's fence
explicitly admits - that chip does not render.

**Evidence.**

- The inbound relay source row is appended `direction: 'inbound'` with
  `deliveryRecipients: {}`: `app/src/routes/webhooks/twilio.ts:636-650`.
- The fan-out is enqueued against that row: `twilio.ts:744`.
- The chip: `Timeline.tsx:934-940` requires `outbound`. Its accessible-name
  recital `rollupName` (`Timeline.tsx:957-968`) is derived from
  `deliveredSummary !== null`, so it is absent too.
- Only the per-recipient rows survive on an inbound multi-party row:
  `Timeline.tsx:948-951` (`(outbound || msg.relay_sender_key !== undefined) && ...`),
  and they are behind a click-to-reveal (`Timeline.tsx:1092`).
- D5's fence is `relay_sender_key !== 'system'` (Sec 3 D5), and the only writer of
  `SYSTEM_SENDER_KEY` is `relayAnnouncements.ts:239`. Team and fan-out both pass -
  so the retry fires on inbound sources.

**What it implies.** Sec 1's premise ("The dashboard is truthful about the
failure ... the operator is told plainly that one person was missed") is true only
for team and announcement sends. D15 rows 1-4, D17's subtraction, and the
"1 retrying"/"on retry" copy have no render position on a member-originated relay
message. The e2e that the spec says is "the checklist"
(`e2e/tests/dashboard-next/relay-30003-no-retry-promise.spec.ts:134-161`) is a
TEAM send, so nothing in the repo has ever exercised the case the spec is silent
about. Either D5's fence must additionally exclude inbound sources (and the
feature then covers only team sends), or Sec 5 must specify what an inbound
source's bubble does - which is a change to the chip's outbound gate, a surface
Sec 2 does not list.

---

## 3. [HIGH] D21's "There is one relay render surface" is false - there are three

**What is wrong.** D21 states "There is one relay render surface ... The contract
lives solely in the conversation thread." D20 then requires sibling retry rows to
be "threaded down through `MessageBubble` and `StreamItem`" from "the call site"
(singular).

**Evidence.** Three hosts mount the shared `<Timeline>` over `useRelayThread`,
all with `relayRoster` and the default `rosterKind='relay'`:

- `dashboard/src/routes/conversation/ConversationDetail.tsx:178` (hook), `:480` (mount)
- `dashboard/src/routes/tours/TourConversation.tsx:420` (hook), `:467` (mount)
- `dashboard/src/routes/placements/PlacementConversation.tsx:280` (hook), `:320` (mount)

`TourConversation.tsx:467` passes a MILESTONE-MERGED `items` list rather than
`thread.items` (see its own note at `:463-465`), so the sibling set differs there.

D21's narrower claim - that the CONTACT pane never renders a relay bubble - is
correct (`app/src/routes/contactTimeline.ts:1232`;
`dashboard/src/routes/contact/useContactTimeline.ts:191-196`). The generalisation
from that to "one surface" is not.

**What it implies.** Sec 2's "In" list names none of `ConversationDetail.tsx`,
`TourConversation.tsx` or `PlacementConversation.tsx`. A build that threads the
retry rows through only `ConversationDetail` leaves the tour-detail and
placement-detail relay transcripts rendering the pre-change copy - two readers
that disagree with the new rule.

---

## 4. [HIGH] D2 cites the wrong condition: `attribute_not_exists(tsMsgId)` failing THROWS, it never returns `deduped: true`

**What is wrong.** D2: "`append` writes the row under
`attribute_not_exists(tsMsgId)` inside a transaction (`:2220`). A retry whose
provider SID is a deterministic function ... therefore claims by construction:
a duplicate callback, a duplicate queue delivery and two concurrent callbacks all
lose the create and return `deduped: true`."

**Evidence.** The citation is correct - `app/src/repos/messagesRepo.ts:2220` IS
the message row's own condition - but it does not support the claim attached to
it:

- `append` attributes a dedupe to CancellationReasons INDEX 1 ONLY, which is the
  `sid#<providerSid>` pointer: `messagesRepo.ts:2295-2306`, and the doc block at
  `:2296-2303` says so explicitly.
- A condition failure anywhere else - including the message row's own key at
  index 0 - is logged and RETHROWN: `messagesRepo.ts:2374-2388`
  ("Loud, and rethrown - never reported as a dedupe").
- `tsMsgId` is `buildTsMsgId(message.providerTs, message.providerSid)`
  (`messagesRepo.ts:2113`), so the SK collides only if BOTH halves are
  deterministic. Every other append site stamps a wall-clock `providerTs`
  (`api.ts:1802`, `relayAnnouncements.ts:214`).

**What it implies.** The claim mechanism the spec describes is not the one the
code implements. A builder who follows D2 literally and makes the SK deterministic
(deterministic `providerTs` as well as SID) still works, by accident, because
index 1 is checked first. A builder who makes the SK deterministic but the SID
NOT (e.g. a uuid suffix) gets a rethrown 500 on every duplicate callback. The
spec must name the sid pointer as the claim, not `:2220`.

---

## 5. [HIGH] "A duplicate queue delivery loses the create" is false by construction - the job performs no create

**What is wrong.** D2 lists three things the create-claim defeats: "a duplicate
callback, a duplicate queue delivery and two concurrent callbacks". Acceptance
intention 7 ("Other members receive no duplicate send, on every rung") and
intention 2 rest on it.

**Evidence.** The create happens in the WEBHOOK (D2, D6: the trigger is a
delivery-status callback). A duplicate QUEUE delivery re-runs the retry JOB, which
never performs the create - it sends. The two existing jobs that face the same
SQS at-least-once hazard both carry their own execution marker BEFORE any send:

- `app/src/jobs/relayFanOut.ts:732-744` (`putJobExecutionMarker(jobId, ...)`)
- `app/src/jobs/retrySend.ts:129-146` (same, with the "would TEXT THE HUMAN
  AGAIN" rationale spelled out)

The spec never mentions `putJobExecutionMarker`, a job-execution marker, or any
job-side idempotency at all.

**What it implies.** The only accidental protection is the terminal-slot skip
inside the extracted loop body (`relayFanOut.ts:1120-1121`, with `isTerminal`
counting `sent` at `:188-190`) - which D8 happens to include in its stated
extraction range but which the spec never identifies as the guard. The guarantee
is attributed to a mechanism that cannot deliver it, so the plan derived from this
spec has no reason to write the guard down.

---

## 6. [HIGH] D14's premise is false for the relay thread: the server route is a raw passthrough, so D7's destination E164 reaches the browser

**What is wrong.** D14: "The raw row's unknown top-level fields do NOT survive to
the client: every projector spreads a fixed field list (`contactTimeline.ts:406-464`,
`useRelayThread.ts:69-135`, `buildTimelineFallback.ts:64-104`)."

**Evidence.** All three cited projectors do spread fixed lists - verified at
`app/src/routes/contactTimeline.ts:406-465`,
`dashboard/src/routes/conversation/useRelayThread.ts:69-135`,
`dashboard/src/routes/contact/buildTimelineFallback.ts:63-104`. But the relay
thread is not fed by any of them on the server side. `GET /api/conversations/:id/messages`
returns stored rows AS-IS: `app/src/routes/api.ts:2148-2199`
(`res.json({ messages: page })` at `:2173` and `:2197`; the only mutation is a
`{ ...message, relay_external_caller_display_name }` spread at `:2188`).

D7 stores the destination E164 as a lineage field on the retry row.

**What it implies.** Every relay member's raw handset number is serialized to the
browser on every relay thread page load and every SSE-triggered refetch, whether
or not `useRelayThread`'s fixed list forwards it to the renderer. The spec's own
PII constraint is stated only as "a phone number must never enter a sort key"
(D2), which this satisfies while missing the wire. Either the destination must be
stored in a non-projected form (a digest, matching the SID's own construction) or
the route must strip it - and neither `api.ts` nor the stripping is in Sec 2's
scope.

---

## 7. [HIGH] D22 drops the 21610 opt-out carve-out and would alarm on the platform correctly honoring STOP

**What is wrong.** D22: "The severity call becomes attempt-aware INSTEAD of
code-aware. A relay leg logs at WARN while a retry is actually claimed ... and at
ERROR once the chain is terminal: cap exhausted, a gate refused, or no retry was
claimed at all."

**Evidence.** The current predicate has TWO carve-outs, not one:

- `app/src/routes/webhooks/twilio.ts:301` `TRANSIENT_RETRYING_DELIVERY_CODES = {30003}`
- `twilio.ts:302` `EXPECTED_NONFAILURE_DELIVERY_CODES = {21610}`
- `twilio.ts:310-314` `isTerminalDeliveryFailure` returns false for BOTH, and the
  doc block at `:294-300` names 21610 as "the platform working, not a failure".
- The relay branch calls it: `twilio.ts:2509-2510`.

A 21610 on a relay leg never claims a retry (D6 gates on 30003), so under a purely
attempt-aware predicate it becomes ERROR.

**What it implies.** Every provider-side opt-out on a relay leg starts feeding
`hc-<env>-error-logs` and the Recent Errors panel. That is a strictly larger alarm
increase than the one D22 asks the founder to sign off on, and it is the exact
class of alarm the existing comment was written to prevent. The relay predicate
must keep the 21610 carve-out; "instead of code-aware" is the wrong framing.

---

## 8. [HIGH] D22's terminal-ERROR guarantee is undeliverable for three of the four terminal cases this design creates

**What is wrong.** D22 promises ERROR "once the chain is terminal: cap exhausted,
a gate refused, or no retry was claimed at all", and justifies the alarm increase
with "after this change a terminal relay failure is a real dead end for a real
tenant and nothing else will surface it".

**Evidence.** The severity decision lives in the delivery-callback handler
(`twilio.ts:2500-2511`), which only runs when a callback arrives. Three of the
design's own terminal outcomes produce no further callback:

- A gate refusal (D9) happens inside the retry JOB before any send, so no DLR is
  ever generated.
- An enqueue failure (D12) means the job never runs at all.
- The stranded claim (Sec 9, "A crash between the claim and the enqueue strands a
  retry") likewise sends nothing.

In all three the last callback processed was the one that CLAIMED a retry - which
under D22 logged WARN. The chain then ends terminally with no ERROR anywhere.

**What it implies.** The one decision the spec flags for founder sign-off buys the
alarm for the case that was already loud (cap exhausted, which the 1:1 path
already ERRORs at `twilio.ts:2719-2722`) and misses the three failure modes this
branch introduces. Either the job must emit the terminal ERROR itself - unstated,
and `jobs/` severity is not in Sec 2's severity scope - or the guarantee must be
narrowed.

---

## 9. [HIGH] D18 cannot be expressed by the presenter it targets: there is one clock per BUBBLE, and the state renders on the OTHER bubble

**What is wrong.** D18: "A retry that never reaches `sent` falls to not-confirmed,
aged from the retry row's own creation time." D15 row 4 puts that state on the
ORIGINAL bubble (`delivered 3/4 - 1 not confirmed`), and D16 gives a non-delivered
retry row no bubble of its own.

**Evidence.**

- `bubbleClocks` returns ONE `messageAtMs` per bubble, from that bubble's own
  `msg.at`: `dashboard/src/routes/contact/Timeline.tsx:734-742`, called at `:922`.
- `presentRelayDelivery` takes a flat `RelayDeliverySlot[]` plus a single
  `messageAtMs`/`nowMs` pair: `dashboard/src/routes/contact/deliveryStatus.ts:394-398`,
  and the staleness count at `:415`.
- The ticker's run condition uses the same single clock:
  `Timeline.tsx:798-812`, `:804`.
- The `queued`-with-no-`sentAt` silence D18 wants to override is at
  `deliveryStatus.ts:217-218` (`case 'queued': return legClock;`).

**What it implies.** To age the retry's `queued` slot from the RETRY row's clock
while presenting it on the ORIGINAL's chip, the presenter needs a PER-SLOT clock,
which its current shape has no room for. `RelayDeliveryOptions`
(`deliveryStatus.ts:351-358`) is an options bag for the CALL, not per slot.
`hasTickableLeg` would additionally arm or disarm the staleness interval against
the wrong clock - and that predicate has four documented shipped
non-terminations behind it (`Timeline.tsx:788-812` and the run-condition doc at
`:1801-1815`). The spec asserts a behavior whose mechanism it has not sized.

---

## 10. [MEDIUM] D12's and D9's close codes have no reader, and are not added to the copy map that would render them

**What is wrong.** D12: "An enqueue failure closes the retry leg terminally, with
a close code distinct from cap-exhausted. Reusing one code would tell an operator
retries ran when none did." D9: "A refusal writes a terminal state on the retry
leg with a close code that says which gate refused."

**Evidence.**

- D16 states a retry row renders ONLY when its leg delivered. A refused or
  enqueue-failed retry leg therefore has no bubble, no chip and no per-recipient
  row.
- D15 row 3 puts both cases on the ORIGINAL bubble showing the ORIGINAL's own
  string, `delivered 3/4 - 1 failed - Phone unreachable (error 30003)`, and calls
  it "today's, unchanged".
- The copy map that turns an app-invented code into operator text is
  `INTERNAL_CODE_REASONS` (`dashboard/src/routes/contact/deliveryStatus.ts:688-692`),
  holding exactly `contact_opted_out`, `transient_cap`, `enqueue_failed`. Its own
  doc block at `:671-681` carries D12's rationale verbatim for the EXISTING pair.
- An unmapped code falls to `Delivery failed (error <code>)`
  (`deliveryStatus.ts:731-733`) - printing an app-invented string as if it were a
  carrier error number, which the map's doc at `:654-657` names as "the defect
  this map exists to fix (A16)".

**What it implies.** D12's stated purpose (telling an operator retries did not
run) is not achieved by the mechanism: the operator sees the same string either
way. And if the build introduces new internal codes for D9's four gates without
adding them to `INTERNAL_CODE_REASONS`, any surface that ever does render them
(the accessible-name recital, a future reader) prints `Delivery failed (error
retry_gate_number_changed)`. The spec names neither the codes nor the map.

---

## 11. [MEDIUM] D15's strings contradict the presenter's existing copy conventions

**What is wrong.** D15 row 2 gives the original bubble `delivered 4/4 - 1 on retry`
and row 4 `delivered 3/4 - 1 not confirmed`, while asserting row 3's string is
"today's, unchanged".

**Evidence.** `presentRelayDelivery` (`deliveryStatus.ts:428-456`) produces:

- `delivered N/M - K failed[, J not confirmed]` (`:433-436`) - row 3 matches.
- `delivered N/M - J not confirmed` (`:448`) - reachable only via `isStaleLeg`.
- `Delivered N/N` with CAPITAL D and `tone: 'success'` when `delivered === total`
  (`:453-454`).
- `delivered N/M`, neutral (`:456`).

**What it implies.** Row 2's `delivered 4/4` is neither the existing all-delivered
label nor an existing branch. The spec does not say whether an original whose
failed leg was rescued by a retry keeps the green success cue, and the e2e in
Sec 7 asserts `delivered 2/2 - 1 on retry`, which today's function cannot emit in
any branch. The builder must invent both the string and the tone.

---

## 12. [MEDIUM] D10 stores the composed, prefixed body on the retry row, inverting the in-repo persisted-body rule

**What is wrong.** D10: "The composed body - sender prefix included - is stored on
the retry row and sent as stored, never recomposed."

**Evidence.** The relay product deliberately separates what is PERSISTED from
what a LEG carries. `relayAnnouncements.ts:122-143` states the rule directly:
"`body` is what is PERSISTED, previewed, and inherited by `touchLastActivity`'s
inbox preview; this selector overrides the copy on the outbound LEG only." The
fan-out follows the same shape: the source row stores the raw body and
`composeRelayBody` prefixes only the wire copy (`relayFanOut.ts:192-196`, applied
at `:998`).

**What it implies.** A retry bubble stores `"<Sender>: <text>"` while the original
bubble one position above stores `"<text>"` - two visibly different strings for
one logical message, in a product whose stated rule is one row / one bubble / one
body. D13's bump then writes the prefixed string into the inbox preview via
`touchLastActivity`. D10's goal (never re-prefix on a renamed sender) is
achievable by storing the leg body separately from the row body; the spec picks
the option that changes what the thread and the inbox show, without saying so.

---

## 13. [MEDIUM] Sec 1's stated reason `retrySend` is unusable is factually wrong

**What is wrong.** Sec 1: "`retrySend` is also unusable directly: it re-sends
through `sendMessage` to the conversation's `participant_phone`, which on a relay
group is the pool number, not a member."

**Evidence.** `sendMessage` REFUSES a relay group before reading
`participant_phone` at all: `app/src/services/sendMessage.ts:297`
(`if (conversation.type === 'relay_group') throw new RelaySendNotSupportedError(...)`),
with the guard's own rationale at `:156-164` and `:291-296`. `retrySend` catches
`SendRefusedError` and stops the chain (`app/src/jobs/retrySend.ts:209-217`).
Separately, `relayAnnouncements.ts:80-86` records that a `relay_group` carries no
`participant_phone` at all.

**What it implies.** The conclusion ("unusable directly") survives, but the
premise a builder would carry forward - that reusing `retrySend` would text the
pool number - is false. It would refuse, silently and by design. Any test written
to prove "the retry does not text the pool number" would be testing a hazard that
does not exist.

---

## 14. [MEDIUM] D13 lumps four distinct side effects into one undivided "bump", and places it where D15 row 1 cannot be observed

**What is wrong.** D13 enumerates four things `append` does not do - "last
activity, SSE, unread counts or push" - then places "the bump" after a successful
send without saying which of the four it comprises.

**Evidence.**

- The relay branch's own SSE emit is gated on `transitioned || transportUpdated`
  and fires inside the failure callback: `twilio.ts:2512-2521`.
- `relayFanOut.ts` emits nothing and calls no `touchLastActivity` (verified: no
  `events.emit`, no `appEvents`, no `touchLastActivity` in the file).
- The two cited bump sites do different things:
  `api.ts:1845-1868` does `touchLastActivity` + audit + `message.persisted`;
  `relayAnnouncements.ts:247-262` does `touchLastActivity` + `conversation.updated`
  + `message.persisted`.
- Push is a separate service threaded through the webhook
  (`twilio.ts:288`, `:775-779`).

**What it implies.** Two concrete consequences the spec does not decide:

1. If the claim's append emits no `message.persisted`, and the claim is written
   AFTER the failure callback's emit at `:2515`, the operator sees `1 failed` for
   the whole first backoff window before the chip flips to `1 retrying`. D15 row 1
   ("Retry claimed, chain live") is then unobservable for 60 seconds. The spec
   never orders the claim against that emit.
2. Nothing in D13 forbids a push notification per automatic retry, which would
   ring every subscribed staff device for machine-initiated traffic.

---

## 15. [MEDIUM] Sec 7's "lane-local backoff override, gated exactly as the other dev seams are" has no in-repo precedent to copy

**What is wrong.** Sec 7 E2E: "The 60-second first rung needs a lane-local backoff
override, gated exactly as the other dev seams are and structurally absent in
deployed environments."

**Evidence.**

- The dev seams AGENTS.md names are HTTP routes mounted conditionally in
  `app/src/routes/dev.ts` (`POST /auth/dev-login`, `POST /__dev/reseed`,
  `GET /__dev/ping`).
- The backoff is consumed inside a WORKER job, from a bare module-level pure
  function with no injection point and no dep: `retrySend.ts:39-42`
  (`retryBackoffMs`), `relayFanOut.ts:91-100` (`fanOutBackoffMs`).
- No environment-variable backoff override exists anywhere
  (`grep BACKOFF|backoffMs` over `app/src/lib/config.ts` and `app/src/jobs/jobs.ts`
  returns nothing).

**What it implies.** "Gated exactly as the other dev seams are" is not achievable
for a worker-side scheduling constant through the dev-router mechanism, and an
env-var override is config, not structural absence. The spec asserts a
verification path whose seam does not exist and whose shape it has not chosen.
This is the difference between the e2e in Sec 7 being writable and not.

---

## 16. [MEDIUM] D8's extraction carries a transient arm whose contract the retry job cannot honor

**What is wrong.** D8 extracts "the loop body at `relayFanOut.ts:1118-1269`" as
the shared per-leg send unit. D6 scopes out only "a synchronous 30003 at send
time", which "takes the existing fan-out paths".

**Evidence.** The loop body's error handling has four arms, and one of them is a
deferral to a mechanism the retry job does not have:

- `relayFanOut.ts:1190-1207` `SendRefusedError` -> mark failed, continue.
- `:1209-1226` 30007 -> mark failed, never retry.
- `:1227-1246` a code in `TRANSIENT_CODES` (`{429, 30022}`, `:103`) -> mark the
  slot `queued`, push to `transientRemaining`, "deferring recipient to
  continuation". The continuation is `claimFanoutPass` + a re-enqueue of
  `RELAY_FANOUT_JOB` (`:1097-1114`, `:1292-1310`) - both outside the extracted
  range.
- `:1247` anything else -> rethrow.

Note also that 30003 is NOT in `TRANSIENT_CODES`, so a synchronous 30003 hits the
rethrow at `:1247`; D6's "takes the existing fan-out paths" describes a job
failure, not a path.

**What it implies.** A retry leg that hits a 429/30022 lands `queued` with a
transient code and no continuation to pick it up. D18 then renders it
"not confirmed" and the chain ends silently, having claimed no further rung. The
spec never says what the retry job does with the extracted unit's transient
outcome, and the acceptance list has no case for it.

---

## 17. [MEDIUM] The claim's relationship to the existing `transitioned` result is unspecified

**What is wrong.** D6 defines the trigger as "a delivery-status callback resolved
through the relay pointer, reporting a failure, carrying error code 30003, passing
D5, with rungs remaining". It does not say whether the claim is gated on the slot
transition actually happening.

**Evidence.** `handleRelayRecipientStatus` already computes it:
`twilio.ts:2466-2472` (`transitioned = await messages.updateRecipientDeliveryStatus(...)`),
and uses it to gate the SSE emit (`:2512`) and the placement escalation (`:2522`).
`ALLOWED_PRIOR` (`messagesRepo.ts:129-138`) permits `failed`/`undelivered` only
from `queued`/`sent` - so a leg already terminal (e.g. a 30007 marked failed
synchronously at `relayFanOut.ts:1209-1216`, or an opted-out leg at `:1127-1130`)
transitions nothing when a late 30003 callback arrives.

**What it implies.** Ungated, the design claims a retry for a leg the fan-out
already closed - and the extracted send unit's own terminal-slot skip would not
save it, because the retry writes into the RETRY row's fresh slot, not the
original's. Gated, D2's "the gate is the attempt record, never a slot transition"
(its answer to M5 constraint 2) is quietly reintroduced on a different axis. The
spec must pick one and say so; M5's constraint 2 is exactly the trap here.

---

## 18. [LOW] D7 stores four lineage fields, D14 projects three, and the spec never says which is withheld

**What is wrong.** D7: "The retry row carries four lineage fields: the root
message id, the member key of the leg being retried, the destination E164, and the
attempt number." D14: "Three lineage fields are added to `TimelineMessage` and to
the relay projector."

**Evidence.** Spec Sec 3 D7 vs Sec 4 D14. No reconciliation appears anywhere.

**What it implies.** The likely intent is that the destination E164 is withheld
for PII reasons - which is also finding 6's subject - but the builder has to guess,
and D19's orphan-bubble copy plus D20's join do not by themselves determine which
three. State it.

---

## 19. [LOW] D5's fence tests a sentinel that shares a namespace with member keys, and a dev seam can write it

**What is wrong.** D5: "`SYSTEM_SENDER_KEY` has exactly one writer
(`relayAnnouncements.ts:239`) ... so the test cleanly separates fan-out and team
legs from announcement legs."

**Evidence.** The constant has one writer (grep over `app`, `dashboard`, `e2e`,
`scripts` returns `relayAnnouncements.ts:47` and `:239` only). But the VALUE is a
bare string in the same namespace `relayMemberKey` draws from - a contactId, else
`phone#<E164>` (`messagesRepo.ts:189-193`) - and a second writer accepts an
arbitrary `relaySenderKey` off a request body:
`app/src/routes/dev.ts:1008` (append branch) and `:1038` (raw Put branch).

**What it implies.** Low practical risk (a contactId of literally `system` is
implausible, and `dev.ts` is hermetic-only), but the fence's stated proof is about
the CONSTANT while its runtime test is on the VALUE. Worth a sentence in the plan
so the test asserts the value, not the import.

---

## 20. [LOW] The claim identity assumes `To` is a bare E164, and nothing on this path validates it

**What is wrong.** D3 keys the ladder on the callback's `To`, and D2 makes the
provider SID a digest of the root `tsMsgId` and that destination. D9 then compares
it to the roster's phone for the changed-number gate.

**Evidence.** `params['To']` is passed into `normalizeTransportEvidence` at
`twilio.ts:2457`, but the normalizer's `to` is read ONLY on the inbound branch
(`app/src/adapters/twilioMessageTransport.ts:145-155`, including its `isE164`
check). The relay branch always passes `direction: 'outbound'` (`twilio.ts:2453`),
so nothing on this path has ever validated `To`. The spec's "and is discarded
today" is therefore correct.

**What it implies.** Both the digest and the changed-number comparison must
normalise/validate `To` themselves before use; a non-E164 `To` would silently mint
a different digest (a fresh ladder) or fail the gate. Sec 9 already flags a MISSING
`To`; a malformed one is the same class and is not covered.

---

## Claims I tested and found SOUND

Recorded so a later round does not re-buy them.

- `twilio.ts:2711` is exactly the `case '30003':` arm. Verified.
- `twilio.ts:2457` - `params['To']` is in scope at the relay branch. Verified.
- `messagesRepo.ts:204-209` - `splitTsMsgId` splits on the FIRST `#`. Verified.
- `messagesRepo.ts:3543-3565` - `putRelaySidPointer` writes no kind field. Verified.
- `api.ts:1803` (`team-${randomUUID()}`) and `relayAnnouncements.ts:228`
  (`system-${randomUUID()}`) - synthetic SIDs are routine. Verified.
- `relayAnnouncements.ts:168-171` - announcements are never retried. Verified.
- D5's "four callers" of `sendRelayAnnouncement`: `relayFanOut.ts:852` (intro),
  `relayFanOut.ts:916` (member added), `relayGroups.ts:635` (close),
  `tourReminders.ts:1646` (group rung). Verified - four call sites, three
  importers.
- D4's "60s, 120s, 240s, cap 3" matches `retrySend.ts:37` and `:39-42`. Verified.
- D8's four objections to reusing `relay.fanOut`: `:757` (closed-group return),
  `:771-779` (five-row window), `:992-998` (`composeRelayBody`), `:1019`
  (sender-key filter). All four citations correct.
- D12's `closeRelay` is a nested closure at `relayFanOut.ts:1060`. Verified.
- D11's presign sites: `relayFanOut.ts:1160-1167`, `retrySend.ts:148-176`. Verified.
- D13's "the fan-out makes none of them" - `relayFanOut.ts` contains no
  `events.emit`, no `appEvents`, no `touchLastActivity`. Verified.
- D16's reasoning about the collapse rule: `Timeline.tsx:1788-1800` hides the
  PREDECESSOR (`supersededIds.has(i.tsMsgId)`), so reusing `retry_of` would indeed
  hide the original. Verified.
- D19's paging premise: `threadPaging.ts:30` `THREAD_PAGE_SIZE = 50`, newest-first.
  Verified.
- D21's contact-pane exclusion: `contactTimeline.ts:1232` and
  `useContactTimeline.ts:191-196`. Verified (the narrow claim; see finding 3 for
  the broad one).
- Sec 9's fake-Twilio claim: `fake-twilio/src/engine/engine.ts:500-501` skips the
  callback for index 0 (`queued`). Verified.
- Sec 7's one-shot arming: consistent with
  `relay-30003-no-retry-promise.spec.ts:34-37` and `:119-121`.
- The referenced issues all exist: `docs/issues/relay-30003-retry-lineage.md`
  (with a "Design knowledge from M5" section defining constraints 1-5 at `:122-203`),
  `relay-30003-classified-transient-retrying.md`,
  `relay-member-key-collapses-two-phones-one-contact.md`,
  `quiet-hours-ungated-automated-paths.md`.
- `groupSendStaleness` does NOT sweep relay rows: it is driven by the `dueRow`
  written transactionally with a group_text append (`messagesRepo.ts:2265-2279`),
  and relay appends pass no `dueRow`. A retry row's single-slot map cannot enter
  that sweep.

## Citation errors (all LOW on their own; listed together)

- Sec 1 cites `TRANSIENT_RETRYING_DELIVERY_CODES` at `twilio.ts:286`. It is at
  `:301`; `:286-288` is `pushService?: PushService;`.
- Sec 1 cites `:2590` for "a path that requires a persisted message row". The
  requirement is the `if (!message) { ... return; }` at `:2574-2589`; `:2590` is
  the `mergeContext` immediately after it.
- D5 says `sendRelayAnnouncement` "is imported by `jobs/tourReminders.ts:1646`".
  The import is at `tourReminders.ts:69`; `:1646` is the call.
- D2 cites `messagesRepo.ts:195-198` for `buildTsMsgId`; the function is `:196-198`
  (`:195` is the closing docblock line). Harmless.
