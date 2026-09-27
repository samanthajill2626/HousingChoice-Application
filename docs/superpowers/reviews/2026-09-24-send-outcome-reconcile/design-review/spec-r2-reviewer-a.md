# Spec review r2 - reviewer A (adversarial)

Spec: `docs/superpowers/specs/2026-09-24-send-outcome-reconcile-design.md`,
revision 2 (@513e0717). Inputs also read: `adjudications.md`,
`spec-r1-reviewer-b.md`, the three `research/` files. Every code claim cites a
file:line read in this worktree; anything not verifiable is marked UNVERIFIED.

Order: new defects first (most of them in the revised text), then contested
adjudications, then residual checks of the fixes.

---

## R2-1 [BLOCKING] D11 reintroduces the anchor defect: after the winning conditional write, a throw is NOT a genuine retry. The redelivery loses the condition and no-ops, and the only way to resume is a double text

**What is wrong.** D11 says every transition is a conditional write that exactly
one writer can win, and every enqueue happens only AFTER the win. It then
concludes: "That conditionality is what makes a throw inside the job a genuine
retry: five failures reach the DLQ." That is backwards for every step that runs
after the win:

- **Next check.** Check k records its number (the win), then enqueues check
  k+1. Suppose the process dies between the two (OOM, a hard kill, a stop
  timeout). SQS redelivers check k. Its condition ("recorded number is the
  previous one") now fails, so by D11 it does not enqueue. The chain is dead.
  The slot stays `queued`/`send_unconfirmed`, and D8 hides it from every close
  and every send site.
- **Adoption (D15).** A `found` verdict makes several writes: the conditional
  slot flip, plus the message row append, the `sid#`/`relaysid#` pointer, the
  stats bump, the milestone, the listing-send row, the touch and the audit
  row. If the slot flip wins and any later write throws, the redelivery
  finds the slot no longer `send_unconfirmed` and no-ops. The handler returns
  successfully, so the consumer deletes the message: no DLQ, no page. Nothing
  ever writes the row or the pointer, so receipts for that SID are dropped for
  ever. A DynamoDB throttle or `TransactionInProgressException` on the second
  write is enough. That is the most common fault, and the one that produced
  `accepted-send-lost-when-append-fails`.
- **Re-drive (D16).** The verdict flips the slot to `send_redrive` (the win),
  then enqueues the re-drive. The same crash or throw leaves an "ordinary
  queued slot" that no pass will ever list. D16a then keeps the broadcast
  `sending` for ever.

This is exactly the anchor issue's shape: a claim, then a throw, and the
redelivery is suppressed by the claim. It now sits inside the job built to fix
it. D13a catches a THROWN enqueue and closes `unresolved`. That covers the
enqueue call itself, but not process death and not a throw in any
non-enqueue write after the win.

**The obvious repair double-texts.** One could let a redelivery that sees its
own transition already made "resume" the post-win steps. For the re-drive that
means enqueueing it a second time. Neither send site claims a recipient before
sending (the broadcast slot is written `sent` only after `sendMessage` returns,
`app/src/jobs/broadcastFanOut.ts:417-434`; relay likewise,
`app/src/jobs/relayFanOut.ts:1385-1462`). Two re-drive passes both see a
`send_redrive` slot as sendable (D16: "an ordinary queued slot to every send
site") and both send.

**Evidence.** Spec D11, D13a, D15, D16, Sec 8 test 8 (which tests duplicates,
not a crash or throw after the win). Worker jobs run concurrently and are
redelivered by visibility timeout (`infra/modules/jobs/main.tf:34-42`,
`app/src/adapters/sqsJobConsumer.ts:13-23`). Reviewer B r1 #3 asked for "the
flip-then-crash window that gating opens" to be closed; the adjudication (A1/B3)
does not mention it.

**What it implies.** The spec must fix three things:
1. A commit order for each verdict. Every idempotent effect (the conditional
   append, the pointer put, the milestone and listing-send upserts) runs
   BEFORE the conditional slot transition. The transition is the commit
   point. Only best-effort, non-idempotent effects (the stats bump, emits)
   come after it.
2. Resumption. A redelivery that finds the transition made by ITS OWN chain
   (record a verdict or chain token on the slot) re-runs the post-commit
   enqueue.
3. A send-time claim for re-drives. The re-drive pass conditionally moves
   `send_redrive` to an in-flight state before sending, so a duplicate re-drive
   enqueue is harmless.

Without all three, D11 either strands (no resume) or double-texts (resume).

---

## R2-2 [BLOCKING] D13's revised candidate rule adopts the wrong message: a single survivor is `found` whatever its body, and unheld outbound messages from another source are common in exactly the outage D13 exists for

**What is wrong.** Revision 2 demoted the body hash to "a tie-breaker only,
never a requirement". With exactly one survivor the verdict is `found`
unconditionally. A survivor is any message To the recipient From the sender,
created from 60 seconds before the attempt until now, whose SID has no
`sid#`/`relaysid#` pointer. Messages that meet that test but are NOT this
attempt:

- **Another owner's orphan in the same outage.** Relay pool numbers multiplex
  across relay groups (`app/src/adapters/messaging.ts:608-616`). Within one
  group, consecutive messages to the same member share To and From. Take two
  relay messages M1 and M2, both `unknown` to member X during a Twilio blip,
  where only M2's request actually reached Twilio:
  1. R1 (M1's reconcile) sees exactly one unheld survivor, M2's orphan. It
     rules `found` and adopts it, writing a `relaysid#` pointer that routes M2's
     SID to M1's slot.
  2. R2 then sees that SID held by another owner, drops it, finds no survivor,
     rules `never_sent` and re-drives M2.

  X receives M2 twice and M1 never; the dashboard says M1 was delivered. The
  same shape holds for two broadcasts, or a broadcast plus a 30003 retry, to
  one tenant from the business number. The spec's "two orphans ... practically
  unreachable" reasoning (D13) considers only the SAME owner.
- **Twilio's own keyword replies.** STOP / HELP / START replies are sent by
  Twilio Advanced Opt-Out from the number that received the keyword, and the
  app writes no row or pointer for them
  (`app/src/lib/smsCompliance.ts:135-147`). The reconcile's list call is
  filtered only by To and From, so such a reply is an unheld survivor.
- **System sends.** The staff cell-verification code carries only a
  `syssid#` marker (`app/src/routes/voiceApi.ts:268`). D13 checks only `sid#`
  and `relaysid#`.
- **This branch's own `sent_unrecorded` legs (D7a).** A relay leg whose
  pointer write failed is, by construction, sent and unheld: a ready-made
  wrong candidate for the member's next ambiguous leg.

With round-1's body-match requirement, every case above was rejected. The
revision fixed the Smart Encoding false negative by creating a false positive.

**What it implies.** A double text plus a silent loss, via the spec's own rules,
in the scenario the brake (D9) was designed for, while Sec 1 guarantee 1 says
"Residue: none accepted". The rule needs three outcomes, not two:
- body match: `found`;
- no survivor: `never_sent`;
- one or more survivors, none matching the hash: `unresolved` (or a
  normalized comparison that tolerates Smart Encoding), never `found` and
  never `never_sent`.

The owner check should also include `syssid#`.

---

## R2-3 [HIGH] `retrySend` has no slot, so D11's conditional writes have nothing to condition on; Sec 8 test 3 contradicts D16

**What is wrong.** D11's whole idempotency mechanism is "the slot's current code
is the condition" plus "a check records its number on the slot". D16's last
paragraph: `retrySend` "has no slot and no pass". The retrySend chain's only
state is a `deferred` flag in the PAYLOAD. A payload is copied by every
duplicate, so it dedupes nothing. A duplicate reconcile delivery (standard
queue, `infra/modules/jobs/main.tf:34-42`) then produces two `never_sent`
re-enqueues of the rung, each with a fresh jobId. Each clears its own marker
(`app/src/jobs/retrySend.ts:129-146`) and sends: a double text on the 1:1 path.
Sec 8 test 3 meanwhile expects `retrySend`'s failing recipient to be left
"`queued`/`send_unconfirmed`". There is nothing to leave in that state; the
original row is `undelivered`, and the new row does not exist
(`retrySend.ts:112-120`, `:200-229`).

**What it implies.** The spec must name the durable state the 1:1 chain
conditions on (e.g. a conditional attribute on the ORIGINAL message row keyed by
the rung) before D11 can be claimed for it. Otherwise retrySend's re-enqueue
reopens the double text D11 was written to close.

---

## R2-4 [HIGH] The re-drive reads its skip-decision snapshot eventually consistently, immediately after the flip, so D8 can make it skip its own recipient and strand it

**What is wrong.** D16: flip `send_unconfirmed` -> `send_redrive`, then enqueue.
D8: "every send site skips [a `send_unconfirmed` slot] exactly as it skips a
terminal slot". The re-drive pass decides on a snapshot read at pass start:

- broadcast: `broadcasts.getById` (`broadcastFanOut.ts:246`), a plain
  GetCommand, eventually consistent (`app/src/repos/broadcastsRepo.ts:403-406`;
  the repo itself says so at `:676-680`);
- relay: `listByConversation` with no consistent flag
  (`relayFanOut.ts:786-790`), then `readVersionedSource` -> `getByTsMsgId`, also
  a plain GetCommand (`app/src/repos/messagesRepo.ts:3097-3102`).

An immediate SQS enqueue can deliver within milliseconds. A read that lags the
flip still shows `send_unconfirmed`, so the pass skips the recipient, sends
nothing, and ends. The slot is left `send_redrive`, which nothing will ever
list again, and (D16a) the broadcast never finalizes. The codebase has recorded
this exact failure: the relay retry job reads consistently because "an eventually
consistent read would intermittently see the pre-write state"
(`app/src/jobs/relayRetryLeg.ts:361-364`), and `getByTsMsgIdConsistent` exists
because "a stale slot read drops the claim silently and load-dependently"
(`messagesRepo.ts:1387-1392`).

The same staleness runs the other way for D8's promise that "a duplicate pass
inside the window cannot re-send it". A concurrent duplicate relay pass whose
snapshot predates the `send_unconfirmed` write still sends. The broadcast
snapshot is taken once, up to about 13 minutes before the pass reaches a
recipient in an 800-recipient pass at the documented ~1/s token pacing.

**What it implies.** The skip decision for a reconcile-owned slot must be made
on a consistent read of THAT slot immediately before the send. Alternatively,
the re-drive payload can carry a token that authorizes sending a
`send_unconfirmed`/`send_redrive` slot. As written, D8 plus D16 strands the very
recipients the re-drive exists for.

---

## R2-5 [HIGH] `never_sent` rests on list order and a one-page bound the spec itself marks UNVERIFIED, yet guarantee 1 claims "Residue: none accepted"

**What is wrong.** `never_sent` is inferred from ABSENCE in one page of a
To+From list (D17: "newest first, bounded to one page"). D17 then says list
order and the page bound are "UNVERIFIED against real Twilio until the first
hosted run". Reviewer B r1 #15 raised the ordering half: the list sorts on
DateSent, and where a created-but-unsent (`queued`/`accepted`, null DateSent)
message falls is unknown. The adjudication row for A15/B15 answers only the
body-hash half; the ordering half was dropped. The spike
(`research/spike-twilio-idempotency-output.txt`) observed only messages that had
already reached `sent`/`delivered` 2 seconds after creation. A Twilio backlog,
the likely companion of timeouts, is exactly when an orphan sits queued with no
DateSent. A pair with deep history (a pool number and an active relay member;
the business number and a long-running tenant) can push such an orphan off
page 1. That reads as `never_sent`, the recipient is re-driven, and the orphan
then sends too.

**What it implies.** Guarantee 1 must list this residue, or the re-drive arm
must not ship on it. A mechanical guard is available: if the page came back
full and its oldest entry is still inside the window, absence is not proven,
and the result must be "keep checking" or `unresolved`, never `never_sent`.

---

## R2-6 [HIGH] D7a's `sent_unrecorded` leaves a KNOWN-sent recipient non-terminal for ever: the broadcast can never finalize, and the slot stays re-sendable, while the spec already builds the repair (known-SID adoption) and refuses to use it

**What is wrong.** On a RECORD-phase failure D7a leaves the slot "as it was
(usually `queued`, no code) for the future sweeper". The provider SID is in hand.
Consequences the spec does not state:

- **Broadcast.** D16a finalizes only when no slot is non-terminal, so one
  DynamoDB blip on one of 800 slot writes keeps the broadcast `sending` for
  ever. That is the anchor issue's headline symptom. The webhook cannot heal
  it: `rollIntoBroadcast` matches by `conversationId`+`tsMsgId`, which the
  failed slot write never stored (`routes/webhooks/twilio.ts:3587-3610`).
- **Relay.** The slot stays `queued` with no `sentAt`, which by design never
  escalates to "not confirmed" (`dashboard/src/routes/contact/deliveryStatus.ts:213-240`).
  If the pointer write failed, receipts are dropped. The member reads
  "Sending..." for ever.
- **Re-send exposure.** A plain `queued` slot is sendable by every send site
  (D8 protects only `send_unconfirmed`). The known duplicate relay producer
  (overlapping `relayQueuedMessages` flushes,
  `docs/issues/relay-fanout-active-pass-cap-close-race.md`) re-sends it. Guarantee
  1 says no residue.
- **The header is overstated.** It claims `accepted-send-lost-when-append-fails`
  piece 2 is "built for the adopted callers". The relay legs are an adopted
  caller and get only piece 1 (an ERROR line).

The spec already specifies exactly the machine that completes a send whose SID
is known: D13 "Known SID: fetch ... `found`", D15 adoption with the owner's
full success-path writes, conditional and retried. D3a/D7a forbid using it
("never reconciled").

**What it implies.** Route a RECORD-phase failure with a SID to a known-SID
reconcile. This is not classification, so D3a's double-text concern (a lookup
dropping a held SID) cannot arise: the known-SID path never lists. The spec
should also name the finalize and re-send consequences of whatever residue
remains.

---

## R2-7 [MEDIUM] `SendAcceptedNotRecordedError` has no arm: D3a/D7a say "never reconciled", D12/D13 say "reconcile with the known SID", and Sec 4 says neither

D3 defines the error. D12 and D13 imply it goes to reconcile ("the provider SID
when one is known"). D3a says a post-send bookkeeping failure is never
classified or reconciled. For broadcast and 1:1 the append runs inside
`sendMessage`, which is the SEND phase, yet D1's three kinds do not cover it.
Sec 4 (D5-D7) and the retrySend "send-time kinds" list (`rejected` /
`retryable` / `unknown`) never say what a caller does with it: what the slot
reads, whether a reconcile is enqueued. The same physical event, Twilio
accepted and our record failed, gets opposite treatment depending on whether
the record write lives inside `sendMessage` (broadcast: reconcile) or after
the adapter call (relay: `sent_unrecorded`, never reconciled). If it does go to
reconcile and the fetch fails on every check, D13 rules `unresolved` and D20
tells staff "Twilio couldn't be reached to confirm whether this text went out".
That is false: Twilio accepted it and returned a SID.

## R2-8 [MEDIUM] The single `unresolved` copy is false for most of the ways a slot becomes `unresolved`, and Sec 1 lists only one cause

Sec 1 guarantee 3 names one residue: "the provider unreachable for the whole
window". The spec writes `unresolved` in at least six places:

1. every check threw (D13): the copy is TRUE;
2. a digest mismatch after a phone change (D12): Twilio WAS reachable;
3. the pass's reconcile enqueue threw (D7): no lookup was ever tried;
4. an enqueue inside the job threw, the hop limit or the queue (D13a),
   including right after a `never_sent` verdict, where we KNOW nothing was
   sent;
5. a second `unknown` on a `send_redrive` slot (D13a), where no lookup is
   attempted at all;
6. a known SID whose fetch failed (R2-7), where we know it WAS sent.

D20 renders all six as "Twilio couldn't be reached to confirm whether this text
went out", with `isFailure: false` and no Retry. Case 4 is a recipient we
proved never received the text: it should be offered a Retry, and is not.
Either split the terminal code (or its reason) by cause, or at minimum move
case 4 to `failed` with a retry-able code and case 6 to an adoption.

## R2-9 [MEDIUM] An adopted broadcast slot with a carrier-`sent` status is never stamped `carrierSentAt`, so it reads "Sending..." until a DLR that may never come

Reviewer B r1 #7 (third bullet) asked for this. The adjudication (A4/B7)
answered only the known-SID and `queued` bullets. On the success path, the
carrier's `sent` receipt stamps `carrierSentAt`
(`routes/webhooks/twilio.ts:3619-3645`). Without it, `deriveBroadcastStats`
counts the slot as `sending` (`broadcastsRepo.ts:233-243`). By D19's own
statement that receipt was dropped before adoption. D15 maps any non-terminal
status to `sent` with no stamp, so the row and the Sending chip stay put until a
`delivered` receipt arrives, which is for ever on carriers without delivery
receipts. Adoption of a provider `sent` should stamp `carrierSentAt`.

## R2-10 [MEDIUM] D15's "inbox touch" reopens a closed thread and rolls the inbox back to a minutes-old message

`touchLastActivity` sets `status = open`, `last_activity_at = ts` and the
preview unconditionally (`app/src/repos/conversationsRepo.ts:1563-1592`).
Adoption happens up to about 4 minutes after the send (D13a's third check). A
staff close in between is reopened. A tenant reply in between loses its
preview, and the thread's `last_activity_at` moves BACK to the provider's
creation time, dropping it in the inbox ordering. The relay retry job met the
same problem and uses `touchLastActivityPreservingStatus` with no preview,
because "the preview belongs to the thread's NEWEST message"
(`app/src/jobs/relayRetryLeg.ts:602-610`). D15 prescribes the plain touch.

## R2-11 [MEDIUM] D15's "fan-out's OWN failure arms (30005/30006 flag the contact unreachable)" does not exist on relay, and on an MMS leg it recreates the prod false positive

Only the broadcast arm flags `sms_unreachable` at send time, and its own comment
says that is safe ONLY because every broadcast leg is SMS
(`broadcastFanOut.ts:525-536`). The relay fan-out has no 30005/30006 arm
(`relayFanOut.ts:1409-1447`), and the relay receipt branch of the webhook flags
nothing (`routes/webhooks/twilio.ts` relay branch, about 2560-3140; no
`setFlag`). D15 states the rule generically. D17's return shape carries no
media or transport fact. A builder applying it to an adopted relay MMS leg
that failed 30005 flags a working mobile unreachable: the 2026-08-24 incident
the TODO at `broadcastFanOut.ts:525` warns about. Scope the rule to broadcast
(SMS) adoptions.

## R2-12 [MEDIUM] D16a's `failed` rule is defeated by any skipped recipient, which a real audience always has

D16a finalizes `failed` only when "every recipient is `failed` or unconfirmed".
Skip arms produce `skipped` for opt-outs, the unreachable and no-consent
(`broadcastFanOut.ts:381-406`), and so does every `SendRefusedError`
(`:491-503`). A real tenant audience always contains some. So the outage
broadcast B19 described (the braked remainder `transient_cap`, a few
`unconfirmed`, zero confirmed sends) still finalizes `sent`. The accepted fix
works only on synthetic audiences. The rule should ignore `skipped`: `failed`
when no recipient reached `sent`/`delivered` and at least one was failed or
unconfirmed.

## R2-13 [MEDIUM] Contest of A13 (REJECT): the rejection's premise is refuted by D13a, and re-drives steal rungs from the main ladder

The adjudication rejects a separate re-drive budget because "a re-drive outside
the cap is an unbounded retry", citing "retry-counter D3: passes are lockstep".
Revision 2's own D13a bounds re-drives to "At most ONE ... per recipient", so a
re-drive outside the shared counter is bounded by the audience size. Re-drives
are also not lockstep passes: each is a one-recipient pass that takes a rung
from the ONE per-broadcast counter (`broadcastsRepo.ts:650-690`, cap 3 at
`broadcastFanOut.ts:80`; the relay counter is per source).

Concretely, a large broadcast's first pass runs for many minutes at ~1/s
pacing. `never_sent` verdicts land about 4 minutes after their attempts, WHILE
that pass is still running. Each re-drive claims the next rung. When the first
pass ends, its continuation for the recipients deferred by 20429 finds the
ladder capped and closes them all `transient_cap` with no retry at all (close B,
`broadcastFanOut.ts:345-349`). Even without that, three `never_sent`
recipients on one broadcast get at most one re-drive between them. The
cost of this rejection lands on recipients who have nothing to do with the
reconcile. I maintain the finding: give re-drives their own bound (D13a's one
per recipient already is one) and keep them off the shared counter.

## R2-14 [MEDIUM] The failure-handling writes themselves can fail, and the spec says what happens for none of them, least of all the D7 write that D11 conditions on

D7a promises "Nothing in any phase throws out of the loop", but covers only
failures of the phases. The arms' own writes are unassigned: D5's `failed`
write, D6's `queued` deferral write, D9's brake deferrals, and above all D7's
`send_unconfirmed` write. A DynamoDB fault on the send phase is plausibly
still present a millisecond later on these writes. If the D7 write fails:
- enqueueing the reconcile anyway leaves a chain that can never win D11's
  condition ("only if the slot still reads `send_unconfirmed`");
- not enqueueing strands the recipient.

Either way the slot is a plain `queued` slot. D8 does not protect it, a
cap-close can stamp `transient_cap` over a text that may have gone out, and
Sec 8 tests none of it. State the rule. For example: always enqueue, and let the
first check claim from `queued`/no-code under a condition.

## R2-15 [MEDIUM] Dropping `sentAt` from the D7 write (A24) makes every stranded relay leg invisible: a `queued` leg with no `sentAt` never escalates

A24's fix was right about the field's contract, but it removed the only clock
the dashboard could age a stranded leg on. `stalenessClockMs` returns NOTHING
for `queued` without `sentAt`, deliberately
(`dashboard/src/routes/contact/deliveryStatus.ts:213-223`, `:238-240`). So a
relay fan-out leg stranded in `send_unconfirmed` shows "Sending..." for ever
and never "Queued - not confirmed". The stranding causes are the D14 crash
window, a dead-lettered reconcile, R2-1, R2-4 and R2-14. D20 blesses this ("renders
exactly as a queued slot renders today"). The attempt start belongs on the slot
under a non-provider field name (e.g. `unconfirmedSince`), so the leg can
escalate to "not confirmed". Relay retry rungs are unaffected (the join falls
back to the row's `at`, `relayRetryJoin.ts:193-197`); fan-out legs are not.

## R2-16 [LOW] `closeBroadcast` finalizes unconditionally; D16a's check has to live inside `finalize`, not in the callers it names

`closeBroadcast` ends with `await finalize(...)` (`broadcastFanOut.ts:310`) for
closes A, B and C. D16a puts the "anything still open?" check on "the pass, a
continuation, a verdict handler". A re-drive's close B that finalizes without
the check marks the broadcast terminal while other recipients are still in
reconcile. The terminal status is then decided on partial data: `sent` for a
broadcast that ends all-unconfirmed. Put the consistent-read check inside
`finalize`.

## R2-17 [LOW] New relay outcome kinds fall through the relay retry job's catch-all as "ended terminally" ERRORs with a `failed` emit

The retry job's outcome switch treats every kind other than `sent`, `transient`
and `skipped_terminal` as terminal. It logs "retry leg ended terminally at the
send" at ERROR and emits a root close with `deliveryStatus: 'failed'`
(`app/src/jobs/relayRetryLeg.ts:600-702`). D7a adds `sent_unrecorded`, and D7
needs an outcome for "handed to reconcile". Both would log a false terminal
ERROR, which feeds the error-log alarm, and announce a failure. That switch
should be enumerated as a reader.

## R2-18 [LOW] Sec 8's e2e still expects "a later receipt routed to it", which D19 and the adjudication say cannot happen

The fake fires callbacks at 0/150/300 ms (`fake-twilio/src/engine/delivery.ts:29-31`).
D19 says they all precede adoption. The adjudication (B21) moved the late-receipt
proof to integration level. The e2e text (Sec 8, `accept_then_drop`) was not
updated.

## R2-19 [LOW] D13a's hop arithmetic misses the deepest producer (8, not 7)

`relay.numberReady` runs as a job (enqueued from the Twilio events webhook,
`app/src/services/poolNumbers.ts:665`). It flushes queued relay messages as
`relay.fanOut` at hop 2 (`app/src/services/relayQueuedMessages.ts:93`). Pass (2),
two continuations (4), three checks (7), re-drive (8). Still inside 10, but the
stated worst case is wrong and the margin is 2, not 3.

## R2-20 [LOW] Smaller inaccuracies in the revised text

- D15: "maps to the slot's `sent` exactly as the success path maps it". The
  relay success path keeps `queued` for a provider `queued`
  (`relayFanOut.ts:1455`). The 1:1 path persists `mapTwilioStatus`'s `queued`
  (`app/src/services/sendMessage.ts:416`). Only broadcast maps to `sent`.
- D12: "re-reads the recipient's CURRENT number from ... the retry row". The
  retry row stores only the digest, by design (`relayRetryLeg.ts:534-537`); the
  number comes from the roster. The digest form "the relay retry claim already
  uses" is keyed by a `rootTsMsgId` (`app/src/lib/relayRetryClaim.ts:25-30`),
  which broadcast and 1:1 owners do not have.
- D21 still keys K's exclusion on "`failed` slots". The join's projection gives
  the root leg its own `undelivered` status with the rung's code
  (`relayRetryJoin.ts:405-415`), so D20 and D21 disagree about the key.
- D7a's RECORD row lists "the token acquire". It is pre-send on relay
  (`relayFanOut.ts:1360`) and never throws. It also lists the milestone and
  listing-send rows, which are best-effort and swallowed today
  (`broadcastFanOut.ts:453-489`). Under D7a they would emit a false
  `sent_unrecorded` ERROR for a recipient whose slot WAS written.
- Sec 9 (r2) silently dropped r1's "`messaging.retrySend`'s remaining throws".
  The presign (`retrySend.ts:164-166`) and the original read (`:112`) still throw
  under the marker. They are no longer handled or filed.

---

## Adjudications contested or conceded

| finding | ruling | response |
|---|---|---|
| A13 | REJECT | CONTESTED - R2-13 above. |
| A5 (phone in owner keys) | not new exposure | CONCEDED. Broadcast and relay continuation payloads already carry `phone#` keys (`broadcastFanOut.ts:606-612`, `relayFanOut.ts:1196`). D12's "never a recipient phone in the clear" wording should admit it. |
| A17 | ACCEPT | PARTLY CONTESTED - folded into R2-6. The relay legs are an adopted caller and get only piece 1. |
| A19 (second half), A22, A23 | DEFER / residue | CONCEDED; each is filed or stated. |
| B7 third bullet, B15 ordering half | not answered in the table | RAISED as R2-9 and R2-5; the adjudication rows address only the other halves. |
| B20 first bullet (absence over a bounded window) | "Sec 1 names the residues" | CONTESTED - guarantee 1 still says "none accepted" (R2-5). |

## Fixes checked and found sound (for the record)

- D1's status-first rule and test 1's 5xx-with-code case: correct against
  `node_modules/twilio/lib/base/RestException.js:9-15`.
- D16a's liveness: slots only move non-terminal -> terminal or terminal ->
  terminal (the webhook's rollup moves only `sent` slots in practice), so the
  last terminal writer's consistent read sees all terminal. This is sound once
  R2-16 is addressed.
- D4, D9 (brake on `unknown` only), and B14's 60-second window: sound on their
  own terms. But the window widens R2-2's exposure.
