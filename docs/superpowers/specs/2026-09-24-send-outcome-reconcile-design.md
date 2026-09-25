# Send-outcome classification and reconcile - design

Anchor issue: `throw-for-redelivery-defeated-by-job-marker` (high).
Branch `feat/send-outcome-reconcile`, cut from `main@685f2ede`, 2026-09-24.

| sev | issue | this branch |
|---|---|---|
| high | `throw-for-redelivery-defeated-by-job-marker` | **closes** |
| med | `accepted-send-lost-when-append-fails` | **closes** for adopted callers (Sec 2) |
| low | `exactly-once-send-intent` | **partly** - the reconcile mechanism, no durable intent record (D14) |

**This document states DECISIONS and INVARIANTS.** Mechanics - control flow,
where a line goes, exact backoff values, test seams - belong to the plan.
Review history and rejected alternatives are in
`docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/design-review/`.

## 1. The invariant

**Every recipient of a fan-out reaches a terminal state, nobody is ever texted
twice, and an outcome the provider left ambiguous is resolved by the platform -
never by asking staff to guess.**

Today both fan-outs handle a per-recipient send error they do not recognise by
throwing, so that SQS redelivers the envelope. The redelivery carries the SAME
`jobId`; the per-job execution marker suppresses it; the suppressed run returns
successfully and the consumer deletes the message. Nothing is retried, the DLQ
is never reached, the throw exits the recipient loop so every later recipient
is never attempted, and the only trace is one `job failed` ERROR line that no
alarm reacts to.

"Unrecognised" is not an edge case. The codes the fan-outs recognise today -
30007, 30005/30006, 30022 - are codes Twilio reports asynchronously in delivery
receipts. Twilio's send-time rejections (e.g. 21211 invalid number, 21610
unsubscribed), its rate-limit response (20429, which twilio-node exposes as
`code: 20429`, not the HTTP 429 the fan-outs check for), transport failures
(timeout, dropped socket), and Twilio 5xx all take the throw. So do the
non-provider failures inside `sendMessage`: a database read before the provider
call, and the row write AFTER Twilio has accepted the message. One bucket holds
"definitely not sent", "may have been sent" and "definitely sent".

Spike-verified against the real dev account (2026-09-24): Twilio ignores an
`Idempotency-Key` header on message creation (same key twice = two SIDs, two
texts), so a blind retry is never safe; and the Messages list filtered by
`To`+`From` lags creation by 1-2 seconds and its `DateSent` filter is on SEND
time (returned nothing for a just-created message). Both facts shape Sec 5.

## 2. Scope

**In:**

- `app/src/adapters/messaging.ts` - the send-failure classifier (D1-D4), the
  `listMessages` port (D17), the throttle marker (D4).
- `app/src/services/sendMessage.ts` - typed send errors (D3).
- `app/src/jobs/broadcastFanOut.ts`, `app/src/jobs/relayFanOut.ts`
  (`sendOneRelayLeg` and the fan-out loop), `app/src/jobs/relayRetryLeg.ts`,
  `app/src/jobs/retrySend.ts` - the adopters (Sec 4).
- A new `send.reconcile` job (Sec 5) and its per-owner verdict handlers.
- `app/src/repos/broadcastsRepo.ts` (stats bucket, D22), `app/src/repos/messagesRepo.ts`
  only if a verdict write needs a guard that does not exist (plan decides).
- `fake-twilio` - the Messages list route and a fail-next-send control seam (D19).
- Dashboard: `dashboard/src/routes/contact/deliveryStatus.ts`,
  `dashboard/src/routes/broadcasts/*` (copy and the new stats bucket), and the
  API types those read (Sec 6).

**Out - hard fences (note the interaction, do not fix):**

- `routes/webhooks/twilio.ts` in its entirety. A status callback for a SID we
  do not yet hold is still dropped at ERROR there; D15 makes that harmless.
- `relay-fanout-active-pass-cap-close-race` (deferred, same file): this branch
  adds a fourth writer of relay slots (the reconcile job) but does not touch the
  pass claim; D8 keeps the new writer out of the cap-close set.
- `fanout-close-path-robustness-residues`: the close loops stay unwrapped.
- `relay-retry-stranded-claim-window`: the crash window between a send and the
  enqueue of its reconcile job (D14) is the same class and is recorded, not
  closed.
- `provider-status-unenumerated-defaults`: `mapTwilioStatus` is used as-is by
  the adoption write (D15).
- The nine other claim-then-throw sites found by the 2026-09-24 sweep (Stage 2,
  Sec 9). Each is filed as its own issue by this branch; none is edited.
- Any change to the run-once marker, `jobs.ts`, or the SQS consumer.

## 3. Decisions: classification at the send boundary

**D1. Every failure of a provider send is classified into exactly one of three
kinds, by a pure function with no I/O:**

| kind | meaning | examples |
|---|---|---|
| `rejected` | Twilio answered and refused; nothing was sent | any Twilio 4xx with a code other than 20429 (21211, 21614, 21610, 20003, 30034 ...); the adapter kill-switch (`SmsSendingDisabledError`) |
| `retryable` | nothing was sent, and trying again later is safe | HTTP 429 / code 20429 (Twilio: "not processed, safe to retry"); the existing 429 and 30022 tokens; a connection that never opened (ENOTFOUND, ECONNREFUSED, EAI_AGAIN) |
| `unknown` | the request may have reached Twilio; a message may exist | timeout (ECONNABORTED, ETIMEDOUT), dropped socket (ECONNRESET, EPIPE), any 5xx, an error with no recognisable code at all |

The classifier reads `code` then `status`, exactly as `errorCodeOf` does today,
so a twilio-node `RestException` classifies by its Twilio code. 30007 stays
`rejected` if it ever arrives at send time (it never has; it is a receipt code)
and keeps its never-retry meaning.

**D2. `unknown` is the default.** An error the classifier cannot place is
`unknown`, never `rejected`: a text that went out and is marked failed invites a
manual resend, which is the double-text the marker exists to prevent. The cost
of a wrong `unknown` is one reconcile lookup.

**D3. `sendMessage` (the 1:1 send service) throws TYPED errors that carry the
facts a reconcile needs, instead of the bare provider error:**

- `SendNotAttemptedError` - a failure BEFORE the provider call (the conversation
  read, the contact read, the breaker increment). Nothing was sent. Classified
  `retryable`.
- `ProviderSendFailedError` - the provider call threw. Carries the D1 kind, the
  code, and the reconcile facts: recipient, sender, body hash, attempt start.
- `SendAcceptedNotRecordedError` - Twilio accepted the message and the row
  write (`append`) failed. Carries the provider SID, provider timestamp and
  status. This is `accepted-send-lost-when-append-fails` piece 1.
- Failures AFTER the row is written (the inbox touch, the audit row, the SSE
  emits) no longer fail the send: they are logged at ERROR and the send returns
  its normal result. The text is out and recorded; reporting it as failed was
  the falsehood.

`SendRefusedError` and its subclasses are unchanged. Callers that catch nothing
new behave exactly as today (the new classes still extend `Error`); this branch
changes no HTTP route.

**D4. 20429 joins the throttle metric.** The adapter's `send_throttled` marker
fires on the `retryable` provider codes, which now include 20429 - today a real
Twilio rate limit is invisible to the `SendThrottled` alarm because the marker
checks `429` and `30022` only.

## 4. Decisions: what a fan-out does with each kind

Applies to `broadcastFanOut`, `sendOneRelayLeg` (and therefore both the relay
fan-out loop and the relay retry job), and, with the variant in D13, `retrySend`.

**D5. `rejected`: mark the recipient `failed` with the provider code, continue
to the next recipient.** The existing 30007 and 30005/30006 arms keep their
extra behavior (never retry; flag the contact unreachable). The kill-switch is
recorded with its own code, `sms_sending_disabled`.

**D6. `retryable`: defer the recipient to the existing continuation, continue.**
The recipient is written `queued` with the code, joins the same
`transientRemaining` set the 429/30022 arm uses, and rides the same ladder with
the same cap (`MAX_BROADCAST_ATTEMPTS` / `MAX_FANOUT_ATTEMPTS`, unchanged) and
the same backoff. A ladder that runs out closes `transient_cap` as today.

**D7. `unknown`: hand the recipient to the reconcile job, continue.** The pass
writes the slot `queued` with code `send_unconfirmed` and the attempt start as
its `sentAt`, enqueues one `send.reconcile` job for that recipient (Sec 5), and
moves on. The pass never waits for the verdict. A slot in this state is OWNED
by its reconcile job until the verdict lands.

**D8. `send_unconfirmed` slots are invisible to the cap-closes and to the
continuation's recipient set.** `closeBroadcast` and `closeRelay` skip them
(stamping one `transient_cap` would overwrite a text that may have gone out);
the continuation payload never lists them; a pass that finds one still open
does not finalize the broadcast (the verdict handler does, D16).

**D9. Outage brake.** Three consecutive `unknown` or `retryable` outcomes in one
pass end the pass early: every recipient not yet attempted is deferred to the
continuation as if `retryable`, one WARN names the count, and the pass returns.
Without it a Twilio outage costs the 30-second SDK timeout per recipient and
marks every one of them unconfirmed. `rejected` never brakes: a systemic 4xx
(bad credentials) fails every recipient quickly, visibly and honestly, and
retrying it could not help.

**D10. No new slot STATUS values.** Every state this branch introduces is an
existing status (`queued`, `failed`, `sent`) plus a code. `deriveBroadcastStats`
switches on status with no default arm and the dashboard's status maps fall
through to "Sending...", so a new status would vanish from every chip silently.

## 5. Decisions: the reconcile job

**D11. `send.reconcile` is an ordinary job with a fresh `jobId` and NO run-once
marker.** Every write it makes is conditional or idempotent (D15), so a genuine
SQS redelivery re-runs it safely - which means a throw inside it is a real
retry, and five failures reach the DLQ and page. This is the only path in the
app where "throw to retry" is true, and the job's docblock says why.

**D12. The payload carries identifiers and the reconcile facts, never a body or
a phone in the clear:** the owner reference (D16), the recipient and sender as
the digest form the relay retry claim already uses, a hash of the exact body
sent, the attempt start time, the pass's continuation context (so a `never
sent` verdict can re-drive the recipient), and the provider SID when one is
known (`SendAcceptedNotRecordedError`).

**D13. The lookup, and its three verdicts.**

- **Known SID:** no lookup. The verdict is `found` with that SID.
- **Otherwise** list the provider's messages to that recipient from that sender
  (D17), keep those created at or after the attempt start minus a small clock
  allowance whose body matches the hash, and drop any whose SID we already hold
  (a `sid#` message pointer or a `relaysid#` pointer resolves). Exactly one
  survivor: `found`. More than one survivor: `found` with the earliest, and a
  WARN - two orphans in one window means two ambiguous attempts for the same
  recipient, which the brake (D9) and the marker make practically unreachable.
- **No survivor:** re-check with backoff across a bounded window of about five
  minutes (first check no sooner than five seconds after the attempt, for the
  list lag). A window that ends with no survivor is `never_sent`.
- **Provider unreachable for the whole window** (every check threw): `unresolved`.

The re-checks are scheduled as the job's own continuations (fresh `jobId`, the
check number in the payload), not an in-process sleep: the worker's 120-second
visibility timeout forbids a five-minute handler.

**D14. No durable send-intent record.** The reconcile job's payload IS the
intent, made durable by SQS the moment the enqueue succeeds. A process death
between the ambiguous send and that enqueue leaves the slot `queued` with
`send_unconfirmed` and nothing to resolve it: the same crash window
`relay-retry-stranded-claim-window` records, closed by the same not-yet-built
sweeper. Recorded, not fixed. An enqueue that THROWS is not a crash window: the
pass closes the slot `unresolved` on the spot (D16) - the D9 precedent from the
retry-counter design.

**D15. Adoption writes the message the provider already holds.** For a `found`
verdict the handler records the SID as the send that happened: the delivery
status the list reported for it (mapped by `mapTwilioStatus`, so an
already-delivered message adopts as delivered and an already-failed one as
failed with its error code) and the provider's creation time as the send time.
Every adoption write is a conditional or forward-only write on the slot, so a
status callback that raced ahead of the adoption cannot be regressed by it and
a redelivered reconcile cannot double-adopt. Receipts that arrived BEFORE the
adoption were dropped by the fenced webhook; the adoption's status read
replaces them, which is why it reads the status rather than assuming `sent`.

**D16. Per-owner verdict handling.** The job dispatches on the owner kind in its
payload; each owner has an adopt, a re-drive and an unresolved write:

| owner | `found` (adopt) | `never_sent` (re-drive) | `unresolved` |
|---|---|---|---|
| broadcast recipient | append the message row in the tenant's 1:1 conversation with the broadcast stamp (the write `sendMessage` would have made), then the slot `sent`/`delivered`/`failed` with `conversationId`+`tsMsgId` so later receipts roll up; bump stats | enqueue a `broadcast.send` continuation for that one recipient under the existing pass cap | slot `failed` with `send_unconfirmed`; stats bucket `unconfirmed` (D22) |
| relay fan-out leg | slot from the reported status with sid and sentAt, plus the `relaysid#` pointer | enqueue a `relay.fanOut` continuation for that one member under the existing cap | slot `failed` with `send_unconfirmed` |
| relay retry rung | same as the fan-out leg, on the retry row | enqueue the same `relay.retryLeg` rung under its transient pass cap | same, on the retry row |
| 1:1 retry (`retrySend`) | append the row with the retry lineage the job would have annotated | ERROR and end the chain - the original message is visibly `undelivered`, and a second automated attempt after an ambiguous one is not worth a double text | ERROR and end the chain |

After any verdict write on a broadcast, if no recipient slot remains
non-terminal the handler finalizes the broadcast (the existing `finalize`,
which the plan must show is safe to reach from two writers). Every
`unresolved` verdict logs exactly one ERROR naming the owner and the reason;
`found` and `never_sent` log at INFO and WARN respectively.

## 6. Decisions: the adapter port and the hermetic fake

**D17. `MessagingAdapter` gains `listMessages({ to, from, createdAfter })`**
returning `{ providerSid, status, errorCode?, body, createdAt }[]`, newest
first, bounded to one page. The Twilio driver lists by `To` and `From` only and
filters on `date_created` client-side (the spike showed `DateSent` is the wrong
clock). The console driver returns what it has sent in-process. The narrow
`TwilioClientLike` seam gains an optional `messages.list`.

**D18. The lookup never logs a body or a phone.** Log lines carry SIDs, counts,
the check number and the verdict.

**D19. fake-twilio grows the Messages list route and a `fail-next-send` control
seam** with three modes, so the e2e harness can drive every branch: `reject`
(a Twilio-shaped 4xx with a chosen code), `drop_before_create` (the socket is
destroyed before any message is recorded: the app sees `unknown`, the reconcile
finds nothing, the recipient is re-driven), and `accept_then_drop` (the message
is recorded, then the socket is destroyed: the app sees `unknown`, the
reconcile finds it and adopts it). The seam is hermetic-only like every other
control route.

## 7. Decisions: dashboard

**D20. `send_unconfirmed` is presented by CODE, the way `contact_opted_out`
already is.** On a `failed` slot it renders the label "Not confirmed", danger
tone, `isFailure: false` (so no Retry that could double-send is offered), with
the reason "Couldn't confirm with Twilio whether this text went out. Check the
conversation before resending." On a `queued` slot (the seconds while the
reconcile runs) it renders exactly as a queued slot renders today. The three
render positions of a relay leg (rollup, row, accessible name) change
together, per the standing D21 rule of the retry-counter design.

**D21. The relay rollup counts an unresolved leg under "not confirmed", not
"failed".** `presentRelayDelivery`'s K (failed) excludes `failed` slots carrying
`send_unconfirmed`; they join J (not confirmed). The chip stays danger-toned and
`isFailure: false`.

**D22. Broadcast stats gain an `unconfirmed` bucket and the results page a
"Not confirmed" chip.** `deriveBroadcastStats` routes a `failed` slot with
`send_unconfirmed` there instead of `failed`; the persisted counter the
unresolved write bumps is `unconfirmed`, not `failed`, so `finalize`'s
all-failed rule does not read an all-unconfirmed broadcast as failed. The
recipient row reads "Not confirmed" with the D20 reason and no "open
conversation to retry" link.

**D23. New codes render as prose, never as fake carrier numbers.** The
app-invented codes this branch writes (`send_unconfirmed`,
`sms_sending_disabled`) go in the internal-code map; a Twilio rejection code
renders through the existing carrier map or its `(error N)` fallback, which is
correct for a real Twilio number. The pre-existing `transient_cap` copy widens
from "carrier deferrals" to "temporary errors", because D6 routes 20429 and
connection refusals through that close.

## 8. What must be proven

Test INTENTIONS; the plan specifies seams, fixtures and mechanics.

1. The classifier places every example in D1 correctly, including a twilio-node
   `RestException` with `code: 20429` (retryable), one with `code: 21211`
   (rejected), an axios timeout (unknown), and an error with no code at all
   (unknown - D2).
2. `sendMessage` throws each typed error from the step D3 names, and a failure
   after the row is written does NOT throw (D3).
3. In both fan-outs and the relay retry job: an `unknown` on recipient 3 of 5
   leaves recipients 4 and 5 attempted, recipient 3 `queued`/`send_unconfirmed`
   with a reconcile job enqueued, and no throw (D7). **Must fail on `main`.**
4. A cap-close leaves a `send_unconfirmed` slot untouched; a continuation
   payload never lists one; a pass with one open does not finalize (D8).
5. Three consecutive `unknown`/`retryable` outcomes brake the pass and defer the
   untried remainder; three `rejected` do not (D9).
6. Reconcile verdicts against a fake adapter: known SID adopts without a
   lookup; a listed orphan adopts with the reported status (a `delivered`
   listing adopts as delivered); a listing that is empty at check 1 and
   populated at check 2 adopts (the lag); an empty window is `never_sent` and
   re-drives exactly once; a throwing adapter for the whole window is
   `unresolved` with one ERROR (D13, D15, D16).
7. Adoption is idempotent: running the same `found` verdict twice writes once;
   an adoption cannot regress a slot a receipt already advanced (D15).
8. The 1:1 retry variant: `found` appends the row with lineage; `never_sent`
   ends the chain with an ERROR and no send (D16).
9. `send_throttled` fires on 20429 (D4).
10. Dashboard: `send_unconfirmed` renders "Not confirmed" / danger / not a
    failure in every relay position and on the broadcast row; the rollup counts
    it under J; the broadcast chip shows the `unconfirmed` bucket; a broadcast
    whose every recipient is unresolved finalizes `sent`, not `failed`
    (D20-D22).
11. Stats: a `failed` slot with `send_unconfirmed` lands in `unconfirmed` and in
    no other bucket (D10, D22).

**E2E (hermetic), one spec per fake mode (D19):** `accept_then_drop` on a relay
leg ends with the leg delivered and its receipt routed; `drop_before_create`
on a broadcast recipient ends with that recipient sent by the continuation and
the broadcast `sent`; `reject` with 21211 marks the recipient failed with that
code and the rest of the audience sent.

## 9. Stage 2 and the issues this branch files

The 2026-09-24 sweep found the same claim-then-throw shape at nine more sites.
None is edited here; each is filed as its own issue, citing the sweep's
findings by file:line, and grouped for the follow-on:

- **Send-shaped** (adopt the D1-D3 core; small edits once it exists):
  `messaging.retrySend`'s remaining throws, `call.missedAutoText`, the tour
  reminder poll (1:1 and group), the placement nudge poll, `relay.intro` and
  `relay.memberAdded` via `sendRelayAnnouncement`.
- **Not sends** (local error handling; no reconcile involved):
  `relay.numberReady`'s two post-flip enqueues, the pending roster-action poll,
  the voice recording callback after a successful mirror, and the pre-send
  database reads in the two announcement jobs.

Also filed, found along the way: the `no_contact` code renders as a fake
carrier error; broadcast 30003 retries never update the broadcast slot
(`retrySend` drops `broadcastId`); `deliveryStatus.ts` assumes a server-side
relay staleness alarm that does not exist; a database failure before the first
send in either fan-out (outside the per-recipient try) still strands the pass.

The anchor issue's claim that `retrySend` "does not rely on redelivery" is
corrected in the issue file: it has the same shape.

## 10. Post-merge obligations

**No infrastructure, dependency, environment or schema work.** The new counter
and codes are optional attributes; the new job name registers like every other.
The `send.reconcile` job reaches the DLQ on repeated failure, which the existing
`jobs-dlq-depth` alarm already covers.

## 11. Risks

- **D2 is the trap in the other direction.** Widening `rejected` to be "helpful"
  turns a delivered text into a Failed row with a Retry link. Every code added
  to `rejected` needs Twilio's documentation saying the request was not
  processed.
- **The reconcile job is a new writer of state four other writers already
  race on** (the pass, the continuation, the cap-close, the status webhook).
  D8 and D15 are the rules that keep it out of their way; a verdict write that
  is not conditional re-opens the class `relay-fanout-active-pass-cap-close-race`
  describes.
- **"The existing X handles this" must be traced from the new call site.** The
  retry-counter mission found several close branches unreachable from where its
  plan wanted to call them; the broadcast `finalize` from the reconcile handler
  is exactly that shape.
- **The body hash must be computed from the exact string handed to the
  provider**, after merge-field rendering and relay composition, or a real
  orphan never matches and is re-sent.
