# Send-outcome classification and reconcile - design

Anchor issue: `throw-for-redelivery-defeated-by-job-marker` (high).
Branch `feat/send-outcome-reconcile`, cut from `main@685f2ede`, 2026-09-24.
Revision 3 (after design review rounds 1 and 2; see the adjudications).

| sev | issue | this branch |
|---|---|---|
| high | `throw-for-redelivery-defeated-by-job-marker` | **closes** |
| med | `accepted-send-lost-when-append-fails` | piece 1 (the typed error) **built**; piece 2 **built for the adopted callers** - `missedCallAutoText`, its production path, is Stage 2 (Sec 9) |
| low | `exactly-once-send-intent` | **partly** - the per-recipient send claim (D8a) and the reconcile mechanism; no separate intent record (D14) |

**This document states DECISIONS and INVARIANTS.** Mechanics - control flow,
where a line goes, exact backoff values, test seams - belong to the plan.
Review history, adjudications and rejected alternatives are in
`docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/design-review/`.

## 1. The invariant, stated with its scope

Three guarantees, each with the mechanism that delivers it and the residue it
leaves:

1. **Nobody is texted twice by this branch.** Every send site claims the
   recipient before calling the provider (D8a), so two passes, two
   continuations or two re-drives for one recipient produce one send; a
   re-drive is attempted only after a verdict that nothing was sent (D13);
   the verdict never adopts a message it cannot identify as ours (D13).
   Residue: an orphan the provider lists outside the pages the lookup walks
   (D13) would be ruled `never_sent` - the walk covers the whole recipient/
   sender list inside the window and is verified on the first hosted-dev run.
2. **A recipient whose provider send was attempted reaches a terminal state
   without anyone throwing out of the loop.** The per-recipient unit is split
   into prepare / send / record phases and each phase has a defined failure
   handling (D7a); the reconcile job's own failures are genuine retries (D11)
   and end in a verdict (D13a). Residue, recorded not closed: a process death
   between a claim (D8a) or an ambiguous send and the enqueue of its reconcile
   job (D14); a failure of the per-PASS setup before any recipient is
   attempted (Sec 9); a failure-arm write that itself fails (D7, D7a).
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
  (`sendOneRelayLeg` and the fan-out loop), `app/src/jobs/relayRetryLeg.ts`,
  `app/src/jobs/retrySend.ts` - the adopters (Sec 4).
- A new `send.reconcile` job (Sec 5) and its per-owner verdict handlers.
- `app/src/repos/broadcastsRepo.ts` (the send claim D8a, idempotent finalize
  D16a, the stats bucket D22); `app/src/repos/messagesRepo.ts` (the send claim
  on relay slots, the 1:1 owner's state on the original message row D12).
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
  adds writers of relay slots (the claim, the reconcile job) but does not touch
  the pass claim. D8 keeps a claimed or reconciling slot out of every close,
  which narrows that race's damage without closing it.
- `fanout-close-path-robustness-residues`: the close loops stay unwrapped; a
  failure-arm write that itself fails (D7a) is that issue's "throwing close"
  class one step earlier and is added to it.
- `relay-retry-stranded-claim-window`: the crash window between a claim or a
  send and the enqueue of its reconcile job (D14) is the same class; recorded,
  not closed. The sweeper that closes both is Stage 2 material.
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
  code, and the reconcile facts: a keyed digest of the recipient number, the
  sender, the normalized body hash (D13), the attempt start.
- `SendAcceptedNotRecordedError` - Twilio accepted the message and the row
  write (`append`) failed. Carries the provider SID, provider timestamp and
  status. This is `accepted-send-lost-when-append-fails` piece 1; Sec 4 says
  what an adopter does with it (D7a).
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

## 4. Decisions: what a fan-out does with each kind

Applies to `broadcastFanOut`, `sendOneRelayLeg` (and therefore both the relay
fan-out loop and the relay retry job), and, with the variant row in D16,
`retrySend`.

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

**D7. `unknown`: hand the recipient to the reconcile job, continue.** The pass
FIRST enqueues one `send.reconcile` job for that recipient (Sec 5; the payload
carries everything the job needs), THEN writes the slot `queued` with code
`send_unconfirmed` (the code only - `sentAt` and `carrierSentAt` are provider
timestamps and stay unset; the attempt clock is `attemptedAt` from the claim,
D8a), and moves on. The pass never waits for the verdict. A slot in this state
is OWNED by its reconcile job until the verdict lands. The order is
deliberate: the job's verdict conditions tolerate a slot that never received
the code (D11), so a slot write that fails after the enqueue still resolves;
an enqueue that throws closes the slot `unresolved` on the spot (the D9
precedent from the retry-counter design).

**D7a. The per-recipient unit has three phases, and each phase fails
differently.**

| phase | what runs | on failure |
|---|---|---|
| PREPARE | reads and writes before the provider call: contact, conversation, roster suppression check, presign, the aggregation-state write, the claim itself (D8a) | nothing was sent: the recipient is deferred as `retryable` (D6); a lost claim is a skip, not a failure |
| SEND | the provider call, or `sendMessage` | classified (D1) |
| RECORD | writes after a successful send that the receipts depend on: the slot, the SID pointer (relay), the message row (`sendMessage`'s append); and the stats bump | the send HAPPENED and its SID is known: `sent_unrecorded` - one ERROR line carrying the SID and the owner, then the recipient is handed to the reconcile job WITH the SID (D13's known-SID path), whose adoption re-runs those writes idempotently; the loop continues. The token acquire, the milestone and listing-send rows and the SSE emits are already best-effort and stay so |

A failure-arm write (the D5/D6/D7 slot writes) that itself fails is logged at
ERROR with the owner and the recipient and the loop continues; the slot keeps
whatever it held. That recipient is the future sweeper's, and Sec 1 records
it. Nothing in any phase throws out of the loop. The relay unit returns two
new outcome kinds, `sent_unrecorded` and `handed_to_reconcile`, so its callers
can count them and the retry rung can handle them explicitly.

**D8. Claimed and reconciling slots are invisible to the cap-closes, to the
continuation's recipient set, and to every send site.** `closeBroadcast` and
`closeRelay` skip a slot whose code is `send_attempting` or
`send_unconfirmed` (stamping one `transient_cap` would overwrite a text that
may have gone out or is going out); the continuation payload never lists one;
every send site's claim (D8a) refuses one; a pass that finds one still open
does not finalize the broadcast (finalize checks, D16a). A `send_redrive`
slot is an ordinary queued slot to all of them.

**D8a. Every send site claims the recipient before calling the provider.**
Immediately before the provider call the site conditionally writes the slot
`queued` with code `send_attempting` and `attemptedAt = now`, on the condition
that the slot is `queued` and its code is not `send_attempting` and not
`send_unconfirmed`. Losing that condition means another writer owns the
recipient: the site skips it without a send and without an error. The claim
is released by the outcome write the same site makes moments later (`sent`,
`failed` with a code, `queued` with a retry code, or `send_unconfirmed`), so
in the normal case the claim lives for the duration of one provider call.
This is the per-recipient form of the guarantee the run-once marker gives per
job: a duplicate pass, a duplicate continuation, or a twice-enqueued re-drive
cannot text the same recipient twice, because only one of them wins the
claim. A `send_attempting` slot that outlives the provider's timeout is a
process that died mid-send; a send site that meets one older than that hands
it to the reconcile job as `unknown` with its `attemptedAt` instead of
sending. Today only a re-drive or a first pass revisits such a slot, so the
general case of that residue is the future sweeper's (Sec 1). Both slot
types gain the `attemptedAt` field; the versioned relay row's existing
pre-send aggregation-state write and the claim are one conditional update.

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
The codes this branch writes: `send_attempting`, `send_unconfirmed`,
`send_redrive`, `redrive_refused`, `sms_sending_disabled` (existing token),
and the provider's own rejection codes.

## 5. Decisions: the reconcile job

**D11. `send.reconcile` is an ordinary job with a fresh `jobId` and NO run-once
marker. Its enqueues are AT-LEAST-ONCE and every write it makes is idempotent
or conditional, so a redelivery, a duplicate check, or two chains for one
recipient converge on one outcome:**

- Adoption is a set of individually idempotent writes (the row append dedupes
  on the SID; the pointer put is a plain put; the slot write is forward-only
  and returns whether it moved; the stats bump happens only when the slot
  write moved). Re-running the whole adoption is safe, so a throw partway
  through is a genuine retry that completes it.
- A check records its number on the slot (or the 1:1 owner's row) and then
  enqueues its successor. The record is tolerant of its own duplicate, so a
  redelivered check may enqueue a second successor; the chain is bounded at
  three checks (D13a) and every verdict below is idempotent, so a duplicate
  chain costs a few extra list calls and nothing else.
- A `never_sent` verdict flips the slot to `send_redrive` on the condition
  that it reads `send_unconfirmed` or already `send_redrive`, then enqueues
  the re-drive. The enqueue may therefore happen twice; the send claim (D8a)
  makes the second continuation a no-op.
- An `unresolved` verdict and a `redrive_refused` close are forward-only
  writes from a non-terminal slot; a duplicate finds a terminal slot and
  writes nothing.

Because nothing in the chain depends on being the single winner, a throw
inside the job is a genuine retry: five failures reach the DLQ and page
through the existing `jobs-dlq-depth` alarm. (Other jobs - media mirror, voice
transcripts, relay warm - already retry genuinely; this one joins them and
its docblock says why the marker is absent.)

**D12. The payload carries identifiers and the reconcile facts, never a body or
a recipient phone in the clear:** the owner reference (D16), a keyed digest of
the recipient number (SHA-256 over the owner reference and the E.164 - the
relay retry claim's shape), the sender (a pool or business number, not PII),
the normalized body hash (D13), the attempt start, the check number, the
pass's continuation context (so a `never_sent` verdict can re-drive the
recipient), and the provider SID when one is known. At run time the job
re-reads the recipient's CURRENT number from the owner (the contact, the
roster member, the 1:1 conversation) and compares its digest; a mismatch is
`unresolved` - a text, if any, went to a number we can no longer look up. The
1:1 owner (`retrySend`) has no slot: its durable record is the ORIGINAL
message row, and its check number, deferral and verdict are conditional
attributes on that row.

**D13. The lookup, and its three verdicts.**

- **Known SID:** fetch that message by SID (D17). The verdict is `found`. A
  fetch that fails is a job failure (a genuine retry, D11), never a verdict.
- **Otherwise** list the provider's messages to that recipient from that sender
  (D17), walking EVERY page until a whole page is older than the window (one
  recipient/sender pair holds few messages), and keep those created inside
  the window: from 60 seconds before the attempt start (clock skew plus the
  provider's one-second resolution) to now. Exclude any candidate whose SID
  another owner already holds - a `sid#` or `relaysid#` pointer resolving to
  a different owner or recipient, or the `syssid#` system-send marker. A
  candidate whose pointer resolves to THIS owner and recipient is `found` (a
  repair: the send was recorded after all). Of the rest, a candidate is OURS
  only if its body matches: compare after a lossy normalization (Unicode
  NFKC, then letters and digits only), because Smart Encoding rewrites
  punctuation in the stored body (Sec 1). One matching candidate: `found`.
  Several: `found` with the earliest and a WARN. Candidates in the window
  that match nothing (a Twilio STOP/HELP auto-reply from our own number, an
  orphan of some other send to the same recipient): `unresolved`, with the
  cause named in the log - never adopted, never re-driven. A normalized body
  shorter than three characters cannot be matched and is `unresolved` too.
- **No candidate through the whole window:** `never_sent`.
- **Provider unreachable on every check:** `unresolved`. A provider error
  INSIDE a check is caught and counted as that check's result; only the job's
  own writes throw.

**D13a. Bounded, and budgeted against the job-chain limit.** At most THREE
checks per recipient (about 5 seconds, 30 seconds and 4 minutes after the
attempt - the first no sooner than 5 seconds, for the list lag), scheduled as
the job's own continuations (fresh `jobId`, the check number in the payload),
never an in-process sleep: the worker's 120-second visibility timeout forbids a
five-minute handler. At most ONE re-drive per recipient: a `send_redrive` slot
that meets a second `unknown` closes `unresolved` directly, with no second
reconcile. A re-drive continuation claims no pass from the ladder (the
single-re-drive rule bounds it); a transient outcome inside it joins the
ladder as usual. Worst-case chain depth is 8 hops of `MAX_HOP_COUNT`'s 10: a
relay fan-out reached through `relay.numberReady` starts at hop 2, two
continuations (4), three checks (7), the re-drive (8). Any enqueue that
throws inside the reconcile job - the hop limit or the queue - is caught and
closes the recipient `unresolved` on the spot. The window is overridable for
the hermetic lane only, on the `E2E_RELAY_RETRY_BACKOFF_MS` precedent
(topology-guarded on `JOBS_QUEUE_URL`; production cannot shorten it).

**D14. No separate send-intent record.** The claim on the slot (D8a) is the
durable intent, and the reconcile job's payload carries the facts, made
durable by SQS the moment the enqueue succeeds. A process death between the
claim and the send, or between an ambiguous send and the enqueue, leaves the
slot `send_attempting` or `send_unconfirmed` with a clock and nothing to
resolve it: the same crash window `relay-retry-stranded-claim-window`
records, closed by the same not-yet-built sweeper. Recorded, not fixed. An
enqueue that THROWS is not a crash window (D7).

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
- everything else the owner's success path writes: broadcast - the message row
  in the tenant's 1:1 conversation with the broadcast stamp (the write
  `sendMessage` would have made, idempotent on the SID), the slot with
  `conversationId`+`tsMsgId` so later receipts roll up, the stats bump (only
  when the slot write moved), the `listing_sent` milestone, the listing-send
  row, the audit row and the SSE emits, best-effort ones best-effort; the
  inbox touch uses the status-preserving variant with no preview and never
  moves `last_activity_at` backwards (the relay retry job's shape); relay -
  the slot and the `relaysid#` pointer; 1:1 retry - the row with the retry
  lineage.
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
payload; each owner has an adopt, a re-drive and an unresolved write. Every
`never_sent` re-drive first flips the slot to `queued` / `send_redrive` (D11)
- from that moment it is an ordinary queued slot to every send site and every
close - and only then enqueues. A continuation that carries `recipientKeys`
reads its snapshot strongly consistently, so it cannot miss its own flip.

| owner | `found` (adopt) | `never_sent` (re-drive) | `unresolved` |
|---|---|---|---|
| broadcast recipient | D15 | enqueue a `broadcast.send` continuation for that one recipient, claiming no pass (D13a) | slot `failed` with `send_unconfirmed`; stats bucket `unconfirmed` (D22) |
| relay fan-out leg | D15 | pre-check sendability (group open, member on the roster, source present); if it holds, enqueue a `relay.fanOut` continuation for that one member, claiming no pass; if not, close the slot `failed` / `redrive_refused` | slot `failed` with `send_unconfirmed` |
| relay retry rung | D15, on the retry row | the same pre-check; then enqueue the same `relay.retryLeg` rung, claiming no transient pass | same, on the retry row |
| 1:1 retry (`retrySend`) | D15 | re-enqueue the same rung once, recorded conditionally on the original message row; a second `never_sent` or `retryable` on a deferred rung ends the chain with an ERROR | ERROR, chain ends; the original stays visibly `undelivered` |

`retrySend`'s other kinds, for completeness: a prepare-phase failure (the
original read, the presign) and `retryable` take the same single deferral as
`never_sent`; `rejected` -> ERROR, chain ends; `unknown` -> reconcile;
`SendAcceptedNotRecordedError` -> reconcile with the SID. D5-D9 otherwise do
not apply to it (it has no slot and no pass). The relay retry rung's outcome
switch handles `handed_to_reconcile` and `sent_unrecorded` explicitly: neither
is a terminal close and neither emits a failure.

Log levels are uniform across owners: `found` INFO, `never_sent` WARN,
`unresolved` ERROR (exactly one, naming the owner, the recipient key and the
cause: provider unreachable, unidentified candidate, digest mismatch, enqueue
failed, second unknown after a re-drive).

**D16a. Finalize is idempotent, decides on a strongly consistent read, and
holds its own open-check.** `finalize` re-reads the broadcast consistently,
returns without writing if any slot is non-terminal or carries
`send_attempting`, `send_unconfirmed` or `send_redrive`, and otherwise flips
the status on the condition `status = sending`; only the writer that wins it
writes the `broadcast_sent` audit row and emits the terminal event. Every
writer that could be the last - the pass, a continuation, a cap-close, a
verdict handler - simply calls `finalize` after its own writes, and N callers
produce one finalize. The terminal status: `failed` when no recipient reached
`sent` or `delivered` AND at least one is `failed` or unconfirmed (`last_error`
names which; skipped recipients count for neither side), else `sent` as
today.

## 6. Decisions: the adapter port and the hermetic fake

**D17. `MessagingAdapter` gains `listMessages({ to, from, createdAfter,
pageToken? })` and `getMessage(providerSid)`,** both returning `{ providerSid,
status, errorCode?, body, createdAt, sentAt? }` (the list: one page plus a
token for the next). The Twilio driver lists by `To` and `From` only and
filters on `date_created` client-side (the spike showed `DateSent` is the
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
already is.** On a `failed` slot it renders the label "Not confirmed", danger
tone, `isFailure: false` (so no Retry that could double-send is offered), with
the reason "Couldn't confirm whether this text went out." - true for every
cause D16 names, since in each the platform does not know; the cause is for
the log, not the row. On a `queued` slot (the minutes while the reconcile
runs) it renders exactly as a queued slot renders today. Every render position
keys on the code together: the relay rollup, the per-recipient row, the
accessible name, the broadcast row, AND the relay retry join
(`relayRetryJoin.ts`), which today projects a rung's terminal code onto the
root leg as a failure and must not turn an unresolved rung into a Retry offer.

**D20a. A queued leg with no provider clock ages from its attempt clock.** The
relay staleness rules gain one row: a `queued` slot with no `sentAt` but an
`attemptedAt` ages from `attemptedAt`, so a leg stranded mid-send or
mid-reconcile reads "Queued - not confirmed" after the existing 15-minute
budget instead of "Sending..." for ever. A `queued` slot with neither clock
still never ages (the held-message case that rule protects).

**D21. The relay rollup counts an unresolved leg under "not confirmed", not
"failed".** `presentRelayDelivery`'s K (failed) excludes slots carrying
`send_unconfirmed`, whatever their status; they join J (not confirmed). The
chip stays danger-toned and `isFailure: false`.

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
member left"); `send_attempting` and `send_redrive` are transient and render
as queued. A Twilio rejection code renders through the existing carrier map or
its `(error N)` fallback, which is correct for a real Twilio number. The
pre-existing `transient_cap` copy widens from "carrier deferrals" to
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
   attempted, the failing one `queued`/`send_unconfirmed` with a reconcile job
   enqueued, and no throw - the broadcast pass (recipient 3 of 5), the relay
   fan-out (member 2 of 4), the relay retry rung, and `retrySend` (whose
   record is the original row) (D7). **The broadcast and relay cases must
   fail on `main`.**
4. D7a per phase: a prepare-phase failure defers as `retryable`; a
   record-phase failure after a successful send logs ERROR with the SID and
   enqueues a reconcile carrying that SID, and the loop continues; a
   `SendAcceptedNotRecordedError` does the same.
5. D8a: two passes sending the same recipient concurrently produce ONE
   provider call; a claim outlives the provider timeout and the next pass
   hands it to reconcile instead of sending; the claim is released by every
   outcome write; `attemptedAt` is set.
6. A cap-close leaves `send_attempting` and `send_unconfirmed` slots
   untouched; a continuation payload never lists one; a pass with one open
   does not finalize (D8).
7. Three consecutive `unknown` outcomes brake the pass and defer the untried
   remainder; three `retryable` or three `rejected` do not (D9).
8. Reconcile verdicts against a fake adapter: known SID adopts via fetch
   without a list; a listed orphan adopts with the reported status (a
   `delivered` listing adopts as delivered with `carrierSentAt`/`sentAt`, an
   `undelivered` one as failed with its code); a listing that is empty at
   check 1 and populated at check 2 adopts (the lag); a candidate held by
   ANOTHER owner or by the `syssid#` marker is excluded while one held by
   THIS owner repairs; the spike's exact Smart-Encoded body (curly quote, em
   dash, ellipsis) matches its submitted body; a STOP auto-reply in the window
   yields `unresolved`, not `never_sent` and not adoption; a body under three
   normalized characters yields `unresolved`; a multi-page list is walked to
   the window edge; an empty window is `never_sent` and re-drives exactly
   once; a throwing adapter on every check is `unresolved` with one ERROR; a
   digest mismatch is `unresolved`; a known-SID fetch failure throws (D12,
   D13, D15, D16).
9. D11 idempotency: the same adoption run twice writes once; a redelivered
   check yields at most one extra chain that converges; a `never_sent`
   verdict delivered twice enqueues two continuations and the claim makes the
   second a no-op; an `unresolved` delivered twice writes once.
10. D13a: three checks and no more; a second `unknown` on a `send_redrive` slot
    closes `unresolved` with no reconcile; an enqueue that throws inside the
    job closes `unresolved`; a re-drive continuation claims no pass.
11. D16a: N concurrent finalizers produce one status flip, one audit row and
    one terminal emit; the pass-then-verdict and verdict-then-pass orderings
    both finalize exactly once; a broadcast with only skipped, failed and
    unconfirmed recipients finalizes `failed`; a relay re-drive on a closed
    group closes `redrive_refused`; a re-drive continuation reads its own
    flip.
12. The 1:1 retry variant: `found` appends the row with lineage; `never_sent`
    re-enqueues once, recorded on the original row, then ends the chain with
    an ERROR; a duplicate deferral is refused by the row condition (D16).
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

- **Send-shaped** (adopt the D1-D3 core and the D8a claim; small edits once
  they exist): `call.missedAutoText`, the tour reminder poll (1:1 and group),
  the placement nudge poll, `relay.intro` and `relay.memberAdded` via
  `sendRelayAnnouncement`.
- **Not sends** (local error handling; no reconcile involved):
  `relay.numberReady`'s two post-flip enqueues, the pending roster-action poll,
  the voice recording callback after a successful mirror, and the pre-send
  database reads in the two announcement jobs.
- **The sweeper** that closes the crash windows Sec 1 records (a
  `send_attempting` or `send_unconfirmed` slot with nothing in flight, a
  `send_redrive` slot no continuation lists) and the relay staleness alarm
  the dashboard assumes.

Also filed, found along the way: the `no_contact` code renders as a fake
carrier error; broadcast 30003 retries never update the broadcast slot
(`retrySend` drops `broadcastId`); `deliveryStatus.ts` assumes a server-side
relay staleness alarm that does not exist; the per-PASS setup in either
fan-out (the unit read, the snapshot read, the versioned preflight - before any
recipient is attempted) still throws under the marker and strands the pass;
a relay continuation that early-returns (group closed, source gone) leaves its
queued slots non-terminal, shared with the transient ladder; a send-time 21610
gets no suppression bookkeeping; an `unresolved` 1:1 retry leaves the
original's "will retry" copy standing; the passive match of an unknown-SID
status callback against a pending reconcile (fenced webhook).

The anchor issue's claim that `retrySend` "does not rely on redelivery" is
corrected in the issue file: it has the same shape, and this branch adopts it.

## 10. Post-merge obligations

**No infrastructure, dependency, environment or schema work.** The new counter,
codes and `attemptedAt` are optional attributes; the new job name registers
like every other. The `send.reconcile` job reaches the DLQ on repeated
failure, which the existing `jobs-dlq-depth` alarm already covers. One
check owed at the first hosted-dev run: the list walk's order and page bound
against real Twilio (D17), and whether the PROD Messaging Service also has
Smart Encoding on (the dev one does; the normalization does not depend on it,
but the record should say).

## 11. Risks

- **D2 is the trap in the other direction.** Moving a network code or a 5xx
  from `unknown` to `rejected` or `retryable` to be "helpful" turns a delivered
  text into a Failed row or a double text. Twilio 4xx is the only class whose
  "not processed" is documented; everything else stays `unknown`.
- **D3a is the other trap.** Any code path that lets a post-send write failure
  reach the classifier as `unknown` re-creates the double text the reviewers
  found in round 1. The three-phase split in D7a is the structural guard; a
  builder who wraps "the whole recipient" in one try has undone it.
- **D13's body match is a requirement, not a hint.** Adopting "the only
  message in the window" adopts Twilio's own STOP auto-reply (round 2). And
  the normalization must be the lossy one: an exact match rules a real
  orphan `never_sent` the moment the body carries a curly quote.
- **The claim (D8a) is what makes at-least-once enqueues safe.** Removing it
  "because the conditions already dedupe" re-opens every double-text the
  round-2 review found; removing the conditions "because the claim already
  dedupes" strands recipients on a crash. Both are load-bearing.
- **The reconcile job is a new writer of state four other writers already
  race on** (the pass, the continuation, the cap-close, the status webhook).
  D8, D11 and D15 are the rules that keep it out of their way.
- **"The existing X handles this" must be traced from the new call site.** The
  retry-counter mission found several close branches unreachable from where its
  plan wanted to call them; `finalize` from the reconcile handler is exactly
  that shape, which is why D16a rebuilds it.
