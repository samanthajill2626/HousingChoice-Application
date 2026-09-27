# Plan research - send sites: findings

Researcher: read-only pass for the Stage 1 plan, 2026-09-26.
Worktree `W:\tmp\send-outcome-reconcile`, branch `feat/send-outcome-reconcile`,
HEAD a9f411f3 (main merged: RSW + share-skip-fix Branch A). Spec revision 7.
Area: the send sites the plan restructures - `jobs/broadcastFanOut.ts`,
`jobs/relayFanOut.ts`, `jobs/relayRetryLeg.ts`, `lib/relayRetryGates.ts`,
`services/sendMessage.ts`, `services/sendRefusalPreview.ts`,
`lib/tokenBucket.ts`, `jobs/jobs.ts`, `repos/fanoutClaim.ts`, and their tests.

Findings only. Byte-exact signatures, insertion points, unions, log keys and
test seams are in the gitignored reference
`.superpowers/sdd/plan-send-sites-reference.md`. All paths below are relative
to `app/src/` unless they start with `app/test/`, `dashboard/` or `scripts/`.

## A. Where the spec is wrong about the current code

A1. D15 "a terminal one maps through `mapTwilioStatus` to `delivered` or
`failed`" is not what that function does: it returns `undelivered` for Twilio
`undelivered` (adapters/messaging.ts:565-566). A broadcast slot has no
`undelivered` status (repos/broadcastsRepo.ts:128-163); the status webhook's
rollup folds it into `failed` (routes/webhooks/twilio.ts:3872-3876). A relay
slot DOES hold `undelivered` (repos/messagesRepo.ts:124-130, ALLOWED_PRIOR
139-140), the 30003 claim accepts `failed` OR `undelivered`
(routes/webhooks/twilio.ts:2790), and the fan-out's `isTerminal` does NOT treat
`undelivered` as terminal (jobs/relayFanOut.ts:189-191). The adoption's status
mapping must be written per owner, not "through mapTwilioStatus".

A2. D8 "the slot must still be `queued` and carry no SID": a broadcast slot has
no SID field at all - only `conversationId` / `tsMsgId`
(repos/broadcastsRepo.ts:128-163). The broadcast success path never leaves a
slot `queued` (it writes `sent`, jobs/broadcastFanOut.ts:480-484), so the
broadcast condition is status-only (optionally "no tsMsgId"). The "no SID"
half is a relay-only guard: a relay success leaves the slot `queued` with a
sid when the provider answered queued (jobs/relayFanOut.ts:1500-1501).

A3. D8's conditional close ("still queued") cannot be applied to a LEGACY relay
row as written. A legacy inbound source carries an EMPTY `delivery_recipients`
map (routes/webhooks/twilio.ts:907; pinned by app/test/relayFanOut.test.ts:1002-1006,
close B), and `closeRelay` today CREATES the member slot through
`markRecipient`'s wholesale SET (jobs/relayFanOut.ts:1088-1094 -> 1667-1679 ->
repos/messagesRepo.ts:3661-3682). The condition must be "slot absent, OR
(`queued` AND no sid)", or every close on a legacy row (close B, the cap, the
D9 brake remainder) closes nothing. No existing writer can express it:
`markRecipient` is unconditional, and `applyRecipientSendResult` advances
`queued -> failed` without looking at `sid` (repos/messagesRepo.ts:3508-3514,
ALLOWED_PRIOR 141). A new conditional repo write is required.

A4. D7a RECORD order ("the SID pointer ... then LAST the slot") is the REVERSE
of today's relay success path, which writes the slot first and the pointer
second (jobs/relayFanOut.ts:1495-1512). Reordering is safe on a VERSIONED row
(`applyRecipientSendResult` is forward-only and answers `stale`), but on a
LEGACY row it opens a regression race: once the pointer exists, a fast status
callback moves the slot forward (routes/webhooks/twilio.ts:3139-3145, a
child-field write), and the legacy success write that follows is
`markRecipient`'s blind wholesale SET (jobs/relayFanOut.ts:1667-1679), which
regresses `delivered` back to `queued`/`sent` and erases `deliveredAt`. The
fake fires callbacks within milliseconds (spec D19), so the lane can hit it.
The legacy success write must become conditional before the reorder.

A5. D7a lists "the token acquire" among RECORD-phase best-effort writes. That
is true of the broadcast only (post-send pacing, jobs/broadcastFanOut.ts:496,
pinned by app/test/broadcastFanOut.test.ts:1075 "records the sent recipient
slot BEFORE acquiring"). The relay unit acquires BEFORE the send
(jobs/relayFanOut.ts:1387-1405) - a PREPARE step, and the RSW deadline site.

A6. D8's list of "closes by a writer other than the attempt" is incomplete for
the broadcast. The five fence writes - `no_contact` failed (broadcastFanOut.ts:381),
`opted_out` (396), `unreachable` (406), `contact_deleted` (422), `no_consent`
(439) - write a terminal slot blindly and are not mentioned. If the plan puts
the claim AFTER them they are other-writer closes and need the D8 gate; if
BEFORE, they are own-attempt writes that must finish the record with an
outcome the vocabulary lacks (A8). Relay: `closeTerminally`
(relayRetryLeg.ts:706, 730, 749) is a post-attempt close the spec does not
name (safe under D8 because the record is then `done`/`retryable`). The
webhook's `closeRetryLegEnqueueFailed` (routes/webhooks/twilio.ts:663-694) is a
close by another writer that the D8 gate can never cover (fenced file) - record
it as residue beside gap 5 of `manual-retry-double-send-residual-windows`.

A7. D8 contradicts test intention 12 for a re-driven relay retry rung. The
job's four gate refusals and its window close run BEFORE its claim
(relayRetryLeg.ts:532-558, 586-606; RSW #6), and D8 lets such a close proceed
only when the record is absent or `done`/`retryable`. A re-driven rung's
record is `redriven` (D11), so the decline is SKIPPED and the rung is stranded
(slot `queued`, record `redriven`) - yet 8.12 requires "a re-driven rung is
declined by the job-time window check". The same trap exists for the relay
fan-out re-drive continuation's opt-out arm (relayFanOut.ts:1351-1385) and the
broadcast re-drive's fences (A6). The plan needs an explicit rule: the re-drive
job OWNS the `redriven` record it was enqueued for (payload-marked, see B1), and
its pre-claim declines move `redriven -> done` with an outcome.

A8. D8a's `outcome` vocabulary has no value for outcomes the adopted sites
produce after a claim: a `SendRefusedError` refusal (broadcastFanOut.ts:541-560;
relayFanOut.ts:1436-1453), the relay suppression arm (relayFanOut.ts:1351-1385),
a gate refusal of a re-driven rung (the four codes, lib/relayRetryGates.ts:27-31),
fence skips if fences move after the claim (A6), and the D5 kill-switch
`sms_sending_disabled` (it is `rejected`, fine, but the cause must name it).
Separately D6 says the deferred slot is "written `queued` with the code", but
connection failures and `SendNotAttemptedError` have no provider code:
`errorCodeOf` would write the network string (`ECONNREFUSED`,
broadcastFanOut.ts:180, relayFanOut.ts:1696) or the HTTP status as a string
(broadcastFanOut.ts:181-182, relayFanOut.ts:1697-1698). D10's list of codes
written on slots includes none of these. The plan must pick the codes.

A9. D1's table places `rejected` by HTTP 4xx only, but the existing fixtures
inject STATUS-LESS Twilio-shaped errors: `{ code: 30007 }`
(app/test/broadcastFanOut.test.ts:812; app/test/relayFanOut.test.ts:884),
`{ code: 30005 }` (app/test/broadcastFanOut.test.ts:832), `{ code: 429 }`
(app/test/broadcastFanOut.test.ts:183-188, 615; app/test/relayFanOut.test.ts:180-184,
902, 942-953). A status-first classifier with D2's default makes a
status-less 30005/30006 `unknown` - a reconcile instead of D5's "existing arm
keeps its behavior" - and breaks those tests. The spec gives a code-only rule
for 30007 ("stays rejected") and the legacy 429/30022 tokens, but not for
30005/30006. Decide: code-only rules for 30005/30006/30007, or add `status: 400`
to the fixtures.

A10. 8.12 "`retrySend` is byte-identical to its RSW-merged state": true of the
FILE, not of its behavior. D3 changes `sendMessage` for every caller, so
`retrySend` now receives `ProviderSendFailedError` / `SendAcceptedNotRecordedError`
instead of the raw error (jobs/retrySend.ts:329-338 rethrows non-refusals), and
a post-append failure no longer throws at all. Word the test intention as
"file unchanged".

A11. D8a's claim TTL "equals the provider's 30-second timeout": the Twilio
driver configures no request timeout (no timeout option anywhere in
adapters/messaging.ts); 30 s is twilio-node's implicit default. The TTL rests
on a library default the repo does not own - pin it in the driver or share
one constant.

## B. What the spec does not mention that the plan must handle

B1. All three payload parsers REBUILD the payload from known fields and drop
the rest: `parseBroadcastSendPayload` (broadcastFanOut.ts:124-143),
`parseRelayFanOutPayload` (relayFanOut.ts:152-186), `parseRelayRetryLegPayload`
(relayRetryLeg.ts:252-263). A re-drive marker - needed to skip the up-front
pass claim (D13a) and to own the `redriven` record (A7) - is silently stripped
unless each parser is extended. The spec never says how a continuation knows it
is a re-drive.

B2. The up-front pass claim (broadcastFanOut.ts:348-364; relayFanOut.ts:1114-1135)
closes `pending` with `transient_cap` on `capped` (broadcastFanOut.ts:361;
relayFanOut.ts:1132). D13a forbids that for a re-drive pass. And the
"unreachable by construction" guards `claim?.outcome !== 'claimed'`
(broadcastFanOut.ts:643-651; relayFanOut.ts:1176-1179) become REACHABLE for a
re-drive pass that claimed nothing up front - they would close the re-driven
recipient `transient_cap`. The re-drive pass must claim after its loop, and
only with a transient remainder.

B3. Claim placement, with the pinned evidence the plan should respect:
- Relay unit: put the claim AFTER the bounded acquire (relayFanOut.ts:1387-1405)
  and BEFORE the presign (1406). Then `deadline_exceeded` never holds a claim
  (no `window_closed` outcome needed on this branch), and the RSW pin
  app/test/relayRetryLeg.test.ts:1214-1256 stays green - it asserts the exact
  slot shape with `toEqual` and that no `attempted` write happened; a claim
  that stamps `attemptedAt` before the acquire breaks it.
- Broadcast: a claim right after the terminal skip (broadcastFanOut.ts:374-375)
  makes the fences own-attempt writes (A6/A8); their wholesale `setRecipient`
  erases the claim's `attemptedAt`, which is what keeps the exact skip-slot
  assertions green (app/test/broadcastFanOut.test.ts:324, 359, 432-437, 495,
  513). If the plan converts fence writes to child-field writes, those
  assertions see `attemptedAt`. A claim just before `sendMessage` (454) makes
  the fences D8-gated other-writer closes instead.

B4. The per-leg unit cannot build a reconcile payload today.
`RelayLegPayload` (relayFanOut.ts:1214-1217) deliberately drops `senderKey` /
`senderNameOverride`, and `sendOneRelayLeg`'s args (1270-1326) carry no owner
kind. D7/D12 need the owner kind (fan-out leg vs retry rung) and, for a fan-out
leg, the continuation context. Either widen the args or let the unit return
`handed_to_reconcile` and have each caller enqueue.

B5. The relay retry rung's outcome handling is an if-chain with a DEFAULT TAIL
(relayRetryLeg.ts:657-803): any kind not handled explicitly falls into "retry
leg ended terminally at the send" ERROR plus `announceRootClose` (790-803).
`handed_to_reconcile`, `sent_unrecorded` and any new `rejected` kind must get
arms before the tail; an exhaustive check would stop a future kind falling
through silently. The fan-out loop counts only `transient` and `sent`
(relayFanOut.ts:1159-1160); the D9 streak and new counters go there and in the
broadcast loop (broadcastFanOut.ts:368-371).

B6. D9 "three consecutive unknown": the spec does not say whether a
`retryable`, `rejected`, skipped or `sent` outcome between two unknowns resets
the streak. Define it; test intention 7 covers only three in a row.

B7. Own-attempt closes versus the D8 gate. Any close that runs AFTER this job's
own claim - a D5 `rejected` on the rung, an enqueue-failed close, the
`deadline_exceeded` close if the plan ever claims before the acquire - would,
through a D8 gate as written, read its OWN fresh `attempting` record and skip.
`refuseGate` / `closeTerminally` (relayRetryLeg.ts:487-518) and
`closeBroadcast` / `closeRelay` need an own-attempt variant conditioned on
`attemptedAt`.

B8. D3's wrapping must never wrap a `SendRefusedError`. Nearly every throw in
the pre-provider span IS one: sendMessage.ts:333, 342, 351, 353, 356, 398, 407,
424, 430, 446. Wrapping them breaks every caller's `instanceof SendRefusedError`
catch (broadcastFanOut.ts:541; relayFanOut.ts:1436; retrySend.ts:329;
missedCallAutoText.ts:245; routes/api.ts:1377, 1458, 1689) and the parity test
(app/test/sendMessage.test.ts:960-963). Only the non-refusal throws become
`SendNotAttemptedError`: `conversations.getById` (332), `contacts.findByPhone`
(361), `incrementAutomatedSendCount` (431), the trip branch's `setMode` /
`audit.append` (433-439), and `classifyMessageTransport` / `prepareMessageSend`
(465-474).

B9. `ProviderSendFailedError` must expose the provider code/status the
broadcast arms read (broadcastFanOut.ts:561 via `errorCodeOf`), and
app/test/sendMessage.test.ts:461-470 asserts `rejects.toThrow('provider
unavailable')` - the wrapper's message must carry the cause's message or that
test is rewritten deliberately.

B10. `sendMessage` post-append: `touched` (sendMessage.ts:523) feeds the
`conversation.updated` emit (539); when the touch fails and is swallowed (D3),
that emit must be skipped, not built from undefined. Test seams: `makeFakes`
has only a `sendError` override (app/test/sendMessage.test.ts:57-66, 357-358);
append / touch / audit failure injection needs new overrides. The broadcast
harness already has `failAuditAppendFor` (app/test/helpers/twilioWebhookHarness.ts:378,
436, 2218) for the audit leg.

B11. Two classes share the name `SmsSendingDisabledError`:
adapters/messaging.ts:383 (extends plain `Error`, no `code`) and
services/sendMessage.ts:91 (extends `SendRefusedError`). The adapter's reaches
the relay unit and today falls to the throw (relayFanOut.ts:1454-1492,
`errorCodeOf` returns undefined). D5's `sms_sending_disabled` token must be
written explicitly on the relay arm; alias the imports where both are in scope.

B12. Strongly consistent reads the spec requires but the code lacks:
`broadcastsRepo.getById` is eventually consistent (repos/broadcastsRepo.ts:454-457)
and feeds the pass snapshot (broadcastFanOut.ts:259) and `finalize` (730); the
legacy relay snapshot is an eventually consistent Query (relayFanOut.ts:786-790
-> repos/messagesRepo.ts:3178-3194) and the versioned re-reads use
`getByTsMsgId` (relayFanOut.ts:1595-1607 -> messagesRepo.ts:3196-3201); the
pointer reads `getRelaySidPointer` (messagesRepo.ts:3808-3821), `getByProviderSid`
(2052-2062; `getSidPointer` is consistent only on request, 2035-2050) and
`getSystemSidMarker` (3855) are all eventual. The relay retry job already reads
consistently (relayRetryLeg.ts:399). Also: `AppendResult` on a dedupe returns
only `tsMsgId` (messagesRepo.ts:1259-1264, 2558) - D11's "claim lost to a
DIFFERENT attempt" needs the pointer's `ref_conversationId`, which the dedupe
branch already holds (2543) but does not return.

B13. `finalize` today (broadcastFanOut.ts:723-771): the `broadcast_sent` audit
row is written BEFORE the flip and on EVERY call (739-745); the flip is
unconditional (`flipStatus`, condition `attribute_exists` only,
repos/broadcastsRepo.ts:497-521); `allFailed` is decided from the persisted
CUMULATIVE `stats.failed` (746), not from slots; the finalize log (757-769) has
no `unconfirmed` field. D16a needs a conditional flip that reports won/lost (new
repo method). `closeBroadcast` always ends in `finalize` (323).

B14. "The slot together with the stats bump in one conditional write" has no
repo method: `setRecipient` (repos/broadcastsRepo.ts:671-717) and `bumpStats`
(760-801) are separate UpdateCommands. DynamoDB allows SET and ADD in one
expression; return ALL_NEW for `emitBroadcastProgress` (broadcastFanOut.ts:167-173).
The D8 close's conditional slot write plus its bump needs the same shape.

B15. The D8 close becomes an ENQUEUER: taking over a stale `attempting` record
into reconcile makes `closeBroadcast` / `closeRelay` enqueue `send.reconcile`,
inherit D7's enqueue-failure path, and spend a hop from the pass's context.

B16. The claim's best-effort `attemptedAt` slot write on a LEGACY relay row may
target a member slot that does not exist (empty map, A3); a nested SET on a
missing map entry is a DynamoDB ValidationException, not a conditional failure.
Spec 8.5 expects the legacy slot to be created at first claim - the write must
be create-if-absent without touching an existing slot's other fields. On
versioned rows `applyRecipientSendResult` writes child fields
(messagesRepo.ts:3508-3528), so `attemptedAt` survives there; `markRecipient`
erases it (wholesale).

B17. The attempt record's partition key must NOT be the conversation id.
`listByConversation` has no filter (messagesRepo.ts:3178-3194); the legacy relay
snapshot takes a 5-item window from it (relayFanOut.ts:786-790), the thread API
returns raw rows (routes/api.ts:2194-2207), and the timeline projects them. Use
its own `<prefix>#...` partition like `sid#` / `relaysid#` / `job#`.

B18. New interface methods break the full, typed fakes (typecheck gate):
`MessagesRepo` at app/test/helpers/twilioWebhookHarness.ts:1080,
app/test/sendMessage.test.ts:233, app/test/scheduledSendSuppression.test.ts:273;
`BroadcastsRepo` at app/test/helpers/twilioWebhookHarness.ts:2902. The others
cast (`as unknown as MessagesRepo`: emailEvents, rateLimit, relayProvisioning,
sendEmailMessage tests). A separate send-attempt repo over the messages table
avoids widening `MessagesRepo`; D8a fixes only the table, so this is the
plan's call. The harness's record fake must model the conditions (claim,
`attemptedAt`, takeover) as faithfully as its `claimFanoutPass` does
(twilioWebhookHarness.ts:1560-1575, 2982-3000).

B19. Per-job setup residue wider than Sec 9 says. Sec 9 names the fan-outs'
per-pass setup; the relay retry rung's pre-claim steps also throw after its
marker: the row read (relayRetryLeg.ts:399-402), `readRetryLineage` (316-318),
the conversation read (532), an `isSuppressed` rejection inside the evaluator
(540; relayRetryGates.ts:71), the no-pool throw (566-568). And a re-drive
continuation's early returns strand a `redriven` record: broadcastFanOut.ts:259-263,
351-357; relayFanOut.ts:761-794, 1022-1028, 1124-1130. Name both in the filed
residue.

B20. Unwrapped best-effort steps after a successful send, which D7a says must
not fail the unit: the broadcast's `tokenBucket.acquire` (broadcastFanOut.ts:496,
throws only on its retry guard, lib/tokenBucket.ts:199) and the retry rung's
`touchLastActivityPreservingStatus` (relayRetryLeg.ts:662-666). Wrap them. On
`sent_unrecorded` the rung must defer that touch to the adoption (D15).

B21. `send.reconcile` must be registered in `registerAllJobHandlers`
(jobs/registerHandlers.ts:46-73); app/test/relayRetryLeg.test.ts imports that
function, and `defineJobHandler` throws on a second registration of a name.

## C. Risks

C1. Hop budget - VERIFIED. `buildEnvelope` throws at hop 11
(jobs/jobs.ts:37, 164-171), rejecting `enqueue` before any queue call, so "an
enqueue that throws" covers the hop limit. `relay.numberReady` is enqueued from
the registration WEBHOOK (routes/webhooks/twilioEvents.ts:166 ->
services/poolNumbers.ts:665), so it is hop 1 and the fan-out hop 2, as D13a
says; worst case 8 holds. The relay retry rung peaks at 7 (rung hop 1 from the
status webhook, transient re-enqueues 2-3, checks 4-6, re-drive 7). Any extra
hop the plan adds (a reconcile enqueued by a D8 takeover) must be re-counted.

C2. A D9 brake on the LAST rung closes the untried remainder `transient_cap`
in the same pass (broadcastFanOut.ts:655-660; relayFanOut.ts:1180-1183): an
outage on pass 3 marks never-attempted recipients failed. Accepted by Sec 2's
"Out" list, but test intention 7 should include the last-rung case.

C3. Exact slot-shape assertions (`toEqual`) that a surviving `attemptedAt`
breaks: app/test/relayRetryLeg.test.ts:557-566 (window close) and 1232-1241
(deadline close), app/test/broadcastFanOut.test.ts:324, 359, 432-437, 495, 513.
Keep claim placement and wholesale fence writes consistent with them, or change
them deliberately.

C4. The record's reconcile facts are computed OUTSIDE `sendMessage` (the claim
precedes the call) but must match what it sends: the destination is
`conversation.participant_phone` (sendMessage.ts:355), not `contact.phone`;
the sender is `from ?? config.businessPhoneNumber` (464) - the broadcast passes
no `from` (broadcastFanOut.ts:464-473), and under the console driver in unit
tests `BUSINESS_PHONE_NUMBER` is unset, so the sender is undefined (the lane
sets it, scripts/e2e-session.mjs:169). Derive both from the same values.

C5. ASCII: broadcastFanOut.ts, relayFanOut.ts and sendMessage.ts carry 21, 18
and 39 lines with U+2014 (several are log messages). No test matches an
em-dash log string (grep of the four test files), so ASCII-fying a touched log
line is safe.

C6. `SendRefusedError['code']` keys `REFUSAL_STATUS` (routes/api.ts:173); a new
refusal code would force a status row. The spec adds none - keep it so.

## D. Invariant sweep (app/src only; one line each)

### D1. Broadcast recipient slot - writers

- repos/broadcastsRepo.ts:528-559 `create` - draft with `recipients: {}`.
- routes/broadcasts.ts:268-276 `buildRecipientsFrom` - `{status:'queued'}` per contact (seeded path).
- routes/broadcasts.ts:738-741 filter path - `{status:'queued'}` per contact.
- repos/broadcastsRepo.ts:621-647 `markSending` - writes the WHOLE map + `stats.audience/queued` (called routes/broadcasts.ts:747).
- jobs/broadcastFanOut.ts:709-716 `recordRecipient` -> `setRecipient` (broadcastsRepo.ts:671-717, blind child SET, wholesale slot); call sites:
  - broadcastFanOut.ts:296 `closeBroadcast` - failed + close code.
  - broadcastFanOut.ts:381 - failed `no_contact`.
  - broadcastFanOut.ts:396 - skipped `opted_out`.
  - broadcastFanOut.ts:406 - skipped `unreachable`.
  - broadcastFanOut.ts:422 - skipped `contact_deleted`.
  - broadcastFanOut.ts:439 - skipped `no_consent`.
  - broadcastFanOut.ts:480-484 - sent + `conversationId` + `tsMsgId`.
  - broadcastFanOut.ts:546 - skipped + `SendRefusedError.code`.
  - broadcastFanOut.ts:563 - failed `30007`.
  - broadcastFanOut.ts:574 - failed `30005`/`30006`.
  - broadcastFanOut.ts:604 - queued + transient code.
- routes/webhooks/twilio.ts:3924-3929 `rollIntoBroadcast` - `carrierSentAt` stamp, conditional `['sent']`, wholesale from its snapshot.
- routes/webhooks/twilio.ts:3949-3957 `rollIntoBroadcast` - delivered/failed, conditional `['queued','sent']`, wholesale from its snapshot.
- repos/broadcastsRepo.ts:811-838 `delete` - removes a DRAFT item only.
- Seeds: lib/seed/matrix.ts:1229-1231 (sent broadcast, one delivered slot), 1252 (draft, empty map); lib/seed/performance.ts:989-993 `recipientStatus` + 1021-1025 (slot per recipient from broadcast status), stats 995-1010.
- Dev seams: none (routes/dev.ts writes no broadcast); reseed goes through the seed modules.
- Adjacent state on the same item: `bumpStats` writers broadcastFanOut.ts:300, 385, 400, 410, 426, 443, 491, 555, 567, 578 and routes/webhooks/twilio.ts:3975; status flips broadcastFanOut.ts:748-749 and routes/broadcasts.ts:769; `fanout_attempt` claim broadcastFanOut.ts:350.

### D2. Broadcast recipient slot - readers

- jobs/broadcastFanOut.ts:295 - `closeBroadcast` terminal skip off the pass snapshot.
- jobs/broadcastFanOut.ts:336-340 - the key set.
- jobs/broadcastFanOut.ts:348 - `pending` (decides the pass claim).
- jobs/broadcastFanOut.ts:374-375 - per-recipient terminal skip.
- jobs/broadcastFanOut.ts:735, 746 - `finalize` total and persisted `stats.failed`.
- jobs/broadcastFanOut.ts:171, 756 - derived stats for emits and the finalize log.
- repos/broadcastsRepo.ts:254-306 `deriveBroadcastStats` - switch on status, no default arm.
- repos/broadcastsRepo.ts:576-619 `priorRecipientContactIds` - non-skipped keys of sent/sending broadcasts (read by routes/broadcasts.ts:523).
- routes/broadcasts.ts:223-258 `enrichRecipients` - spreads each slot (new attributes reach the API as-is).
- routes/broadcasts.ts:280-297 `toBroadcastResults`, 300-315 `toBroadcastSummary`, 795-796 results route.
- routes/webhooks/twilio.ts:3840-3844 `broadcastSlotMayTransition`; 3879-3905 slot match by `conversationId`+`tsMsgId`; 3909, 3923, 3970 status reads.
- routes/webhooks/twilio.ts:3529-3545 - routes a 1:1 message carrying `broadcast_id` into the rollup.

### D3. Relay delivery slot - writers

Create / seed:
- routes/webhooks/twilio.ts:895-912 - inbound relay source append with an EMPTY map (versioned).
- routes/api.ts:1823-1853 - team relay send, per-member `{status:'queued', requestedTransport}` at append.
- routes/api.ts:1745-1764 - held (`queued_pending`) team source with its queued slots.
- routes/webhooks/twilio.ts:2945-2965 - the 30003 claim appends the rung row with its one slot (open, or closed at claim).
- jobs/relayFanOut.ts:1529-1541 - versioned preflight `initializeRecipientDelivery` (`queued`/`planned`) -> repos/messagesRepo.ts:3290-3330.
- services/relayAnnouncements.ts:220-240 - intro / member-added rows (another send site; Stage 2).
- services/groupSend.ts:607-677 - native group-text rows (another owner, same map shape).
- routes/dev.ts:870-1045 - hermetic message-fixture seam (append, or raw PutCommand with `delivery_recipients`).
- lib/seed/lean.ts:419-424, lib/seed/messageTransport.ts:49-61 - transport fixtures on 1:1 rows.

Update / close:
- jobs/relayFanOut.ts:1551-1557 - aggregation `planned`; 1572-1578 - aggregation `excluded` for non-roster slots.
- jobs/relayFanOut.ts:1353 - aggregation `excluded` (suppressed); 1355-1358 - failed `contact_opted_out`.
- jobs/relayFanOut.ts:1426 - aggregation `attempted`.
- jobs/relayFanOut.ts:1437-1443 - failed + refusal code.
- jobs/relayFanOut.ts:1456-1462 - failed `30007`.
- jobs/relayFanOut.ts:1474-1480 - queued + transient code.
- jobs/relayFanOut.ts:1495-1507 - success: `queued`/`sent` + sid + sentAt + actualTransport.
- jobs/relayFanOut.ts:1081-1110 `closeRelay` - failed + close code.
- jobs/relayFanOut.ts:1644-1664 `persistRelayRecipientResult` -> 1667-1679 `markRecipient` -> repos/messagesRepo.ts:3661-3682 `setRecipientDelivery` (legacy, WHOLESALE, unconditional) | repos/messagesRepo.ts:3473-3612 `applyRecipientSendResult` (versioned, child fields, forward-only).
- jobs/relayFanOut.ts:1615-1635 `setVersionedAggregationState` -> repos/messagesRepo.ts:3332-3401.
- jobs/relayRetryLeg.ts:487-505 `refuseGate` - aggregation `excluded` + failed code.
- jobs/relayRetryLeg.ts:509-518 `closeTerminally` - failed code.
- routes/webhooks/twilio.ts:663-694 `closeRetryLegEnqueueFailed` - aggregation `excluded` + failed `enqueue_failed` (fenced; outside D8).
- routes/webhooks/twilio.ts:3139-3145 - status callback `updateRecipientDeliveryStatus` (child fields, forward-only) -> repos/messagesRepo.ts:3684-3758.
- routes/webhooks/twilio.ts:3147-3153 - `setRecipientActualTransport` -> repos/messagesRepo.ts:3403-3471.
- services/relayAnnouncements.ts:397, 414 - announcement rows (Stage 2 site).
- services/groupReceipts.ts:410, 448, 472; repos/messagesRepo.ts:3760-3782 `setRecipientDeliverySid` - group-text rows.
- Adjacent state: `fanout_attempt` claims relayFanOut.ts:1119, relayRetryLeg.ts:698; `relaysid#` pointer relayFanOut.ts:1508-1512.

### D4. Relay delivery slot - readers

- jobs/relayFanOut.ts:1059 - persisted `requestedTransport` (intent-drift WARN).
- jobs/relayFanOut.ts:1087 - `closeRelay` terminal skip off the snapshot.
- jobs/relayFanOut.ts:1114-1117 - `pending` (decides the pass claim).
- jobs/relayFanOut.ts:1348-1349 - per-leg terminal skip (`isTerminal`, 189-191).
- jobs/relayFanOut.ts:1528, 1548-1550, 1562-1571, 1584-1593 - preflight and `canReopenExcludedSlot`.
- jobs/relayFanOut.ts:1631 - aggregation conflict re-read.
- jobs/relayRetryLeg.ts:399 - consistent row read, passed on as `currentSource`.
- routes/webhooks/twilio.ts:2787-2795 - 30003 claim eligibility (status, errorCode).
- routes/webhooks/twilio.ts:2877 - window origin = root slot `sentAt`.
- routes/webhooks/twilio.ts:3122-3124 - status callback reads `requestedTransport`.
- routes/api.ts:2194-2207 - thread messages GET returns raw rows, map included.
- routes/contactTimeline.ts:204, 453 - timeline projection passes the map through.
- services/groupReceipts.ts:343, 503; services/groupSendStaleness.ts:166 - group-text rows.

## E. Confirmations (the spec is right)

- Parity row NOT owed for typed thrown errors. The parity test
  (app/test/sendMessage.test.ts:936-970) catches `instanceof SendRefusedError`
  and rethrows anything else, and its fake adapter never throws; classes that
  extend plain `Error` and are thrown only at non-gate failure points add no
  refusal, so `app/test/helpers/sendRefusalCases.ts` needs no row - PROVIDED B8
  holds (no `SendRefusedError` is ever wrapped). `previewSendRefusal`
  (services/sendRefusalPreview.ts:43-79) mirrors gates only.
- RSW: `deadline_exceeded` returns before any `attempted` write
  (relayFanOut.ts:1398-1403 vs 1425-1427); the fan-out passes no deadline
  (1140-1155; pinned by app/test/relayFanOut.test.ts:2354-2369).
- "Must fail on main" is observable: the in-process queue swallows a handler
  throw (adapters/scheduler.ts:193-204), so the later recipients are simply
  never sent.
