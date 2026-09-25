# Send-outcome classification and reconcile - design

Anchor issue: `throw-for-redelivery-defeated-by-job-marker` (high).
Branch `feat/send-outcome-reconcile`, cut from `main@685f2ede`, 2026-09-24.
Revision 6 (after design review rounds 1-4 and the 2026-09-25 cross-branch
sequencing with `feat/retry-send-window` and `feat/share-skip-fix`; see the
adjudications and Sec 2a).

| sev | issue | this branch |
|---|---|---|
| high | `throw-for-redelivery-defeated-by-job-marker` | **closes** for both fan-outs and the relay retry rung; the 1:1 retry job (`retrySend`) is adopted in the post-RSW work (Sec 2a, Sec 9) |
| med | `accepted-send-lost-when-append-fails` | piece 1 (the typed error) **built**; piece 2 **built for the adopted callers** - `missedCallAutoText`, its production path, and `retrySend` are later work (Sec 9) |
| low | `exactly-once-send-intent` | **substantially built** - the per-recipient send-attempt record (D8a) IS the durable intent that issue sketches, for the adopted callers |

**This document states DECISIONS and INVARIANTS.** Mechanics - control flow,
where a line goes, exact backoff values, key shapes, test seams - belong to
the plan. Review history, adjudications and rejected alternatives are in
`docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/design-review/`.

## 1. The invariant, stated with its scope

Three guarantees, each with the mechanism that delivers it and the residue it
leaves:

1. **Nobody is texted twice by this branch.** Every send site claims the
   recipient on its send-attempt record before calling the provider (D8a), so
   two passes, two continuations or two re-drives for one recipient produce
   one send; a re-drive is attempted only after a verdict that nothing was
   sent (D13); the verdict never adopts a message it cannot identify as ours,
   and never lets two attempts adopt the same message (D13). Residue: an
   orphan the provider lists beyond the bounded page walk (D13) is ruled
   `unresolved`, not `never_sent`, so even that residue re-sends nothing.
2. **A recipient whose provider send was attempted reaches a terminal state
   without anyone throwing out of the loop.** The per-recipient unit is split
   into prepare / send / record phases and each phase has a defined failure
   handling (D7a); the reconcile job's own failures are genuine retries (D11)
   and end in a verdict (D13a). Residue, recorded not closed: a process death
   between a claim or an ambiguous send and the enqueue that follows it (D14);
   a failure of the per-PASS setup before any recipient is attempted (Sec 9);
   a failure-arm write that itself fails (D7a). Each leaves a slot
   non-terminal with an open attempt record and an attempt clock, which is
   what the Stage 2 sweeper will read (Sec 9).
3. **An outcome the provider left ambiguous is resolved by the platform.** The
   reconcile job looks the message up at the provider and either adopts it or
   rules it never sent (D13, D15). Residue: the provider unreachable for the
   whole window, or a message in the window we cannot identify as ours
   (`unresolved`, one ERROR naming the cause, presented honestly - D20);
   receipts that arrived before adoption were dropped by the fenced webhook,
   so the adoption reads the provider's current status instead (D15).

Today both fan-outs handle a per-recipient send error they do not recognise by
throwing, so that SQS redelivers the envelope. The redelivery carries the SAME
`jobId`; the per-job execution marker suppresses it; the suppressed run returns
successfully and the consumer deletes the message. Nothing is retried, the DLQ
is never reached, the throw exits the recipient loop so every later recipient
is never attempted, and the only trace is one `job failed` ERROR line that no
alarm reacts to.

"Unrecognised" is not an edge case. The codes the fan-outs recognise today are
30007, 30005/30006 and the transient pair 429/30022 - and 30007, 30005/30006
and 30022 are codes Twilio reports asynchronously in delivery receipts, not at
send time. Twilio's send-time rejections (e.g. 21211 invalid number, 21610
unsubscribed), its rate-limit response (20429, which twilio-node exposes as
`code: 20429`, so the fan-outs' check for `429` never matches it), transport
failures (timeout, dropped socket) and Twilio 5xx all take the throw. So do the
non-provider failures inside `sendMessage`: a database read before the provider
call, and the row write AFTER Twilio has accepted the message. One bucket holds
"definitely not sent", "may have been sent" and "definitely sent".

Spike-verified against the real dev account (2026-09-24; outputs in the
review directory's `research/`): Twilio ignores an `Idempotency-Key` header
on message creation (same key twice = two SIDs, two texts), so a blind retry
is never safe; the Messages list filtered by `To`+`From` lags creation by 1-2
seconds; its `DateSent` filter is on SEND time (returned nothing for a
just-created message); `date_created` has one-second resolution; and the
Messaging Service has Smart Encoding ON, so the STORED body of a message
containing a curly quote, an em dash or an ellipsis is the re-encoded one
(`'`, `-`, `...`) in both the fetch and the list, while the create response
echoes what was submitted. All of these shape Sec 5.

## 2. Scope

**In:**

- `app/src/adapters/messaging.ts` - the send-failure classifier (D1-D4), the
  `listMessages` and `getMessage` port methods (D17), the throttle marker (D4).
- `app/src/services/sendMessage.ts` - typed send errors (D3).
- `app/src/jobs/broadcastFanOut.ts`, `app/src/jobs/relayFanOut.ts`
  (`sendOneRelayLeg` and the fan-out loop), `app/src/jobs/relayRetryLeg.ts` -
  the adopters (Sec 4). NOT `app/src/jobs/retrySend.ts`: its adoption moved to
  the post-RSW work (Sec 2a); it keeps today's behavior on this branch.
- A new `send.reconcile` job (Sec 5) and its per-owner verdict handlers.
- `app/src/repos/messagesRepo.ts` - the send-attempt record (D8a) and a
  conditional `relaysid#` pointer put (D13); `app/src/repos/broadcastsRepo.ts`
  - idempotent finalize (D16a), the stats bucket (D22), `attemptedAt` on the
  slot (D8a).
- `fake-twilio` - the Messages list and fetch routes and a fail-next-send
  control seam (D19).
- Dashboard: `dashboard/src/routes/contact/deliveryStatus.ts`,
  `dashboard/src/routes/contact/relayRetryJoin.ts`,
  `dashboard/src/routes/broadcasts/*` (copy and the new stats bucket), the API
  types those read, the `broadcast.updated` event type, and the two seed files
  that build broadcast stats (Sec 7).

**Out - hard fences (the interaction is stated; nothing is fixed):**

- `routes/webhooks/twilio.ts` in its entirety. A status callback for a SID we
  do not yet hold is still dropped there at ERROR - up to three lines per
  orphan until adoption, which a burst of orphans can turn into a
  `hc-<env>-error-logs` page. The webhook's failure side effects (the 30003
  retry ladder, 21610 suppression bookkeeping, placement attention, the
  delivery-failed metric) do not run for a receipt that was dropped; adoption
  records the terminal status honestly and WARNs (D15). The passive match
  (unknown-SID callback resolves a pending reconcile) is the follow-up that
  closes both.
- `relay-fanout-active-pass-cap-close-race` (deferred, same file): this branch
  adds the attempt record and the reconcile job as writers but does not touch
  the pass claim. Every close this branch owns refuses a recipient with an
  open attempt (D8), which narrows that race's damage without closing it.
- `fanout-close-path-robustness-residues`: the close loops stay unwrapped; a
  failure-arm write that itself fails (D7a) is that issue's "throwing close"
  class one step earlier and is added to it.
- `relay-retry-stranded-claim-window`: the crash windows D14 records are the
  same class; recorded, not closed. The sweeper that closes both is Stage 2.
- `provider-status-unenumerated-defaults`: `mapTwilioStatus` is used as-is by
  the adoption write (D15).
- The continuation ladder's timing (retry-counter D7/D11): its 5/10/20s backoff
  spans about 35 seconds, so an outage longer than that spends the whole ladder
  and a transient outcome after it closes `transient_cap`. Honest, but short;
  not changed here.
- The nine other claim-then-throw sites found by the 2026-09-24 sweep (Stage 2,
  Sec 9). Each is filed as its own issue by this branch; none is edited.
- Any change to the run-once marker, `jobs.ts` (including `MAX_HOP_COUNT`), or
  the SQS consumer.

## 2a. Sequencing with the two sibling branches (ruled 2026-09-25)

Three branches touch the same objects. The agreed order, and what this branch
carries because it lands after the other two:

1. **`feat/share-skip-fix` Branch A** merges first (census, fix script,
   import default, skipped-recipient reasons and honest counts). Its interim
   "Already sent" rule counts every failed-class slot as sent - including this
   branch's `failed` + `send_unconfirmed` - which is the safe direction and
   needs no cross-branch rule. Its stats bucket and internal codes will
   conflict textually with D22 and D23 in `deriveBroadcastStats`, the
   StatChips balance rule and the delivery-reason map; this branch's one
   main-sync before handback resolves them.
2. **`feat/retry-send-window` (RSW)** merges second. **This branch's PLAN is
   written after that merge**, because RSW restructures the same relay retry
   rung this branch adopts. Requirements RSW states on any later path, carried
   by this branch's plan brief:
   - RSW #1: a rung this branch re-drives runs the same job handler, so RSW's
     job-time window check bounds it. The re-drive adds no bypass.
   - RSW #5: RSW's bounded token acquire CAN time out, and for a relay retry
     rung that timeout is TERMINAL (`retry_window_closed`), never `retryable`.
     D7a's PREPARE rule therefore has one named exception: a window deadline
     is a close, not a deferral.
   - RSW #6: RSW's window checks run BEFORE this branch's claim, so a decline
     never holds a claim; RSW's window close in the relay job is a close by
     another writer and follows D8's gate. If the plan places the acquire
     after the claim, the timeout finishes the attempt record as a terminal
     non-send, so the record's outcome vocabulary (D8a) gains
     `window_closed`.
   - RSW #7: both branches edit the retry join's terminal step
     (`relayRetryJoin.ts`); this branch's "Not confirmed, not a failure" for
     `send_unconfirmed` and RSW's "no display code" for `retry_window_closed`
     must both survive the merge, each with its test.
3. **This branch** (Stage 1) merges third.
4. **After it:** the `retrySend` adoption (which carries, for the one-to-one
   retry, RSW #1 and #6 - a re-driven rung runs the same handler so the
   job-time window check bounds it, and the window checks run before the
   claim - plus #2, #3 and #4 - lineage on an adopted retry row,
   `retry_due_at` refreshed while a 1:1 outcome is pending, the promise copy
   following `retry_due_at` - and closes the joint gap RSW records as
   `manual-retry-double-send-residual-windows`),
   and share-skip-fix's Branch B (the counted-as-sent attempts rule), both
   planned on this branch's attempt record rather than a second one.

## 3. Decisions: classification at the send boundary

**D1. Every failure of a provider send is classified into exactly one of three
kinds, by a pure function with no I/O that reads BOTH the HTTP status and the
code:**

| kind | meaning | rule |
|---|---|---|
| `rejected` | Twilio answered and refused; nothing was sent | HTTP status 4xx, any code except 20429 (21211, 21614, 21610, 20003, 30034 ...); the adapter-level kill-switch error (`SmsSendingDisabledError` in `adapters/messaging.ts`) |
| `retryable` | nothing was sent, and trying again later is safe | HTTP 429 or code 20429 (Twilio: "not processed, safe to retry"); the legacy `429` / `30022` tokens; a connection that never opened (ENOTFOUND, ECONNREFUSED, EAI_AGAIN) |
| `unknown` | the request may have reached Twilio; a message may exist | HTTP 5xx regardless of code; timeout (ECONNABORTED, ETIMEDOUT); dropped socket (ECONNRESET, EPIPE); any error the rules above do not place |

Status is consulted first (a 5xx carrying a Twilio code is still `unknown`),
then the code, then the network code. 30007 stays `rejected` if it ever
arrives at send time (it never has; it is a receipt code) and keeps its
never-retry meaning.

**D2. `unknown` is the default.** An error the classifier cannot place is
`unknown`, never `rejected`: a text that went out and is marked failed invites a
manual resend, which is the double-text the marker exists to prevent. The cost
of a wrong `unknown` is one reconcile.

**D3. `sendMessage` (the 1:1 send service) throws TYPED errors that carry the
facts a reconcile needs, instead of the bare provider error:**

- `SendNotAttemptedError` - a failure BEFORE the provider call (the conversation
  read, the contact read, the breaker increment). Nothing was sent. Classified
  `retryable`.
- `ProviderSendFailedError` - the provider call threw. Carries the D1 kind, the
  code, and the reconcile facts: the recipient number's keyed digest, the
  sender, the normalized body hash and media count (D13), the attempt start.
- `SendAcceptedNotRecordedError` - Twilio accepted the message and the row
  write (`append`) failed. Carries the provider SID, provider timestamp and
  status. This is `accepted-send-lost-when-append-fails` piece 1; D7a says
  what an adopter does with it.
- Failures AFTER the row is written (the inbox touch, the audit row, the SSE
  emits) no longer fail the send: they are logged at ERROR and the send returns
  its normal result. The text is out and recorded; reporting it as failed was
  the falsehood. This is a deliberate behavior change for every caller,
  including the staff send route, which now answers 201 where it answered 500.

`SendRefusedError` and its subclasses are unchanged. Callers that catch nothing
new behave exactly as today for the first three (the new classes still extend
`Error`).

**D3a. Classification applies to the SEND phase only.** The classifier is
applied to the provider call (relay) or to `sendMessage`'s typed errors
(broadcast, 1:1). A failure in the owner's OWN post-send bookkeeping - the
recipient slot write, the stats bump, the SID pointer - is never classified as
`unknown`: those run after the send is known to have happened, its SID is in
hand, and D7a hands the recipient to the reconcile job WITH that SID. This is
the rule that stops a database blip after a delivered text from being read as
"never sent".

**D4. 20429 joins the throttle metric.** The adapter's `send_throttled` marker
fires on 429, 20429 and 30022 only - today a real Twilio rate limit is
invisible to the `SendThrottled` alarm because the marker checks `429` and
`30022`. Connection failures are `retryable` but are not throttles and do not
fire it.

## 4. Decisions: what a send site does

Applies to `broadcastFanOut` and `sendOneRelayLeg` (and therefore both the
relay fan-out loop and the relay retry rung). `retrySend` is not adopted on
this branch (Sec 2a).

**D5. `rejected`: mark the recipient `failed` with the provider code, continue
to the next recipient.** The existing 30007 and 30005/30006 arms keep their
extra behavior (never retry; flag the contact unreachable). On the relay path
the adapter-level kill-switch is recorded with the existing token
`sms_sending_disabled`; on the broadcast path `sendMessage` already refuses
it earlier as a `SendRefusedError`, and that recipient stays `skipped` as
today.

**D6. `retryable`: defer the recipient to the existing continuation, continue.**
The recipient is written `queued` with the code, joins the same
`transientRemaining` set the 429/30022 arm uses, and rides the same ladder with
the same cap (`MAX_BROADCAST_ATTEMPTS` / `MAX_FANOUT_ATTEMPTS`, unchanged) and
the same backoff. A ladder that runs out closes `transient_cap` as today.

**D7. `unknown`: hand the recipient to the reconcile job, continue.** The site
transitions the attempt record to `reconciling` (D8a; the record already
holds every fact the job needs), THEN enqueues one `send.reconcile` job for
that recipient (Sec 5), and moves on. The slot is not written: it stays
`queued` with no code while the reconcile runs, and only a verdict writes it
(D16). The pass never waits for the verdict. The order is deliberate: the
record is the coordination state and it is durable before anything depends on
it; an enqueue that throws transitions the record to `done` / `unresolved`
and closes the slot the same way (the D9 precedent from the retry-counter
design).

**D7a. The per-recipient unit has three phases, and each phase fails
differently.**

| phase | what runs | on failure |
|---|---|---|
| PREPARE | reads and writes before the provider call: contact, conversation, roster suppression check, presign, the aggregation-state write, the claim itself (D8a) | nothing was sent: the recipient is deferred as `retryable` (D6), and the record - if it was claimed - is released to `done` / `retryable`; a refused claim is handled by D8a, not here. ONE exception (Sec 2a, RSW #5): on the relay retry rung, RSW's window deadline expiring during the bounded token acquire is a TERMINAL close (`retry_window_closed`; the record `done` / `window_closed`), never a deferral |
| SEND | the provider call, or `sendMessage` | classified (D1) |
| RECORD | writes after a successful send that the receipts depend on: the SID pointer (relay), the message row (`sendMessage`'s append), then LAST the slot together with the stats bump in one conditional write, then the record's `done` / `sent` | the send HAPPENED and its SID is known: `sent_unrecorded` - one ERROR line carrying the SID and the owner, then the record goes to `reconciling` WITH the SID and a reconcile is enqueued (D13's known-SID path), whose adoption re-runs those writes idempotently; the loop continues. The token acquire, the milestone and listing-send rows and the SSE emits are best-effort and stay so |

A failure-arm write (the D5/D6/D7 writes) that itself fails is logged at ERROR
with the owner and the recipient and the loop continues; the record keeps
`attempting` and the slot keeps whatever it held. That recipient is the future
sweeper's, and Sec 1 records it. Nothing in any phase throws out of the loop.
The relay unit returns two new outcome kinds, `sent_unrecorded` and
`handed_to_reconcile`, so its callers can count them and the retry rung can
handle them explicitly.

**D8. Every close of a recipient by a writer OTHER than its own attempt
proceeds only when no attempt has claimed it.** Before writing a slot terminal
- `closeBroadcast` and `closeRelay` (the cap and enqueue-failed closes), the
relay retry job's gate refusals and the relay opt-out arm (which write the
slot before that job's own claim) - the writer reads the recipient's attempt
record with a strongly consistent PER-KEY read (a batch read that reports a
key unprocessed must be re-read, never treated as absent) and closes the
recipient only if the record is ABSENT or `done` / `retryable`. Any other
state is someone else's: `attempting` fresher than the provider timeout,
`reconciling` and `redriven` are skipped; `attempting` OLDER than the
provider timeout is taken over into reconcile exactly as a send site would
take it over (D8a), so a recipient whose release write failed still reaches a
verdict at the cap. RSW's window close in the relay retry job is such a close
and follows this gate (Sec 2a). The close's slot write is itself conditional: the slot
must still be `queued` and carry no SID, so a stale snapshot can never
overwrite a send that landed. The reconcile job's OWN closes (`unresolved`,
`enqueue_failed`, `redrive_refused`) are exempt from this gate - they close
the attempt they own - and write the slot FIRST, then the record `done`; a
redelivered close re-applies the slot write (forward-only, idempotent) before
finding the record `done`. The D9 brake defers the recipients not yet
attempted IN THIS PASS, whatever their records say.

**D8a. Every send site claims the recipient on its send-attempt RECORD before
calling the provider.** The record is a per-owner-per-recipient item in the
messages table's pointer/marker family (the exact key shape is the plan's,
under two rules: a recipient key that carries a phone - `phone#<E164>` - is
hashed before it lands in the key, as `relayRetryClaim.ts` already does for
destinations; and the item carries the 30-day `expires_at` cleanup horizon
the due rows use, cleanup only, never a semantic), written by exactly two
kinds of writer - send sites and the reconcile job -
and never by the slot's wholesale writers (`setRecipient`, `markRecipient`),
which is why the coordination state cannot live in the slot: the
retry-counter mission's D2 lesson, applied again. It holds: the owner
reference and recipient key; `state` in `attempting` | `reconciling` |
`redriven` | `done`; `attemptNo`; `attemptedAt`; `redriveCount`; `checkNo`;
`sid` once known; `outcome` (`sent`, `rejected`, `retryable`, `adopted`,
`never_sent`, `unresolved`, `enqueue_failed`, `redrive_refused`, and
`window_closed` for RSW's terminal decline - Sec 2a) and its `cause` when
`done`; the recipient number's keyed digest, the sender, the normalized body
hash and the media count of THIS attempt.

The claim is one conditional write:

- creates the record when absent -> `attempting`, `attemptNo` 1,
  `attemptedAt` now;
- is allowed from `done` / `retryable` (a deferred recipient's next pass) and
  from `redriven` (the re-drive pass; a duplicate re-drive that arrives
  after the first has claimed finds `attempting` and is handled by the rule
  below) -> `attempting`, `attemptNo` + 1, a new `attemptedAt`;
  `redriveCount` is never touched by a claim;
- is a TAKEOVER, not a send, from `attempting` older than the claim TTL,
  which equals the provider's 30-second timeout: the site transitions the
  record to `reconciling` keeping the old `attemptedAt` and enqueues a
  reconcile - a process died mid-send, or is still inside an unusually long
  call, and either way the outcome is unknown. A takeover of a call that
  then completes is harmless: the late outcome write fails the
  `attemptedAt` condition, and the reconcile's lookup finds the message and
  repairs the slot. The TTL is deliberately no longer than the ladders it
  must fit inside (about 35 seconds on broadcast, 15 on relay), so a stuck
  attempt is taken over at the cap rather than skipped past it;
- is refused from `attempting` fresher than the TTL, from `reconciling`, and
  from `done` with any outcome but `retryable`. A refused claim on a
  recipient a continuation carries is DEFERRED again (the recipient stays in
  the transient set for the next pass, which will find the attempt resolved,
  stale, or still fresh); a refused claim on a terminal outcome is a skip.

Every later write to the record by the same site (the D5/D6/D7 transitions
and the record-phase `done` / `sent`) is conditioned on `state = attempting`
AND `attemptedAt` equal to this attempt's, so a stale writer cannot overwrite
a newer attempt. The claim also writes `attemptedAt` onto the slot (an
additive attribute, best-effort: a wholesale slot write may erase it; the
record stays authoritative) so a stranded slot can age (D20a). Both slot types
gain the field. A `queued` slot with a SID recorded on its record can never be
claimed again, whatever the slot's status says: this is what makes a relay
success that leaves the slot `queued` safe against a duplicate.

**D9. Outage brake.** Three consecutive `unknown` outcomes in one pass end the
pass early: every recipient not yet attempted is deferred to the continuation
as if `retryable`, one WARN names the count, and the pass returns. Without it a
Twilio outage costs the 30-second SDK timeout per recipient and marks every
one of them unconfirmed. `retryable` outcomes do not count toward the brake:
they are fast and already deferred one by one. `rejected` never brakes: a
systemic 4xx (bad credentials) fails every recipient quickly, visibly and
honestly, and retrying it could not help.

**D10. No new slot STATUS values.** Every state this branch introduces is an
existing status (`queued`, `failed`, `sent`) plus a code. `deriveBroadcastStats`
switches on status with no default arm and the dashboard's status maps fall
through to "Sending...", so a new status would vanish from every chip silently.
The codes this branch writes on slots: `send_unconfirmed` (closed
unresolved), `enqueue_failed` (existing), `redrive_refused`,
`sms_sending_disabled` (existing token), and the provider's own rejection
codes. Pending states are record states, never slot codes.

## 5. Decisions: the reconcile job

**D11. `send.reconcile` is an ordinary job with a fresh `jobId` and NO run-once
marker. Its enqueues are AT-LEAST-ONCE and every write it makes is idempotent
or conditional on the attempt record, so a redelivery, a duplicate check, or
two chains for one recipient converge on one outcome:**

- Every record transition the job makes is conditioned on `state =
  reconciling` and on `attemptedAt` equal to the payload's attempt start; a
  payload for an older attempt writes nothing.
- A check records its number (`checkNo` n, allowed from n-1 or n - tolerant
  of its own duplicate) and then enqueues its successor. A redelivered check
  may enqueue a second successor; the chain is bounded at three checks (D13a)
  and every verdict is idempotent, so a duplicate chain costs a few extra
  list calls and nothing else.
- Adoption first CLAIMS the message: the `sid#` row append (broadcast, 1:1),
  which dedupes on the SID, or a conditional `relaysid#` pointer put (relay).
  A claim that loses to a DIFFERENT attempt means that message is someone
  else's; the job takes the next candidate (D13). The rest of the adoption is
  individually idempotent writes (a forward-only slot write that reports
  whether it moved; the stats bump, the best-effort rows and the emits only
  when it moved), then the record `done` / `adopted` with the SID. Re-running
  the whole adoption is safe, so a throw partway through is a genuine retry
  that completes it.
- A `never_sent` verdict transitions the record to `redriven` on the
  condition `redriveCount = 0`, incrementing it, then enqueues the re-drive.
  The enqueue may happen twice; the second continuation's claim finds
  `attempting` (fresh) or `done` and defers or skips (D8a).
- `unresolved`, `enqueue_failed` and `redrive_refused` transition the record
  to `done` and write the slot forward-only; a duplicate finds `done` and
  writes nothing.

Every condition above is evaluated by DynamoDB against the base-table item,
atomically with the write; no index is involved. Every READ that a decision
in this design rests on - the close gate (D8), the continuation snapshot
(D16), finalize (D16a), the SID-pointer checks (D13) - is a strongly
consistent primary-key read on the base table. No coordination read may go
through a GSI: a GSI is eventually consistent and cannot be read
consistently, so a decision made from one can act on a stale image.

Because nothing in the chain depends on being the single winner, a throw
inside the job is a genuine retry: five failures reach the DLQ and page
through the existing `jobs-dlq-depth` alarm. (Other jobs - media mirror, voice
transcripts, relay warm - already retry genuinely; this one joins them and
its docblock says why the marker is absent.)

**D12. The payload carries identifiers only:** the owner reference (D16), the
recipient key, the attempt start (the record's `attemptedAt`, which every
condition keys on), the check number, and the pass's continuation context
(sender key and name override for relay, so a `never_sent` verdict can
re-drive the recipient). Everything else - the recipient digest, the sender,
the body hash, the media count, a known SID - is read from the attempt record
at run time. Never a body or a recipient phone. On the LOOKUP path the job
re-reads the recipient's CURRENT number from the owner (the contact, the
roster member, the 1:1 conversation) and compares its keyed digest (SHA-256
over the owner reference and the E.164) with the record's; a mismatch is
`unresolved` - a text, if any, went to a number we can no longer look up. The
known-SID path needs no number and skips that check. (When the `retrySend`
adoption is built later, its record will key on the original message and the
retry rung; not this branch.)

**D13. The lookup, and its three verdicts.**

- **Known SID (on the record):** fetch that message by SID (D17). The verdict
  is `found`. A fetch that fails is a job failure (a genuine retry, D11),
  never a verdict.
- **Otherwise** list the provider's messages to that recipient from that
  sender (D17) at the provider's maximum page size (1000 for the Messages
  list; the driver asserts the size it asked for is the size it got), walking
  every page up to a bound of 5; a walk that exhausts the bound is
  `unresolved`. Keep the messages created inside the window:
  from 60 seconds before the attempt start (clock skew plus the provider's
  one-second resolution) to now. Exclude any candidate whose SID another
  attempt or owner already holds - a `sid#` or `relaysid#` pointer resolving
  elsewhere, or the `syssid#` system-send marker. A candidate whose pointer
  resolves to THIS owner and recipient is `found` (a repair: the send was
  recorded after all). Of the rest, a candidate is OURS only if it matches
  the record: bodies compared after a lossy normalization (Unicode NFKC, then
  letters and digits only), because Smart Encoding rewrites punctuation in
  the stored body (Sec 1); when the normalized body is shorter than three
  characters (a media-only or emoji-only message) the media count must match
  instead. The job then tries to CLAIM matching candidates oldest-first
  (D11); the first claim that wins is `found`. Two text attempts with
  identical bodies to the same member may thereby adopt each other's
  messages, which changes no delivery and no count - but two MEDIA attempts
  with the same body and media count can carry different photos, so
  swapping them is not harmless. Candidates in the window that match
  nothing (a Twilio STOP/HELP auto-reply from our own number, an orphan of
  some other send to the same recipient) are ignored on the first two checks
  and decide `unresolved` at the FINAL check only, with the cause named in
  the log - never adopted, never re-driven.
- **No claimable match through the whole window:** `never_sent` - UNLESS
  another attempt for the same recipient and sender with the same fingerprint
  (body hash and media count) is open or was adopted inside the window, in
  which case the verdict is `unresolved`: the message we would have found may
  be the one the other attempt claimed, and re-driving on that ambiguity is
  how one photo goes twice and another never.
- **Provider unreachable on every check:** `unresolved`. A provider error
  INSIDE a check is caught and counted as that check's result; only the job's
  own writes throw.

**D13a. Bounded, and budgeted against the job-chain limit.** At most THREE
checks per recipient (about 5 seconds, 30 seconds and 4 minutes after the
attempt - the first no sooner than 5 seconds, for the list lag), scheduled as
the job's own continuations (fresh `jobId`, the check number in the payload),
never an in-process sleep: the worker's 120-second visibility timeout forbids a
five-minute handler. At most ONE re-drive per recipient, enforced by the
record's `redriveCount`: a re-drive attempt whose outcome is `unknown` again
goes to `done` / `unresolved` directly, with no second reconcile, so a
`never_sent` verdict with `redriveCount` already 1 cannot arise. A re-drive
pass claims a ladder rung only if, after its loop, it has a transient
remainder to defer (its single recipient came back `retryable`); it never
claims one up front, so a spent ladder cannot close the recipient before it
is tried. Worst-case chain depth is 8 hops of `MAX_HOP_COUNT`'s 10: a relay
fan-out reached through `relay.numberReady` starts at hop 2, two
continuations (4), three checks (7), the re-drive (8). Any enqueue that
throws inside the reconcile job - the hop limit or the queue - is caught and
closes the recipient `enqueue_failed` on the spot when the verdict was
`never_sent` (the Retry offer stays: we know nothing went out) and
`unresolved` otherwise. The window is overridable for the hermetic lane only,
on the `E2E_RELAY_RETRY_BACKOFF_MS` precedent (topology-guarded on
`JOBS_QUEUE_URL`; production cannot shorten it).

**D14. The attempt record is the intent; there is no second one.** A process
death between the claim and the send, or between a record transition and the
enqueue that follows it, leaves the record `attempting` or `reconciling` with
its `attemptedAt` and nothing to resolve it. A later send site that meets a
stale `attempting` takes it over (D8a); everything else in that class is the
same crash window `relay-retry-stranded-claim-window` records, closed by the
Stage 2 sweeper, which now has a record with a clock to read. Recorded, not
fixed. An enqueue that THROWS is not a crash window (D7, D13a).

**D15. Adoption writes the message the provider already holds, the way the
owner's success path would have.** For a `found` verdict the handler reads
the message's current provider status (both paths - list and fetch - return
it) and records:

- the slot: a non-terminal provider status (accepted, queued, sending, sent)
  maps to the slot's `sent` (the broadcast success path writes `sent`; the
  relay paths keep `queued` for a provider `queued` and write `sent`
  otherwise - adoption follows each owner's own mapping); a terminal one maps
  through `mapTwilioStatus` to `delivered` or `failed` with its error code,
  so a message that already delivered adopts as delivered and one that
  already failed adopts as failed. `sentAt` (relay) and `carrierSentAt`
  (broadcast) take the provider's `date_sent` when it has one; the relay
  slot's first-write-wins rule may keep an earlier value, which is accepted.
- everything else the owner's success path writes, in this order: FIRST the
  SID claim (broadcast and 1:1 - the message row in the tenant's 1:1
  conversation with the broadcast stamp, the write `sendMessage` would have
  made, deduped on the SID; relay - the conditional `relaysid#` pointer put,
  which today swallows a conditional failure and must instead report a lost
  claim), THEN the slot (broadcast: with `conversationId`+`tsMsgId` so later
  receipts roll up), THEN, only when the slot write moved, the stats bump,
  the audit row and the SSE emits, and - only when the adopted status is
  `sent` or `delivered`, never `failed` - the `listing_sent` milestone and
  the "Properties sent" listing-send row (a message the carrier says never
  arrived must not count as a property sent; share-skip-fix's Branch B builds
  its counting rule on this); the inbox touch uses the status-preserving
  variant with no preview and never moves `last_activity_at` backwards (the
  relay retry job's shape); relay retry - the same, plus the preserving inbox
  touch that job's success path makes.
- for a terminal failure code, the BROADCAST owner's own arms (30005/30006
  flag the contact unreachable - SMS by construction); the relay owners
  record the code only, since an MMS leg's 30005 says nothing about SMS
  reachability. The webhook-only side effects for that code are residue
  (Sec 2); adoption WARNs naming the code so the drop is visible.

Every adoption write is idempotent, conditional or forward-only, so a status
callback that raced ahead of the adoption cannot be regressed by it and a
redelivered reconcile completes rather than duplicates it. A receipt that
lands between the status read and the pointer write is lost, as it was before
adoption; accepted.

**D16. Per-owner verdict handling.** The job dispatches on the owner kind in its
payload; each owner has an adopt, a re-drive and an unresolved write. A
`never_sent` re-drive transitions the record to `redriven` (D11) and then
enqueues; the re-drive continuation claims the record like any send site
(D8a), reads its snapshot strongly consistently, and sends. Because the slot
was never written while reconciling, a re-driven recipient is an ordinary
queued slot to every reader.

| owner | `found` (adopt) | `never_sent` (re-drive) | `unresolved` |
|---|---|---|---|
| broadcast recipient | D15 | enqueue a `broadcast.send` continuation for that one recipient (D13a) | record `done`; slot `failed` with `send_unconfirmed`; stats bucket `unconfirmed` (D22) |
| relay fan-out leg | D15 | pre-check sendability (group open, member on the roster, source present); if it holds, enqueue a `relay.fanOut` continuation for that one member; if not, record `done` / `redrive_refused` and slot `failed` / `redrive_refused` | record `done`; slot `failed` with `send_unconfirmed` |
| relay retry rung | D15, on the retry row | the same pre-check; then enqueue the same `relay.retryLeg` rung, which RSW's job-time window check bounds (Sec 2a) | same, on the retry row |

The relay retry rung's outcome switch handles `handed_to_reconcile` and
`sent_unrecorded` explicitly: neither is a terminal close and neither emits a
failure. The 1:1 retry job (`retrySend`) has no row here: it is adopted in
the post-RSW work (Sec 2a), where its record keys on the original message and
the rung, its single deferral is recorded on that record, and RSW's lineage
and `retry_due_at` requirements apply.

Log levels are uniform across owners: `found` INFO, `never_sent` WARN,
`unresolved` ERROR (exactly one, naming the owner, the recipient key and the
cause: provider unreachable, unidentified candidate, page bound exceeded,
digest mismatch, enqueue failed, second unknown after a re-drive).

**D16a. Finalize is idempotent, decides on a strongly consistent read, and
holds its own open-check.** `finalize` re-reads the broadcast consistently,
returns without writing if ANY recipient slot is non-terminal (a reconciling,
re-driven or in-flight recipient is `queued`, so no record read is needed
here), and otherwise flips the status on the condition `status = sending`;
only the writer that wins it writes the `broadcast_sent` audit row and emits
the terminal event. Every writer that could be the last - the pass, a
continuation, a cap-close, a verdict handler - simply calls `finalize` after
its own writes, and N callers produce one finalize. The terminal status:
`failed` when no recipient reached `sent` or `delivered` AND at least one is
`failed` or unconfirmed (`last_error` names which; skipped recipients count
for neither side), else `sent` as today.

## 6. Decisions: the adapter port and the hermetic fake

**D17. `MessagingAdapter` gains `listMessages({ to, from, createdAfter,
pageToken? })` and `getMessage(providerSid)`,** both returning `{ providerSid,
status, errorCode?, body, mediaCount, createdAt, sentAt? }` (the list: one page
plus a token for the next). The Twilio driver lists by `To` and `From` only
and filters on `date_created` client-side (the spike showed `DateSent` is the
wrong clock); the reconcile job owns the page walk (D13). List order and the
page size are asserted against the fake and recorded by the plan as
UNVERIFIED against real Twilio until the first hosted-dev run. The console
driver answers from what it has sent in-process. The narrow
`TwilioClientLike` seam gains optional `messages.list` and
`messages(sid).fetch`.

**D18. The lookup never logs a body or a phone.** Log lines carry SIDs, counts,
the check number and the verdict.

**D19. fake-twilio grows the Messages list and fetch routes (storing bodies
the way Twilio does, so the normalization is exercised) and a
`fail-next-send` control seam** with three modes, so the e2e harness can drive
every branch: `reject` (a Twilio-shaped 4xx with a chosen code),
`drop_before_create` (the socket is destroyed before any message is recorded:
the app sees `unknown`, the reconcile finds nothing, the recipient is
re-driven), and `accept_then_drop` (the message is recorded, then the socket
is destroyed: the app sees `unknown`, the reconcile finds it and adopts it).
The seam is hermetic-only like every other control route. The fake fires its
status callbacks within milliseconds, so in `accept_then_drop` those callbacks
reach the app BEFORE adoption and are dropped as unknown SIDs; the adoption's
status read is what carries the delivered state (D15).

## 7. Decisions: dashboard

**D20. `send_unconfirmed` is presented by CODE, the way `contact_opted_out`
already is.** It only ever appears on a CLOSED (`failed`) slot, where it
renders the label "Not confirmed", danger tone, `isFailure: false` (so no
Retry that could double-send is offered), with the reason "Couldn't confirm
whether this text went out." - true for every cause D16 names, since in each
the platform does not know; the cause is for the log, not the row. A
recipient still being reconciled is a plain `queued` slot and renders as one.
Every render position keys on the code together: the relay rollup, the
per-recipient row, the accessible name, the broadcast row, AND the relay retry
join (`relayRetryJoin.ts`), which today projects a rung's terminal code onto
the root leg as a failure and must not turn an unresolved rung into a Retry
offer.

**D20a. A queued leg with no provider clock ages from its attempt clock.** The
relay staleness rules gain one row: a `queued` slot with no `sentAt` but an
`attemptedAt` ages from `attemptedAt`, so a leg stranded mid-send or
mid-reconcile reads "Queued - not confirmed" after the existing 15-minute
budget instead of "Sending..." for ever. A `queued` slot with neither clock
still never ages (the held-message case that rule protects). A wholesale slot
write can erase `attemptedAt`; that leg falls back to today's behavior.

**D21. The relay rollup counts an unresolved leg under "not confirmed", not
"failed".** `presentRelayDelivery`'s K (failed) excludes `failed` slots
carrying `send_unconfirmed`; they join J (not confirmed). The chip stays
danger-toned and `isFailure: false`.

**D22. Broadcast stats gain an `unconfirmed` bucket and the results page a
"Not confirmed" chip.** `deriveBroadcastStats` routes a `failed` slot with
`send_unconfirmed` there instead of `failed`; the persisted counter the
unresolved write bumps is `unconfirmed`, not `failed`. The recipient row reads
"Not confirmed" with the D20 reason rendered (the badge shows a reason for this
code even though `isFailure` is false) and no "open conversation to retry"
link. Readers that change together: the `BroadcastStats` API type, the
`broadcast.updated` SSE payload, the StatChips balance rule, the results and
list routes, and the two seed files that build stats.

**D23. New codes render as prose, never as fake carrier numbers.** The
app-invented codes this branch writes (`send_unconfirmed`, `redrive_refused`)
and the existing `sms_sending_disabled` token go in the delivery-reason
internal-code map (`redrive_refused`: "Wasn't resent: the group closed or the
member left"). A Twilio rejection code renders through the existing carrier
map or its `(error N)` fallback, which is correct for a real Twilio number.
The pre-existing `transient_cap` copy widens from "carrier deferrals" to
"temporary errors", because D6 routes 20429 and connection refusals through
that close.

## 8. What must be proven

Test INTENTIONS; the plan specifies seams, fixtures and mechanics.

1. The classifier places every example in D1 correctly: a twilio-node
   `RestException` with `status 429, code 20429` (retryable), `status 400,
   code 21211` (rejected), `status 500` with a code (unknown), an axios timeout
   (unknown), ECONNREFUSED (retryable), and an error with no code or status at
   all (unknown - D2).
2. `sendMessage` throws each typed error from the step D3 names, and a failure
   after the row is written does NOT throw (D3).
3. Per adopter, an `unknown` mid-audience leaves the later recipients
   attempted, the failing one's record `reconciling` with a reconcile job
   enqueued and its slot untouched, and no throw - the broadcast pass
   (recipient 3 of 5), the relay fan-out (member 2 of 4) and the relay retry
   rung (D7). **The broadcast and relay cases must fail on `main`.**
4. D7a per phase: a prepare-phase failure defers as `retryable` and releases
   the record; a record-phase failure after a successful send logs ERROR with
   the SID, moves the record to `reconciling` with that SID, enqueues, and
   the loop continues; a `SendAcceptedNotRecordedError` does the same; the
   slot write and the stats bump are one conditional write.
5. D8a: two passes sending the same recipient concurrently produce ONE
   provider call; a relay success that left the slot `queued` with a SID
   refuses a second claim; a fresh foreign claim defers the recipient rather
   than skipping it; a stale one is taken over into `reconciling` with the
   old `attemptedAt`; a stale writer's outcome write is refused by the
   `attemptedAt` condition; `attemptedAt` lands on the slot; a legacy relay
   slot that is absent at first claim is created and claimed.
6. D8: a cap-close leaves a recipient with a fresh `attempting`, a
   `reconciling` or a `redriven` record untouched, closes one whose record is
   absent or `done` / `retryable`, takes over one whose `attempting` record is
   older than the provider timeout, and refuses to overwrite a slot that
   already carries a SID; a batch read with an unprocessed key re-reads it
   rather than closing; the reconcile job's own close writes the slot before
   the record and a redelivered close re-applies it; a continuation payload
   never lists a reconciling recipient; the brake defers the recipients not
   yet attempted in this pass, including deferred ones.
7. Three consecutive `unknown` outcomes brake the pass and defer the untried
   remainder; three `retryable` or three `rejected` do not (D9).
8. Reconcile verdicts against a fake adapter: known SID adopts via fetch
   without a list and without the digest check; a listed orphan adopts with
   the reported status (a `delivered` listing adopts as delivered with
   `carrierSentAt`/`sentAt`, an `undelivered` one as failed with its code); a
   listing that is empty at check 1 and populated at check 2 adopts (the
   lag); a candidate held by ANOTHER attempt or by the `syssid#` marker is
   excluded while one held by THIS owner repairs; the spike's exact
   Smart-Encoded body (curly quote, em dash, ellipsis) matches its submitted
   body; a media-only message matches on media count; two text attempts with
   identical bodies each adopt one of two orphans and neither re-drives; two
   media attempts with the same fingerprint and ONE orphan end with one
   adoption and one `unresolved`, never a re-drive; a
   STOP auto-reply in the window is ignored at checks 1-2 and decides
   `unresolved` at check 3, never adoption and never `never_sent`; a
   multi-page list is walked to its end and a walk past the bound is
   `unresolved`; an empty window is `never_sent` and re-drives exactly once;
   a throwing adapter on every check is `unresolved` with one ERROR; a digest
   mismatch is `unresolved`; a known-SID fetch failure throws (D12, D13, D15,
   D16).
9. D11 idempotency: the same adoption run twice writes once; a redelivered
   check yields at most one extra chain that converges; a `never_sent`
   verdict delivered twice increments `redriveCount` once and the second
   continuation's claim is refused; an `unresolved` delivered twice writes
   once; a payload for an older `attemptedAt` writes nothing.
10. D13a: three checks and no more; a re-drive attempt that comes back
    `unknown` closes `unresolved` with no reconcile; an enqueue that throws
    inside the job closes `enqueue_failed` after `never_sent` and
    `unresolved` otherwise; a re-drive pass claims no ladder rung unless it
    has a transient remainder.
11. D16a: N concurrent finalizers produce one status flip, one audit row and
    one terminal emit; the pass-then-verdict and verdict-then-pass orderings
    both finalize exactly once; a broadcast with only skipped, failed and
    unconfirmed recipients finalizes `failed`; a relay re-drive on a closed
    group closes `redrive_refused`; a re-drive continuation reads its own
    record and sends.
12. RSW carry-overs (Sec 2a): a window deadline during the relay rung's
    bounded acquire closes `retry_window_closed` with the record `done` /
    `window_closed` and is never deferred; a re-driven rung is declined by
    the job-time window check when the window has passed; RSW's window close
    refuses a recipient with an open attempt; `retrySend` is byte-identical
    to its RSW-merged state on this branch.
13. `send_throttled` fires on 20429 and not on ECONNREFUSED (D4).
14. Dashboard: `send_unconfirmed` renders "Not confirmed" / danger / not a
    failure in every relay position including the retry join, and on the
    broadcast row with its reason; the rollup counts it under J; a queued leg
    with `attemptedAt` and no `sentAt` ages into "Queued - not confirmed"; the
    broadcast chip shows the `unconfirmed` bucket and the balance rule still
    holds; `redrive_refused` renders its prose (D20-D23).
15. Stats: a `failed` slot with `send_unconfirmed` lands in `unconfirmed` and
    in no other bucket, in `deriveBroadcastStats` and in both seeds (D10, D22).

**E2E (hermetic), one spec per fake mode (D19), under the lane window
override (D13a):** `accept_then_drop` on a relay leg ends with the leg adopted
as delivered, the fake's early callbacks having been dropped; `drop_before_
create` on a broadcast recipient ends with that recipient sent by the re-drive
and the broadcast `sent`; `reject` with 21211 marks the recipient failed with
that code and the rest of the audience sent. The redelivery property of D11
and the routing of a post-adoption receipt are proven at integration level:
the in-process job adapter never redelivers.

## 9. Stage 2 and the issues this branch files

The 2026-09-24 sweep found the same claim-then-throw shape at nine more sites.
None is edited here; each is filed as its own issue, citing the sweep's
findings by file:line, and grouped for the follow-on:

- **The `retrySend` adoption**, first after RSW (Sec 2a): its record keyed on
  the original message and the rung, one deferral, adoption with RSW's
  lineage, `retry_due_at` kept truthful while an outcome is pending, and the
  joint gap RSW files as `manual-retry-double-send-residual-windows`. Until
  then a 1:1 retry that errors under the job marker is lost exactly as today.
- **Send-shaped** (adopt the D1-D3 core and the D8a record; small edits once
  they exist): `call.missedAutoText`, the tour reminder poll (1:1 and group),
  the placement nudge poll, `relay.intro` and `relay.memberAdded` via
  `sendRelayAnnouncement`.
- **Not sends** (local error handling; no reconcile involved):
  `relay.numberReady`'s two post-flip enqueues, the pending roster-action poll,
  the voice recording callback after a successful mirror, and the pre-send
  database reads in the two announcement jobs.
- **The sweeper** that closes the crash windows Sec 1 records - an
  `attempting` record past its TTL with no send site revisiting it, a
  `reconciling` record with no chain, a `redriven` record no continuation
  lists - and the relay staleness alarm the dashboard assumes. The attempt
  record gives it a clock and a state to read.

Also filed, found along the way: the `no_contact` code renders as a fake
carrier error; broadcast 30003 retries never update the broadcast slot
(`retrySend` drops `broadcastId`); `deliveryStatus.ts` assumes a server-side
relay staleness alarm that does not exist; the per-PASS setup in either
fan-out (the unit read, the snapshot read, the versioned preflight - before any
recipient is attempted) still throws under the marker and strands the pass;
a relay continuation that early-returns (group closed, source gone) leaves its
queued slots non-terminal, shared with the transient ladder; a send-time 21610
gets no suppression bookkeeping; the passive match of an unknown-SID status
callback against a pending reconcile (fenced webhook). Filed only if still
open at filing time - share-skip-fix's Branch A may land them first: the
`no_contact` copy and the broadcast-30003-retry slot update.

The anchor issue's claim that `retrySend` "does not rely on redelivery" is
corrected in the issue file: it has the same shape; its adoption follows RSW.

## 10. Post-merge obligations

**No infrastructure, dependency, environment or schema work.** The attempt
record is a new item family in an existing table; the counter, codes and
`attemptedAt` are optional attributes; the new job name registers like every
other. The `send.reconcile` job reaches the DLQ on repeated failure, which the
existing `jobs-dlq-depth` alarm already covers. One check owed at the first
hosted-dev run: the list walk's order and page bound against real Twilio
(D17), and whether the PROD Messaging Service also has Smart Encoding on (the
dev one does; the normalization does not depend on it, but the record should
say).

## 11. Risks

- **D2 is the trap in the other direction.** Moving a network code or a 5xx
  from `unknown` to `rejected` or `retryable` to be "helpful" turns a delivered
  text into a Failed row or a double text. Twilio 4xx is the only class whose
  "not processed" is documented; everything else stays `unknown`.
- **D3a is the other trap.** Any code path that lets a post-send write failure
  reach the classifier as `unknown` re-creates the double text the reviewers
  found in round 1. The three-phase split in D7a is the structural guard; a
  builder who wraps "the whole recipient" in one try has undone it.
- **The coordination state must stay OUT of the slot.** Three review rounds
  found holes while it lived in `errorCode`, because six writers share the
  slot and two rewrite it wholesale. A builder who "simplifies" by folding
  the record back into the slot re-opens all of them.
- **D13's body match is a requirement, not a hint.** Adopting "the only
  message in the window" adopts Twilio's own STOP auto-reply (round 2). And
  the normalization must be the lossy one: an exact match rules a real
  orphan `never_sent` the moment the body carries a curly quote.
- **The claim (D8a) is what makes at-least-once enqueues safe.** Removing it
  "because the conditions already dedupe" re-opens every double-text the
  round-2 review found; removing the conditions "because the claim already
  dedupes" strands recipients on a crash. Both are load-bearing.
- **"The existing X handles this" must be traced from the new call site.** The
  retry-counter mission found several close branches unreachable from where its
  plan wanted to call them; `finalize` from the reconcile handler is exactly
  that shape, which is why D16a rebuilds it.
