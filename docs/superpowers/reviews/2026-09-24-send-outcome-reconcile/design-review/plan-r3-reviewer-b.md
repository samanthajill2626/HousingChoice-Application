# Plan review r3 - reviewer B (adversarial, continued)

Plan: `docs/superpowers/plans/2026-09-26-send-outcome-reconcile.md` revision 3
(@b25d7807). Spec: revision 10 (@39a9003f). Adjudications: `adjudications.md`
"Plan round 2". Method as before: every claim below was checked against the
repo at b25d7807 (file:line cited). Anything not verified is marked UNVERIFIED.
Plan line numbers are "plan:NNN".

Order: new problems first (1-6), then problems in the rewritten material,
then contests, then smaller items. Items 3, 4, 5 and 6 sit in the rewritten
material that answered round 2.

---

## 1. [HIGH] A relay retry rung's `never_sent` re-drive never marks the record `redriven`, so every re-driven rung strands

What is wrong: Task 10's `redrive()` calls `markRedriven` for the broadcast
owner and the relay_leg owner, but for relay_rung it says only "the pre-check,
then `enqueueOrClose(() => enqueue(RELAY_RETRY_LEG_JOB, { relayConversationId,
retryTsMsgId, redrive: true }))`" (plan:1836). grep of the plan shows no
`markRedriven` on the rung path. The rung record therefore stays `reconciling`
when the re-drive job runs. Two outcomes follow, and both strand the rung:
- If the window gate refuses, `gateFor(rungOwner, redrive=true)` finds
  `reconciling` (not the pass's own `redriven`) and returns `'defer'`. The
  rung then "skip[s] the write with a WARN and return[s]" (plan:1745).
- If the gates pass, the unit's claim finds `reconciling`, which is
  `refused !fresh` and returns `skipped_terminal` (plan:1620, plan:909). The
  rung's `skipped_terminal` arm is "unchanged": an INFO line, no close
  (`app/src/jobs/relayRetryLeg.ts:763-766`).

Nothing is re-sent, nothing closes, the record sits in `reconciling` for ever,
and `redriveCount` never increments. A second `never_sent` delivery enqueues
another useless rung. An enqueue failure on this path is also mis-closed:
`enqueueOrClose` closes `enqueue_failed` only "if the record is `redriven`" and
otherwise closes `unresolved` (plan:1793), which contradicts D13a (a never_sent
verdict whose enqueue fails closes `enqueue_failed`). Task 9's own test seeds
the record with `markRedriven` by hand (plan:1727), so Task 9 assumes a state
Task 10 never produces. No Task 10 case covers a rung `never_sent`: case 15 is
relay_leg only, case 16 is rung adoption. The omission is carried over from
revisions 1 and 2, so all rounds missed it.

Implies: the rung path runs `markRedriven` exactly as the leg path does (with
the `redriveCount >= 1` -> `second_unknown` branch). Add a case: rung
`never_sent` -> a `relay.retryLeg` envelope with `redrive: true`, the record
`redriven`, and the re-driven rung claims and sends.

## 2. [MEDIUM] Task 5's eleven integration cases share one record, one index partition and one table; from case 5 on they fail against a correct repo

What is wrong: every case claims the same `owner` (`b-1` / `phone#+16175550100`)
with the same `facts` (plan:660-661). The skeleton the plan cites creates ONE
table per describe, in `beforeAll`, and deletes it in `afterAll`, with no
per-test reset (`.superpowers/sdd/plan-data-layer-reference.md` Sec 11:
`beforeAll(... ensureTable ...)`, `afterAll(... deleteTableIfExists ...)`).
State leaks between cases:
- After case 3 the record is `done/sent`. Case 5's opening claim at T0 is
  refused, its `finishAttempt(retryable)` returns false, and the claim at T1
  is `refused !fresh`, where the test expects `claimed`, attemptNo 2
  (plan:689-697).
- Case 6 (stale takeover) and case 8 fail the same way.
- Case 10 expects exactly `[T1, T0]` from the index partition (plan:739), but
  every earlier successful claim wrote an index item into that same partition,
  including case 9's four `b-<outcome>` claims with the same facts
  (plan:725-726).
- Case 11's sender-less claim is refused (the record exists), so the `-`
  partition stays empty against an expected length of 1 (plan:744-748).

A builder running Step 3's "-> PASS (11 tests)" (plan:992) will conclude the
repo is wrong.

Implies: a unique owner (or `broadcastId`) per case, and a unique
`recipientDigest` per case for the index assertions.

## 3. [MEDIUM] Relay `gateFor` hands off inside the gate AND the unit returns `handed_to_reconcile` for the loop to hand off again; neither side has what it needs

What is wrong: Task 7's `gateFor` takes over a stale record and calls
`handOff` itself before returning `'handed'` (plan:1399-1400). Task 8 says the
relay files get "the module-local `gateFor` (same body as Task 7's ...) and
`handOff`" (plan:1606). The unit's `'handed'` arm then returns
`{ kind: 'handed_to_reconcile', reason: 'takeover', attemptRef: { attemptNo:
rec.attemptNo, ... } }` (plan:1614), and the loop hands off every
`handed_to_reconcile` (plan:1656). Three defects follow:
- (a) Two reconcile chains are enqueued for one takeover. They converge, but
  cost hops and list calls.
- (b) `gateFor` returns only the string `'handed'`, so `rec` is not in scope
  in the unit; `attemptRef` cannot be built as written.
- (c) The unit has no `senderKey`. `RelayLegPayload` narrows it away
  (`app/src/jobs/relayFanOut.ts:1214-1217`), so a `handOff` issued from inside
  the unit cannot attach the `continuation` a relay_leg re-drive needs. That
  chain's `never_sent` then closes `redrive_refused` / `no_continuation`
  (plan:1836) instead of re-driving: a member who was never texted is closed
  as refused.

`closeRelay` (loop scope, where `payload.senderKey` exists) is the only relay
caller for which the gate-internal `handOff` is correct.

Implies: inside the unit, `gateFor` must not hand off. It returns the taken-
over record (or its `AttemptRef`), and the loop hands off once, with the
continuation. State which copy does what.

## 4. [MEDIUM] A relay pre-claim throw drops the member for every later pass (the broadcast defers the same class)

What is wrong: the relay unit's phase-tracked `try` starts after the claim and
the `attemptedAt` write (plan:1624-1625). The suppression read, `gateFor`, the
token acquire and the `claim()` itself all run before it (plan:1611-1622).
The token acquire's own guard can throw (`app/src/lib/tokenBucket.ts:199`,
per plan-send-sites-findings B20). A throw in any of these leaves the unit, and
the loop's catch "turns any other throw into ERROR + continue" (plan:1660).
The member is not pushed to `transientRemaining`, so no continuation carries
it and no close covers it. Its slot stays `queued`; on a legacy row with an
empty map there is no slot at all. Nothing ever retries it.

Task 7 handles the identical class by deferring (`phase === 'prepare' && ref
=== undefined` -> `send_retryable` + `transientRemaining`, plan:1442-1444). The
spec's D7a PREPARE row lists "the roster suppression check (relay), the relay
token acquire ..., the claim" as prepare steps (spec D7a table). Round 2 #2
fixed broadcast only.

Implies: the relay loop's per-member catch defers the member as the broadcast
does when the unit threw before a claim. Add a relay test: `isMemberSuppressed`
throws once, and the member is carried and sent on the continuation.

## 5. [MEDIUM] The sibling filters compare `ownerKey`, which drops the recipient, so case 5e contradicts the specified lookup (contests R2 #18 as applied)

What is wrong: `ownerKey` is `broadcast#<broadcastId>` with no recipient
(plan:811). Task 10 excludes siblings with
`ownerKey(s.owner) !== ownerKey(owner)` in both places:
- `siblingSids` (plan:1803);
- the same-fingerprint rule (plan:1821).

So a SAME-broadcast sibling - two contacts on one phone, the exact case R2 #18
was about - is never a sibling. Case 5e (plan:1851) expects B to end
`unresolved` `same_fingerprint_sibling`. With the specified filter, A's
adopted record is excluded, `.some` is false, and B is `never_sent` and
re-driven. The plan's code and its own test disagree.

Separately: A's SendAcceptedNotRecorded-shaped record (SID on the record, no
row) is never in B's `siblingSids`. B can list that SID, find it `free`, match
it and adopt it (stamping `recipient_contact_id` = B). A's known-SID reconcile
then reads `other` and closes `sid_held_elsewhere`. That is the swap D13
forbids. Spec D11 compares the row's `broadcast_id` AND the record's owner;
the round-2 fix went into `heldBy`'s "mine" rule (plan:1826) and
`adoptBroadcastRecipient` (plan:1494), but not into these two filters.

Implies: compare record identity (`ownerKey` plus the hashed recipient key) in
both filters, and restate case 5e's expected verdict after deciding it.

## 6. [MEDIUM] The relay ladder is shorter than the claim TTL, so "the continuation's claim takes the stranded record over" is false for relay - SPEC: D8a's sentence is wrong

What is wrong: the round-2 #1 refinement rests on this sentence: a stranded
recipient (lost `handToReconcile`) is deferred, and "the continuation's claim
takes it over once stale" (plan:1453, plan:1485, plan:1658; adjudications R2 #1).
The takeover needs the record older than `SEND_CLAIM_TTL_MS` = 30 s
(plan:907). The relay continuations wait `fanOutBackoffMs(attempt)` = 5 s,
then 10 s (`app/src/jobs/relayFanOut.ts:99-101`, `MAX_FANOUT_ATTEMPTS = 3` at
`:83`), so the cap pass runs about 15 s after pass 1. A relay record stranded
in pass 1 or 2 is still FRESH at the cap. `closeRelay`'s gate defers it, and it
stays `attempting` with a `queued` slot until the sweeper. The rung's transient
sub-ladder uses the same 5/10 s backoff (`relayRetryLeg.ts:337`) and a stranded
rung has no continuation at all. Only the broadcast ladder (10 s + 20 s)
clears the TTL.

The spec states the opposite. D8a: "The TTL is deliberately no longer than the
ladders it must fit inside (about 35 seconds on broadcast, 15 on relay), so a
stuck attempt is taken over at the cap rather than skipped past it" (spec
lines 433-434). 30 s is longer than 15 s.

Implies: a SPEC correction (D8a) and a plan note that relay and rung strands
are sweeper residue. Task 15 already files "a fresh `attempting` record at the
cap-close" (plan:2137); the stated mechanism should match it. No double send
results; the gap is only that no verdict is ever reached.

## 7. [LOW] The stub's `enqueueSendReconcile` passes an option `enqueue` does not have

`jobs.enqueue(SEND_RECONCILE_JOB, payload, { delaySeconds: ... })`
(plan:1383). `EnqueueOptions` is `{ runAt?: Date }` only
(`app/src/jobs/jobs.ts:91-93`). The object literal is a TS2353 error, and at
runtime the delay would be ignored, so every check would run immediately. The
note after it (plan:1387) points at the right shape. The quoted code should
match it (`{ runAt: new Date(Date.now() + delayMs) }`, the `enqueue` named
import that `broadcastFanOut.ts:88` uses).

## 8. [LOW] `BRAKE` sits inside a `switch` inside a `catch`; a bare `break` leaves the switch, not the loop

plan:1473 invokes `BRAKE` from inside `case 'unknown'`, and plan:1480 defines
it as "...; break". Written literally, the `break` exits the `switch`, the
following `continue` runs, and the loop never stops. It needs a labeled loop
or a flag. Test 4a (plan:1538) will catch it, but only after the builder
follows the sketch.

## 9. [LOW] The pre-claim deferral write is blind

`phase === 'prepare' && ref === undefined` writes
`setRecipient(..., { status: 'queued', errorCode: SEND_RETRYABLE_CODE })`
(plan:1443). `setRecipient` without priors is a blind child SET
(`app/src/repos/broadcastsRepo.ts:680-707`). Two ways it does harm:
- A fence whose slot write succeeded and whose `bumpStats` then threw has its
  `skipped` slot reverted to `queued`, so an opted-out recipient re-enters the
  ladder and can close `failed`/`transient_cap` at the cap. (Under the
  interim "Already sent" rule, failed counts as sent.)
- A `gateFor` read that threw on a recipient a FOREIGN attempt owns can revert
  that attempt's `sent`, and the broadcast then never finalizes.

Pass `['queued']` as the allowed priors.

## 10. [LOW] `gateFor` has no "skip" result, so a terminal record is carried to the cap

`gateFor` returns `'defer'` for every non-closable state (plan:1403), including
`done` with a terminal outcome. Global Constraint plan:42 says "defers ... or
skips". On relay, a `done/sent` record whose slot is `queued`+sid (a
provider-queued success, `relayFanOut.ts:1500`) reaching the suppression arm
is returned `transient` `deferredByClaim` (plan:1613). It is carried through
every continuation, spending rungs and hops, until the cap-close skips it.
Test 11 (plan:1676) pins only "not overwritten". A terminal `done` should be
`'skip'`.

## 11. [LOW] Deviation 4 is inaccurate: the NEW `send.reconcile` payload is not phone-free (contests R2 #13 as narrowed)

Deviation 4 says "only the NEW `send.reconcile` payload is phone-free"
(plan:19). That payload carries `continuation.senderKey` (plan:176, plan:1656),
a raw member key, which is `phone#<E164>` for a contact-less sender. That
sender is also a member of the group. Case 21 (plan:1869) fails for a
phone-keyed SENDER. Either hash the sender key in the reconcile payload
(resolve it at the handler, as the recipient key is), or declare it and scope
case 21 to the owner field.

## 12. [LOW] Deviation 3 describes behavior the plan does not have (contests R2 #16 as written)

Deviation 3 ends "... a lost record fence makes the site skip the slot write"
(plan:18). Every arm writes the slot BEFORE the fenced `finishAttempt`:
- RECORD: `recordRecipientOutcome`, then `finishAttempt` (plan:1436-1438);
- rejected: plan:1464-1465;
- relay: plan:1630, plan:1645.

A lost fence is discovered only after the slot write. Either reorder where the
spec allows, or reword the deviation to what is built: the slot keeps its own
guards, and a lost fence leaves the reconcile to repair it.

## 13. [LOW] The rejected arms write an HTTP status as the slot code

`code ?? String(classification.status)` goes onto the slot at plan:1464
(broadcast) and plan:1645 (relay). Review Focus 1's 400-with-no-code therefore
writes `errorCode: '400'`, which renders "Delivery failed (error 400)", a fake
carrier number. D10's list of slot codes has no HTTP status. D23: "New codes
render as prose, never as fake carrier numbers". Write no code (the badge then
reads "Delivery failed"), or a named internal code with prose. The record's
`cause` can keep the status.

## 14. [LOW] Task 3's sketch still names things that do not exist, and digests the wrong phone

- The comment says `f.env` and `f.sent` "are the file's real names"
  (plan:1188). `Fakes` has no `env` (`app/test/sendMessage.test.ts:41-55`),
  and `f.sent` holds `SendMessageParams`, which has no `sid` - yet the sketch
  reads `f.sent[0]!.sid` (plan:1219).
- The sketch expects `recipientDigest(..., '+15550001111')` (plan:1211). The
  fixture conversation's `participant_phone` is `+15550100001`
  (`app/test/sendMessage.test.ts:68`), so the assertion fails against a correct
  implementation.
- Task 3 cites `errorCodeOf` at `app/src/lib/errors.ts:68-98` (plan:1178).
  That range is `summarizeError`; `errorCodeOf` is
  `app/src/jobs/broadcastFanOut.ts:176-185` (both read the own
  `code`/`status`, so the conclusion stands).

## 15. [LOW] Task 7 test 5c's headline assertion is vacuous, and three tests would drain a job with no handler

- `unknownOn` replaces `world.adapter.sendPreparedMessage` and never records
  (plan:1501-1505). "world.sent has ZERO messages to t-1" (plan:1563) is
  therefore true even if t-1 were re-sent. Count the override's calls, per the
  file's own note that "the stub's own call count is the only honest send
  count" (`app/test/broadcastFanOut.test.ts:172-176`). The test's second
  assertion (the ORIGINAL `attemptedAt`) is what actually guards R2 #1.
- Tests 5c, 7b and 8 each produce a `send.reconcile` envelope. At Task 7 no
  handler is registered, so `dispatchJob` throws `MalformedJobEnvelopeError`
  (`app/src/jobs/jobs.ts:257-261`), and `deliverDelayed` does not catch it (the
  file's own comment at `:745-746`). Drain only the `broadcast.send` envelopes
  (the `outbound.delayed.shift()` idiom at `:660-665`).

## 16. [LOW] The D9 streak treats `stranded` inconsistently between the two loops

The relay loop resets the streak on `stranded` (plan:1657). The broadcast loop
neither increments nor resets on a stranded unknown or on `sent_unrecorded`
(plan:1454, plan:1459, plan:1474). A stranded recipient IS an unknown provider
outcome whose bookkeeping failed. In a joint outage (DynamoDB failing too)
every member strands, the relay brake never fires, and every member pays the
30 s timeout. Count `stranded` toward the streak in both loops.

## 17. [LOW] A re-drive deferral can strand its `redriven` record once the marker is stripped

A pre-claim throw on a re-drive pass defers the key, and the record stays
`redriven` (plan:1442-1444). If the pass is not at the cap it enqueues a
continuation, and "a transient continuation never carries `redrive`"
(plan:1493). If a fence then trips on that continuation,
`gateFor(owner, redrive=false)` returns `'defer'` for the `redriven` record
(plan:1398, 1403). At the cap, `closeBroadcast`'s gate defers again, so the
slot stays `queued` and the broadcast never finalizes. Only the claim treats
`redriven` as claimable regardless of the marker (plan:901-903). The gate
should too, or the continuation should keep the marker for keys whose record
is still `redriven`.

## 18. [LOW] `adoptRelayRecipientIfUnsent` does not say how it tells legacy from versioned

The text says "on a VERSIONED row delegate to `applyRecipientSendResult` ...
else `missing`; on a LEGACY row ..." (plan:1032). If the implementation
delegates first, a legacy row returns `legacy_noop`
(`app/src/repos/messagesRepo.ts:3481`), which maps to `missing`. Task 10 then
throws on `missing` (plan:1832), and the job retries five times into the DLQ.
State the discriminator: a consistent read of `transport_schema_version` first,
or `legacy_noop` -> the legacy branch.

## 19. [LOW] Two small `sid_held_elsewhere` gaps

- Spec D13 revision 10 says the ERROR "names both owners". `adoptKnown` and
  `closeUnresolved` log only the current owner (plan:1828, plan:1838); `heldBy`
  must return the other owner for the line.
- `lookup` returns `adopt()`'s result unfiltered on the `held === 'mine'` path
  (plan:1815). An `other` there (race-only) has no arm in the verdict switch
  (plan:1785-1789) and would strand the record. Map it to `unresolved`, as
  `adoptKnown` does.

## 20. [LOW] Task 16's "dashboard's pinned clock" was not found (UNVERIFIED)

plan:2159 seeds `attemptedAt` "16 minutes before the dashboard's pinned
clock". A grep of `dashboard/src` and `e2e/support` found pinned clocks only
in unit tests (`Timeline.delivery.test.tsx`, `Timeline.test.tsx`,
`InboxRow.test.tsx`, `TourConversation.test.tsx`), and no lane-level pin.
A wall-clock `attemptedAt` 16 minutes old works; say so.

---

## Round-2 adjudications verified as correctly applied (one line each)

- R2 #2 (catch-arm writes): correct for broadcast. Every arm goes through
  `guardWrite` (plan:1443-1483), `handOff` is total, and `outcome` is hoisted
  (plan:1417). The relay gap in finding 4 is outside the unit's try, not in its
  arms.
- R2 #4 (deps fields): correct. Task 5 lists the three job files and the
  field (plan:585, plan:996).
- R2 #6 (per-statement names): correct at plan:1033. `closeRelayRecipientIfUnsent`
  (plan:1031) and the legacy adoption (plan:1032) are per statement too.
- R2 #7 (legacy adoption): correct. The seed, `allowedPriorStatuses` plus the
  same status (`app/src/repos/messagesRepo.ts:133-145`), and the test's
  `sent` -> `queued` = `skipped` case (plan:1081).
- R2 #9 (page size): correct. `_payload.page_size` is compared with the request
  (plan:551-554), and twilio-node's `Page` keeps `_payload`
  (`node_modules/twilio/lib/base/Page.d.ts`).
- R2 #10, #12, #15, #17: applied as ruled.
- Task 5's expressions: every alias and value in `CLAIM_SET` / `CLAIM_NAMES` /
  the per-branch values and the seven transitions is used, and none is unused
  (plan:854-866, plan:925-966). Round 1's BLOCKING stays fixed.
