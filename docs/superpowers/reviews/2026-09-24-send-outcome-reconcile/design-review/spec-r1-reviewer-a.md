# Spec review r1 - reviewer A (adversarial)

Spec: `docs/superpowers/specs/2026-09-24-send-outcome-reconcile-design.md`
(commit 66f2a363 on `feat/send-outcome-reconcile`, cut from main@685f2ede).
Scope of this review: conflicts with existing behavior, unenumerated surfaces,
contradictions. Every code claim cites a file:line I read in this worktree;
anything I could not verify is marked UNVERIFIED.

The research files beside this review
(`research/marker-sweep-findings.md`, `research/presentation-findings.md`)
were read. Two of the findings below (F2, F10) were ALREADY RAISED there
(presentation findings 8 and 12) and are not addressed in the spec.

---

## F1 [BLOCKING] D11's safety argument is false: the reconcile job's enqueues are neither conditional nor idempotent, so removing the marker reintroduces the double text

**What is wrong.** D11 drops the run-once marker on the grounds that "every
write it makes is conditional or idempotent (D15), so a genuine SQS
redelivery re-runs it safely". But the job does two things that are not
D15 writes:

- the `never_sent` verdict ENQUEUES a re-drive continuation (D16 table:
  "enqueue a `broadcast.send` continuation for that one recipient", "enqueue a
  `relay.fanOut` continuation", "enqueue the same `relay.retryLeg` rung");
- each non-final check ENQUEUES the next check (D13: "scheduled as the job's
  own continuations (fresh `jobId`, the check number in the payload)").

Neither is guarded by any state transition in the spec. The D16 `never_sent`
row writes nothing to the slot before enqueueing.

**Evidence.**
- The jobs queue is a STANDARD queue (no FIFO): `infra/modules/jobs/main.tf:34-42`;
  the consumer documents at-least-once duplicates (`app/src/adapters/sqsJobConsumer.ts:13-15`).
- The existing sends guard exactly this with the marker because a duplicate
  "would TEXT THE HUMAN AGAIN" (`app/src/jobs/retrySend.ts:122-128`,
  `app/src/jobs/relayRetryLeg.ts:346-349`).
- A re-drive continuation has a fresh jobId, so its own marker does not
  suppress a second one (`app/src/jobs/jobs.ts:188`).
- Neither fan-out claims a recipient before sending: the broadcast slot is
  written `sent` only AFTER `sendMessage` returns
  (`app/src/jobs/broadcastFanOut.ts:417-434`), the relay slot only after the
  adapter returns (`app/src/jobs/relayFanOut.ts:1385-1462`); the pre-send
  `setVersionedAggregationState(..., 'attempted', ['attempted'])` accepts a
  second `attempted` (`relayFanOut.ts:1380-1382`, `:1583-1587`). The per-pass
  claim `claimFanoutPass` hands two concurrent passes two different pass
  numbers (`app/src/repos/broadcastsRepo.ts:650-690`), it does not exclude one.

**What it implies.** One duplicate delivery of the final check (or a throw
after the enqueue, which D11 explicitly turns into a redelivery) produces two
re-drive passes for one recipient. Both read the slot non-terminal, both send:
a double text, the exact outcome Sec 1's invariant forbids and the marker
existed to prevent. A duplicate of an intermediate check forks the check chain
and multiplies the re-drives. The spec must make the `never_sent` and
next-check steps conditional on a slot state transition (e.g. a check number
or verdict token advanced with a condition, enqueue only by the winner) and
must stop claiming D11 is safe "because D15".

---

## F2 [BLOCKING] A post-send write failure in the broadcast loop is classified `unknown`, and D13's "drop SIDs we already hold" then turns a delivered, recorded text into `never_sent` and re-sends it

**What is wrong.** The broadcast try block wraps more than the send. After
`sendMessage` returns successfully it writes the recipient slot `sent`, bumps
stats and acquires a token, all inside the same `try`
(`app/src/jobs/broadcastFanOut.ts:413-446`, catch at `:490`). A DynamoDB
failure on `recordRecipient` or `bumpStats` there reaches the catch as an
untyped error. D2 says an error the classifier cannot place is `unknown`; D7
then writes the slot `queued`/`send_unconfirmed` and enqueues a reconcile. The
reconcile lists the provider, finds the message, and D13 DROPS it because its
SID is already held: `sendMessage` appended the row and its `sid#` pointer
before returning (`app/src/services/sendMessage.ts:398-428`). No survivor for
the whole window -> `never_sent` -> re-drive -> second text.

Worse, if `recordRecipient('sent')` succeeded and `bumpStats` failed, D7's
write is a blind overwrite of a `sent` slot back to `queued`
(`setRecipient` with no `allowedPriorStatuses`, `broadcastsRepo.ts:602-640`),
which is what lets the re-drive pass get past the terminal skip
(`broadcastFanOut.ts:362`).

**Evidence.** Above, plus `research/presentation-findings.md` finding 8,
which flagged exactly this ("a terminal write added to that catch could
clobber a correct `sent` slot") and is not addressed anywhere in the spec.

**What it implies.** D13's drop rule is wrong as stated: a held SID that
belongs to THIS owner is proof the send happened (`found`), not evidence it did
not. Only a SID held by a DIFFERENT owner may be dropped. And the spec must
say that only the typed send errors of D3 are classified; a failure after
`sendMessage` returned is "sent, slot not recorded" and must never re-drive.

---

## F3 [HIGH] The reconcile chain is bounded by MAX_HOP_COUNT = 10 in a file the spec fences, and the spec never mentions it

**What is wrong.** Every enqueue from inside a job increments the envelope's
`hopCount`, and `enqueue` THROWS once it exceeds 10
(`app/src/jobs/jobs.ts:37`, `:166-171`; `dispatchJob` re-hydrates `hopCount`
into the context, `:303-310`). The spec's design is a chain: a fan-out pass
(broadcast passes are hops 1-3: `broadcastFanOut.ts:598-617`), then a
reconcile check per backoff step across "about five minutes" (D13), then a
re-drive continuation, which may itself hit `unknown` again and start another
chain. A 5s/10s/20s/40s/80s/160s schedule is six checks; from a third
broadcast pass that is hops 4-9, the re-drive is hop 10, and anything that
re-drive enqueues is hop 11 and throws.

`jobs.ts` is out of scope (Sec 2 "Any change to ... `jobs.ts`").

**Evidence.** Above. The dashboard's own copy already knows this close exists
("The same close also fires from the hop-count ... guards in jobs.ts",
`dashboard/src/routes/contact/deliveryStatus.ts:903-905`).

**What it implies.** If the hop limit lands on the reconcile's own enqueue (a
next check or the re-drive), it throws deterministically. Under D11 that is a
retry that fails identically five times -> DLQ, with the slot left `queued`/
`send_unconfirmed` for ever. Since D8 hides that slot from every close, the
broadcast is never finalized. The spec has to state the hop budget as a
constraint on the check schedule, or make the checks not chain (a single
delayed check per window, or `runAt` fan-out from the first job, which still
costs one hop each).

---

## F4 [HIGH] The known-SID path does no lookup, so D15's "the adoption's status read replaces them" is not delivered, and a broadcast adoption has no body to write

**What is wrong.** D13: "Known SID: no lookup. The verdict is `found` with that
SID." D15: "Receipts that arrived BEFORE the adoption were dropped by the
fenced webhook; the adoption's status read replaces them, which is why it reads
the status rather than assuming `sent`." For the known-SID case there IS no
status read. D17 adds only `listMessages`; there is no fetch-by-SID port.

The known-SID case is exactly `SendAcceptedNotRecordedError`, i.e. the
production incident: three status callbacks arrived within two seconds and
were dropped (`docs/issues/accepted-send-lost-when-append-fails.md`, "Confirmed
in production"). The webhook waits once (`STATUS_UNKNOWN_SID_RETRY_DELAY_MS`,
~2.5s per `app/src/routes/webhooks/twilio.ts:3600`) and then drops at ERROR
(`twilio.ts:3212-3227`).

Separately, D12 forbids the body in the payload and D3's
`SendAcceptedNotRecordedError` carries only SID, timestamp and status. The
broadcast `found` row must "append the message row ... (the write `sendMessage`
would have made)", which includes the body (`sendMessage.ts:405`). With no
lookup there is no body from the provider either.

**What it implies.** A known-SID adoption records the create-time status
(`accepted`/`queued` -> `queued` via `mapTwilioStatus`,
`app/src/adapters/messaging.ts:558-573`) for ever. The 1:1 bubble never ages
out of "Sending..." (1:1 staleness is `sent`-only per the comment at
`deliveryStatus.ts:614-616`). A 30003 on that message is never seen, so no
retry fires. A broadcast adoption writes a bodiless bubble, or re-renders the
template from the current contact and unit, which may differ from what was
sent. The spec needs a fetch-by-SID port (or "known SID still lists") and a
decision on where the body comes from.

---

## F5 [HIGH] D12's digest-only recipient/sender cannot drive D17's lookup; the spec never says where the raw numbers come from, and the owner reference already leaks the phone D12 forbids

**What is wrong.** D12 has the payload carry "the recipient and sender as the
digest form the relay retry claim already uses". That digest is a one-way
`sha256(rootTsMsgId|E164)` truncated to 16 hex characters
(`app/src/lib/relayRetryClaim.ts:25-30`). D17's
`listMessages({ to, from, createdAfter })` needs the raw E.164 numbers. The
spec never says the job re-resolves them from the owner (contact, roster
member, conversation pool number, business number). It also never says what
verdict applies when the re-resolved number no longer matches the digest (a
phone edit, or a member number change: the very case `retry_number_changed`
exists for, `relayRetryLeg.ts:534-546`). "The digest form the relay retry claim
uses" is also undefined for a broadcast or a 1:1 retry, which have no
`rootTsMsgId`.

Meanwhile the "owner reference" D12 requires already contains the phone in the
clear for contact-less recipients: broadcast contact keys and relay member
keys fall back to `phone#<E164>` (`broadcastsRepo.ts:163-166`,
`app/src/repos/messagesRepo.ts:193-197`). The relay retry job deliberately
carries neither for this reason (`relayRetryLeg.ts:68-78`).

**What it implies.** A builder cannot implement the lookup from the spec
alone. The natural patch, re-reading the contact's CURRENT phone, looks up the
wrong number after a phone edit, finds nothing, reaches `never_sent`, and
re-drives to the new number. The spec must state the re-resolution source, the
mismatch verdict (it should be `unresolved`, not `never_sent`), and how
phone-keyed owners are carried without breaking D12.

---

## F6 [HIGH] D8 contradicts the `never_sent` re-drive, and the spec never says what the re-drive writes to the slot first

**What is wrong.** D8: "the continuation payload never lists them", and the
closes skip them. D16 `never_sent`: "enqueue a `broadcast.send` continuation for
that one recipient", "enqueue a `relay.fanOut` continuation for that one
member". A re-drive's payload lists exactly one `send_unconfirmed` slot. The
spec never says whether the verdict handler first rewrites the slot (clears
the code) or leaves it.

- If it is left `send_unconfirmed`: the re-drive pass runs with the
  broadcast-level claim. When the ladder is spent it takes close B,
  `closeBroadcast(pending, 'transient_cap')` (`broadcastFanOut.ts:345-349`) or
  `closeRelay(...)` (`relayFanOut.ts:1131-1133`). D8 makes that close skip the
  slot, so nothing closes it and (D8 again) nothing finalizes the broadcast.
- If it is rewritten: that write is the missing claim from F1, and the spec
  should say so.

**What it implies.** The spec needs one explicit decision: the `never_sent`
verdict conditionally transitions the slot out of `send_unconfirmed` (and that
transition is the idempotency token for F1) BEFORE the enqueue. As written, D8
and D16 cannot both hold.

---

## F7 [HIGH] Finalize can be LOST, not just doubled; the spec guards the wrong race

**What is wrong.** D8: "a pass that finds one still open does not finalize".
D16: "After any verdict write on a broadcast, if no recipient slot remains
non-terminal the handler finalizes". Each writer skips finalize when it sees
the OTHER's slot open. Section 5 asks the plan to prove finalize is "safe to
reach from two writers" (a double finalize). It says nothing about zero.

The zero case is realistic. `unknown` on a transport timeout returns about 30s
after the attempt start (twilio-node DEFAULT_TIMEOUT 30000, `node_modules/twilio/lib/base/RequestClient.js:47`).
The reconcile's `runAt` is attempt + 5s, already past, so it runs at once. It
runs in PARALLEL with the pass: the worker dispatches up to 10 messages
concurrently (`sqsJobConsumer.ts:111`, `:126`). If the timed-out recipient was
the last in the loop, the pass goes straight to its finalize decision while
the reconcile adopts. `getById` is eventually consistent (the repo says so at
`broadcastsRepo.ts:676-680`). An in-memory "I sent one to reconcile" flag in
the pass, which is the obvious implementation of "finds one still open", never
sees the verdict at all.

`finalize` itself is unconditional: `flipStatus` has only
`attribute_exists` (`broadcastsRepo.ts:446-472`), and it appends a
`broadcast_sent` audit row each time (`broadcastFanOut.ts:683-689`).

**What it implies.** The anchor issue's own symptom (broadcast left `sending`
for ever) is reachable by this spec's mechanism. The spec must require that
each writer decide on a CONSISTENT read taken AFTER its own last write, and
that finalize be a conditional `sending -> sent|failed` transition, so that at
least one writer finalizes and at most one does.

---

## F8 [HIGH] The Sec 1 invariant is not delivered: per-recipient failures outside the provider-call try still throw out of the loop under the marker, and Sec 9 misdescribes them

**What is wrong.** Sec 1: "Every recipient of a fan-out reaches a terminal
state." The mechanism only classifies failures of the provider send. Every
other per-recipient await sits outside a try and still throws out of the loop.
The marker still suppresses the redelivery, which is the anchor defect:

- broadcast, EVERY recipient: `resolveContact` (`broadcastFanOut.ts:366`),
  `createOrGetByParticipantPhone` (`:410`), and the slot/stat writes in the
  skip and failure arms (`:368-372`, `:382-386`, `:398-402`, `:507-511`).
- relay, EVERY leg (`sendOneRelayLeg`, called with no try at
  `relayFanOut.ts:1139-1155`): `isMemberSuppressed` (`:1324`), `tokenBucket`
  / presign / `setVersionedAggregationState` (`:1360-1382`), and the post-send
  `persistRelayRecipientResult` + `putRelaySidPointer` (`:1450-1467`). That
  last pair is the relay's own "accepted, not recorded" case.

Sec 9 files this as "a database failure before the first send in either
fan-out (outside the per-recipient try) still strands the pass". That is not
the shape: these are per-recipient, before AND after the send, on every
iteration. `research/presentation-findings.md` finding 8 listed these lines.

**What it implies.** One DynamoDB throttle mid-fan-out still strands every
later recipient silently, which is the anchor issue's headline, and the anchor
would be marked closed. Either the invariant is narrowed to "every recipient
whose provider send fails" and the follow-up issue re-described accurately,
or the loop bodies get a per-recipient catch with a defined outcome. For the
post-send relay pair that outcome must be "sent, not recorded", never a
re-send.

---

## F9 [HIGH] `retrySend` is claimed as an adopter, but its `rejected` / `retryable` / `unknown` arms are undefined and D5-D7 do not map onto it

**What is wrong.** Sec 4 applies D5-D10 to `retrySend` "with the variant in
D13". D13 has no retrySend variant; the variant is the D16 table row. D16
covers only verdicts. retrySend has:

- no recipient slot. D5 ("mark the recipient failed") and D7 ("the pass writes
  the slot `queued` with code `send_unconfirmed`") have nothing to write. The
  only rows are the original, already `undelivered`, and a new row that does
  not exist yet (`retrySend.ts:112-120`, `:200-229`);
- no continuation or `transientRemaining` set, so D6 has nothing to defer to.
  Its attempt counter rides the payload (`retrySend.ts:44-50`) and is read back
  from the new message by the next 30003 (`retrySend.ts:221-229`);
- today every non-refusal error rethrows under the marker (`retrySend.ts:218`).

**What it implies.** A builder must invent the retrySend behavior for 20429 /
ECONNREFUSED / SendNotAttemptedError: re-enqueue at the same attempt? spend a
rung? end the chain? Section 8 has no test for any of it (test 8 covers only
verdicts; test 3 omits retrySend). The spec also leaves undefined what staff
see during the window. Those are product decisions the spec must make before
retrySend can be called an adopter.

---

## F10 [MEDIUM] The relay-retry join projects an unresolved rung onto the root leg as a hard failure, the one presentation D20/D21 exist to prevent

**What is wrong.** D20/D21 change `presentLegDelivery` and
`presentRelayDelivery` by CODE on a `failed` slot. A relay retry RUNG that
ends `unresolved` is written `failed`/`send_unconfirmed` on the RETRY row. The
dashboard never renders that row directly. `relayRetryJoin` projects it onto
the ROOT leg: a terminal rung takes step 4, which keeps the root's own
`status` (`failed` or `undelivered` after a 30003), overlays the rung's close
code, and sets `retryState: 'terminal'`
(`dashboard/src/routes/contact/relayRetryJoin.ts:405-415`). In the rollup, a
hard-failed leg with state `terminal` is counted in K and the chip is
`isFailure: true` (`deliveryStatus.ts:459-487`, `:524-538`). On the row,
`terminal` "falls THROUGH" to the ordinary failure path
(`deliveryStatus.ts:713-714`, `:769`). D21's filter ("`failed` slots carrying
`send_unconfirmed`") also misses an `undelivered` root.

A rung pending reconcile (`queued` + `sentAt`) reads `retrying` for up to
15 minutes (`relayRetryJoin.ts:225-235`), which is fine. The UNRESOLVED end is
the problem. `research/presentation-findings.md` finding 12 raised this; the
spec does not mention the join.

**What it implies.** The bubble reads "N failed" with `isFailure: true`, and
the bubble's Retry button is keyed on `isFailure` (`Timeline.tsx:1341`), on a
leg whose retry may have gone out. UNVERIFIED whether the relay thread wires
`onRetry`. The join is a fourth render input the spec's "three render
positions ... change together" leaves out.

---

## F11 [MEDIUM] Adoption bypasses every side effect the webhook keys on a failed status; "the adoption's status read replaces them" replaces only the status

**What is wrong.** D15 adopts an already-failed message "as failed with its
error code". The receipts it replaces had side effects that only the status
webhook performs, on a transition:

- 1:1/broadcast 30003 -> `enqueueSendRetry` (`twilio.ts:3350-3370`);
- relay 30003 -> the relay retry-ladder claim (`twilio.ts:2662-2745`);
- 30005/30006 -> `sms_unreachable` flag (`twilio.ts:3380-3452`);
- 21610 -> suppression confirm (`twilio.ts:3470-3495`);
- any failure -> `flagPlacementAttention` (`twilio.ts:3337-3340`);
- the `delivery_failed` marker line and severity (`twilio.ts:3276-3289`).

**What it implies.** An adopted 30003 is never retried. An adopted 30005/30006
never flags the contact, so the next broadcast texts the dead number again. An
adopted 21610 never confirms suppression. The spec must either route adoption
of a failed status through the same side-effect code, or list which effects
are deliberately dropped.

---

## F12 [MEDIUM] The broadcast adopt omits what a successful broadcast send does besides the append

**What is wrong.** D16's broadcast `found` is "append the message row ... then
the slot ... bump stats". A successful send in the fan-out also records the
`listing_sent` milestone (`broadcastFanOut.ts:453-467`) and the listing-send
row (`:475-489`). Inside `sendMessage` it also touches the inbox
(`sendMessage.ts:432`), writes the `message_sent` audit row (`:433-437`) and
emits `message.persisted` / `conversation.updated` (`:442-448`). The pass
emits `broadcast.updated` after every stat bump (`broadcastFanOut.ts:438-442`).
None of these appear in D16, nor does any emit for the `unresolved` write or
the relay verdict writes. The relay retry job's own history shows a close with
no emit left a false state on screen for minutes
(`relayRetryLeg.ts:404-438`, "self-QA finding P1").

**What it implies.** An adopted recipient is absent from "Sent to tenants" /
"Properties sent" and the tenant timeline, the thread's inbox preview and
ordering are stale, and the results page does not tick until polling. The spec
should enumerate these as part of "the write `sendMessage` would have made"
(or explicitly drop them).

---

## F13 [MEDIUM] A `never_sent` re-drive spends the same pass counter as the transient ladder, so after an outage it is capped on arrival

**What is wrong.** D16 re-drives "under the existing pass cap". The broadcast
cap is ONE durable counter per broadcast (`claimFanoutPass`,
`broadcastsRepo.ts:650-690`, cap 3 per `broadcastFanOut.ts:80`). The relay cap
is one counter per source message (`relayFanOut.ts:1119-1123`). The transient
ladder spends it at 5s/10s/20s. A `never_sent` verdict arrives about five
minutes later. D9's outage brake, the exact scenario it is designed for,
defers everyone else to that ladder, which is spent within about 35 seconds.
The re-drive then claims `capped` and takes close B (`broadcastFanOut.ts:345-349`).

**What it implies.** The re-drive either closes the recipient `transient_cap`
("repeated temporary errors") though it was never retried, or, under D8's
close-skip, strands it (F6). Sec 8's e2e ("ends with that recipient sent by the
continuation") passes only on a broadcast with a clean ladder. The re-drive
needs its own budget or a documented reason why sharing is correct.

---

## F14 [MEDIUM] A relay `never_sent` re-drive silently no-ops if the group closed, the member left, or the source moved, and the slot stays `queued` for ever

**What is wrong.** The relay fan-out handler returns early, with no slot write,
when the conversation is not `open`, has no pool number, or the source is not
found (`relayFanOut.ts:761-792`). It also filters a member no longer on the
roster out of `recipients` entirely (`relayFanOut.ts:1040-1045`). The versioned
preflight only excludes non-roster slots that are still `planned`
(`relayFanOut.ts:1517-1534`), and a `send_unconfirmed` slot is `attempted`. A
five-minute reconcile window makes a close or removal in between realistic.

**What it implies.** The `send_unconfirmed` slot is never made terminal. D8
keeps every close off it, and after 15 minutes the dashboard shows "Queued -
not confirmed" for ever (`deliveryStatus.ts:238-240`, `:622-626`). That breaks
Sec 1's first clause. The verdict handler must re-check these gates itself and
write a terminal code (the retry job's `retry_group_closed` /
`retry_member_removed` pattern, `relayRetryLeg.ts:491-531`), not delegate to a
job that returns silently.

---

## F15 [MEDIUM] The body-hash match is unverified against the body Twilio stores; a mismatch reads as `never_sent` and re-sends

**What is wrong.** D13 keeps only listed messages "whose body matches the
hash". Sec 11 guards only against rendering and composition drift on OUR side.
Nothing verifies that Twilio's stored `body` equals the string we sent.
Advanced Opt-Out is ON for the messaging service
(`app/src/lib/smsCompliance.ts:260-262`). UNVERIFIED: whether Smart Encoding or
link shortening is enabled, and whether either rewrites the stored `body`
(e.g. a curly apostrophe from an iPhone relayed through `composeRelayBody`).
The spike (`research/spike-twilio-idempotency-output.txt`) compared only a
24-character ASCII `bodyPrefix`.

**What it implies.** A mismatch has only one outcome under D13: no survivor ->
`never_sent` -> re-drive -> a double text, for every relayed message containing
a rewritten character. Either spike the body round-trip with non-GSM
characters, or make "an unheld message in the window from that sender to that
recipient whose body does NOT match" yield `unresolved`, not `never_sent`.

---

## F16 [MEDIUM] D11 and D13 disagree about what a provider throw inside a check does

**What is wrong.** D13: "Provider unreachable for the whole window (every
check threw): `unresolved`". That requires a check to CATCH a `listMessages`
failure and schedule the next check. D11: "a throw inside it is a real retry,
and five failures reach the DLQ and page". With a 120s visibility timeout
(`infra/modules/jobs/main.tf:36`) and five receives, one throwing check is
held about ten minutes and then dead-lettered, leaving the slot `queued`/
`send_unconfirmed` (D8 hides it from every close). The spec never says which
failures are caught (provider) and which are thrown (verdict writes). In the
hermetic/local topology a throw is not retried at all: the in-process adapter
swallows it (`app/src/adapters/scheduler.ts:193-203`). The D11 path is
therefore untestable in e2e, and Sec 8 has no unit test for it.

**What it implies.** One Twilio blip during a check can DLQ the chain instead of
reaching `unresolved`, and the DLQ alarm then pages for a condition the design
meant to resolve itself. The spec should state the catch boundary explicitly.

---

## F17 [MEDIUM] `accepted-send-lost-when-append-fails` cannot be "closed for adopted callers"

**What is wrong.** The spec header marks the issue "closes for adopted
callers". The issue's only production sighting is `call.missedAutoText`
(issue body; `app/src/jobs/missedCallAutoText.ts:235-264`). That caller is
Stage 2 and explicitly not edited (Sec 2, Sec 9). The relay legs are adopted,
but they call the adapter directly; their "accepted, not recorded" failure is
the post-send `persistRelayRecipientResult` / `putRelaySidPointer`
(`relayFanOut.ts:1450-1467`), which gets no typed error and still throws out
of the loop (F8). D3 covers only `sendMessage`.

**What it implies.** Closing the issue would retire the record of the path
that actually lost a production message. Leave it open (or partially resolved)
with the unadopted paths named, and include the relay post-send case in D3's
scope or in the follow-up list.

---

## F18 [MEDIUM] D1's classifier rule is not implementable by the mechanism D1 names, and Sec 11 contradicts it

**What is wrong.** D1's table classifies by HTTP class: "any Twilio 4xx with a
code other than 20429" is `rejected`, "any 5xx" is `unknown`. D1's mechanism:
"The classifier reads `code` then `status`, exactly as `errorCodeOf` does
today". `errorCodeOf` returns the code and IGNORES `status` whenever a code is
present (`broadcastFanOut.ts:163-172`). A twilio-node `RestException` sets both
(`node_modules/twilio/lib/base/RestException.js:9-15`), so a 400/21211 yields
"21211" with the 4xx-ness discarded. A classifier fed that value can only
decide by a code list. Sec 11 then says "Every code added to `rejected` needs
Twilio's documentation". That is a closed allowlist, which contradicts "any
4xx".

**What it implies.** Two builders produce two different classifiers. One
(status-class) rejects every 4xx. The other (allowlist) turns every unlisted
4xx into `unknown` and a five-minute reconcile. The spec must pick one and
state that `code` and `status` are read separately.

---

## F19 [MEDIUM] retrySend's verdict rows contradict the spec's own invariant and reasoning

**What is wrong.** D16's 1:1 row on `never_sent`: "ERROR and end the chain -
... a second automated attempt after an ambiguous one is not worth a double
text". A `never_sent` verdict means the platform has RESOLVED the ambiguity:
nothing was sent. Re-sending cannot double-text, so the stated reason does not
apply. On `unresolved` (and `never_sent`) the original stays `undelivered` with
the copy "Phone unreachable - will retry" (`deliveryStatus.ts:778`) and a live
Retry button (`presentDeliveryStatus` marks `undelivered` as `isFailure: true`,
`deliveryStatus.ts:55`; button at `Timeline.tsx:1341`). That asks staff to
guess, which Sec 1 says the platform never does. It also promises a retry that
will not happen.

**What it implies.** Either re-drive on `never_sent` (as the other owners do),
or state the product reason. Either way, the `unresolved` 1:1 case needs a
presentation that does not offer Retry on a message that may have gone out.

---

## F20 [MEDIUM] D20's copy points staff at a conversation that by construction holds no record, and D22's "with the D20 reason" cannot render under D20's `isFailure: false`

**What is wrong.** An `unresolved` verdict means no SID was found or held, so
no message row exists. For a broadcast, the tenant's 1:1 thread has no
bubble. For a relay leg, the thread shows only the source message. "Check the
conversation before resending" gives staff nothing to check. Separately, the
broadcast badge appends a reason only when `isFailure` is true
(`dashboard/src/routes/broadcasts/DeliveryBadge.tsx:31`).
`presentRecipientStatus` takes no error code at all
(`dashboard/src/routes/broadcasts/broadcastFormat.ts:94-110`). The results row
decides "failed" and the retry hint from `status === 'failed'` alone
(`BroadcastResults.tsx:48`, `:63-66`).

**What it implies.** The copy should say what the platform actually knows and
what a person can do, for example that the tenant's phone is the only record.
The spec should state that the reason renders despite `isFailure: false`,
since the existing components suppress it.

---

## F21 [LOW] D4 as worded would fire `send_throttled` on network faults

D4: the marker fires "on the `retryable` provider codes". D1's `retryable`
includes ENOTFOUND / ECONNREFUSED / EAI_AGAIN. The `SendThrottled` alarm's
description says any occurrence means a token-bucket / A2P-tier breach
(`infra/modules/observability/main.tf:223-236`), and infra is out of scope
(Sec 10). Name the throttle set explicitly (429, 20429, 30022).

## F22 [LOW] A send-time 21610 is recorded as a generic failure

D1 cites 21610 as a send-time rejection. D5 preserves the 30007 and
30005/30006 extras only. The webhook treats a 21610 as a provider-side opt-out
and confirms suppression on the contact (`twilio.ts:3470-3495`). A send-time
21610 does not, so later broadcasts re-attempt and re-fail it. Decide whether
21610 keeps parity.

## F23 [LOW] "D15 makes that harmless" is true for data, not for paging

Every ambiguous-but-sent message (and every `SendAcceptedNotRecordedError`)
still produces one webhook ERROR per receipt before adoption
(`twilio.ts:3212-3227`). Those lines feed ErrorLogs (level >= 50,
`observability/main.tf:50-60`). In the production incident they tripped the
burst alarm (issue body). The spec should say the alarm noise remains.

## F24 [LOW] On versioned relay rows the adoption cannot set the send time D15 names

`applyRecipientSendResult` writes `sentAt` only if absent
(`messagesRepo.ts:3419-3423`). D7 writes the attempt start first, so D15's
"the provider's creation time as the send time" is silently dropped. A
re-drive's real send time is dropped too, which anchors the 15-minute
staleness clock to the FIRST ambiguous attempt.

## F25 [LOW] Loose claims and broken cross-references

- D11: "the only path in the app where 'throw to retry' is true" is false.
  Five handlers carry no marker (`groupRail`, `mediaMirror`, `relayNumberReady`,
  `relayWarm`, `voiceTranscript`), and the sweep lists some as "a throw
  genuinely redelivers". The sentence is slated for a docblock.
- Sec 4 "with the variant in D13" should be D16. Sec 2's "API types those read
  (Sec 6)" should be Sec 7.
- Sec 8 test 3 applies "recipient 3 of 5" to `relay.retryLeg`, a
  single-recipient job (`relayRetryLeg.ts:74-78`).
- The header says review history and rejected alternatives are in
  `design-review/`. That directory was empty when this review started, so the
  spec does not stand alone on the alternatives it rejects.
- D3 "Callers that catch nothing new behave exactly as today; this branch
  changes no HTTP route": the manual-send route now returns 201 instead of 500
  when a post-append step fails (`app/src/routes/api.ts:1428-1459`). That is
  probably right, but it is a behavior change.
- D20: "the seconds while the reconcile runs" understates a window of up to
  about five minutes.

## F26 [LOW] Unenumerated readers, seeds and fields for the new stats bucket and D7

- `BroadcastStats` readers not named: `app/src/lib/events.ts:149` (the SSE
  payload type), `StatChips.tsx:26-35`, whose documented invariant is that the
  buckets sum to Recipients and which gains a bucket, and the seeds
  `app/src/lib/seed/matrix.ts:1225-1247` and
  `app/src/lib/seed/performance.ts:998-1007`. No seed exercises the new state.
- D7 writes "the attempt start as its `sentAt`", but `BroadcastRecipient` has
  no `sentAt` field (`broadcastsRepo.ts:118-137`).
- The `drop_before_create` e2e must wait out the full ~5-minute window before
  `never_sent`. The spec names no lane-only override, and this repo's precedent
  shows such an override needs a topology guard
  (`relayRetryLeg.ts:162-196`).
