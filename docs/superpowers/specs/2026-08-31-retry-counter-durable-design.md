# Retry counters and the cap-and-close branch - design

Bundle M5 (`docs/issues/_CLUSTERS.md`, re-derived 2026-08-31 @5ce9912f).
Branch `feat/retry-counter-durable`, cut from `main@5ce9912f`.

Issues closed by this branch:

| sev | issue |
|---|---|
| high | `retry-counter-in-envelope-makes-caps-unreachable` |
| med | `relay-30003-retry-lineage` |
| low | `rail-binding-propagation-retry` |

## 1. The invariant

**If the mechanism that advances state fails permanently, does this path still
reach a terminal state?**

Every capped retry loop in `app/src/jobs` currently answers NO. The loop
advances its attempt counter by writing `attempt + 1` into the envelope it
enqueues:

```
if (nextAttempt > MAX_ATTEMPTS) { close(); return; }   // the safety net
await enqueue(JOB, { ...payload, attempt: nextAttempt }, { runAt: backoff });
```

The counter only moves when the queue accepts the message. A broken queue
freezes the counter, so `nextAttempt` is recomputed identically forever and the
close branch above - the code written specifically to stop a stuck state - is
unreachable. **The mechanism that advances the state is the mechanism that
failed.**

This is the shape that hung a one-second prod voicemail on "Transcribing..."
indefinitely on 2026-08-16. The voice legs were patched in `a755c6f8`; the
same shape is still live at three sites.

The fix is structural, not defensive: **the count moves into the durable
per-recipient record and is claimed BEFORE the enqueue.** A dead queue then
still advances the count, still reaches the cap, and still runs the close.

## 2. Scope

### In scope

- `app/src/jobs/broadcastFanOut.ts` - durable per-recipient attempt count.
- `app/src/jobs/relayFanOut.ts` - durable per-recipient attempt count.
- `app/src/jobs/retrySend.ts` - the 1:1 chain, claim-before-enqueue.
- `app/src/jobs/relayRetrySend.ts` (NEW) - the relay 30003 retry with lineage.
- `app/src/repos/messagesRepo.ts` - attempt claim + lineage on the relay slot.
- `app/src/repos/broadcastsRepo.ts` - attempt claim on the recipient slot.
- `app/src/services/groupRail.ts` - binding-propagation re-read ladder.
- `app/src/routes/webhooks/twilio.ts` - **the status-callback branch ONLY**.
- `dashboard/src/routes/contact/deliveryStatus.ts` - the 30003 copy, only so
  far as it stops lying (Sec 8).

### Out of scope - hard fences

- **`routes/webhooks/twilio.ts` outside the `/status` handler.** Bundles M4
  (inbound group MMS detection), M12 and T-PUSH own the rest of that file.
- **`jobs/tourReminders.ts`** - owned by `feat/tour-reminder-ladder-phase-b`.
- **Bundle M1's files**: `routes/contacts.ts`, `routes/today.ts`,
  `rosterResolution.ts`, `conversationsRepo.ts`.
- **Delivery chip rendering beyond the lying copy.** One-bubble/one-row
  presentation of retry lineage, attempt disclosure, and the wider chip
  taxonomy belong to `T-DELIVERY-CHIPS`, which sequences after M5.
- **Twilio status polling / missed-callback reconciliation.** Named as
  out-of-scope by the 30003 issue itself.
- **Native Twilio group-text receipts and the existing 1:1 retry/collapse
  behavior** must not change merely because the dashboard presenter is shared.

## 3. Design: the durable attempt claim

### 3.1 Where the count lives

Both fan-outs already keep a durable per-recipient slot. The count joins it.

```
broadcasts.recipients.<contactKey> = {
  status, errorCode,
  attempt?: number,        // NEW - durable send-attempt count
}

messages.delivery_recipients.<memberKey> = {
  status, sid, errorCode, sentAt, deliveredAt,
  attempt?: number,        // NEW - durable send-attempt count
  attempts?: RelayAttempt[],   // NEW - lineage (Sec 5)
}
```

Per-recipient rather than per-job is deliberate. It is the granularity the
30003 lineage needs, it makes each recipient's retry depth independently
truthful, and it does not change effective retry budget: recipients inside one
continuation are attempted together, and success is terminal, so per-recipient
counts stay in lockstep with the batch counts they replace.

### 3.2 The claim

A new repo primitive, at both repos:

```
claimRecipientAttempt(<keys>, memberKey, cap): Promise<
  | { outcome: 'claimed'; attempt: number }
  | { outcome: 'capped'; attempt: number }
  | { outcome: 'missing' }
>
```

Implemented as a conditional `ADD ... :one` on the slot's `attempt` with
`ConditionExpression` asserting the slot exists AND `attempt < cap` (with
`attribute_not_exists(attempt)` as the zero case), returning
`ReturnValues: 'UPDATED_NEW'`. A `ConditionalCheckFailedException` is
disambiguated by a follow-up read into `capped` vs `missing`.

Atomic `ADD` matters: two concurrent callbacks for the same recipient cannot
both claim the same attempt number.

### 3.3 The handler shape

Every retry site becomes:

```
const claim = await repo.claimRecipientAttempt(keys, memberKey, CAP);
if (claim.outcome === 'missing') { log; return; }        // nothing to advance
if (claim.outcome === 'capped')  { await close(); return; }   // ALWAYS reachable

try {
  await enqueue(JOB, { ...payload, attempt: claim.attempt }, { runAt: backoff });
} catch (err) {
  // Belt AND braces: the count already advanced, so a later delivery would
  // reach the cap anyway - but nothing will deliver, so close NOW.
  log.error(...);
  await close();
  return;
}
```

Two independent guarantees, deliberately kept both:

1. **Structural** - the count advanced before the enqueue, so the cap is
   reachable on the next callback/redelivery whatever the queue does.
2. **Immediate** - the catch runs the close now rather than leaving the entity
   non-terminal until some later event that may never come.

The envelope's `attempt` field is retained but becomes **advisory**: it is
logged and used for backoff selection, never for the cap decision. Payload
parsers keep accepting it for in-flight envelopes.

### 3.4 Read-compat

A slot with no `attempt` attribute is treated as zero and claimed to 1. In-flight
envelopes carrying `attempt: N` still parse; their N is used only for the
backoff step. No backfill migration. The durable value is authoritative from
first claim onward.

### 3.5 Per-site close branches

| site | close = |
|---|---|
| `broadcastFanOut` | mark remaining recipients `failed`/`transient_cap`, bump stats, emit progress, **and call `finalize()`** - today the continuation returns without finalizing, which is why a broken queue leaves the broadcast "Sending" forever |
| `relayFanOut` | mark remaining recipients `failed`/`transient_cap` |
| `retrySend` (1:1) | leave the message terminally undelivered; the 30003 copy (Sec 8) stops promising a retry |
| `relayRetrySend` | close the recipient's lineage terminal-undelivered (Sec 5) |

`broadcastFanOut`'s missing `finalize()` is the single most user-visible defect
in the bundle and is a required part of the fix, not a side effect.

## 4. Design: relay 30003 retry

### 4.1 The current lie

A relay recipient that returns Twilio 30003 reaches a contradictory terminal
state: Twilio marked the physical SID `undelivered`, the dashboard says
`Phone unreachable - will retry`, and **nothing is scheduled**. The relay
SID-pointer branch in `/status` updates the slot and returns before the generic
30003 `messaging.retrySend` branch is ever reached, and that branch is built for
1:1 messages anyway.

Reusing the 1:1 path is not acceptable: it creates a new provider SID *and a new
persisted message row*. A relay message is stored once with one delivery slot
per recipient, so a 1:1-style retry would produce duplicate timeline bubbles
with conflicting statuses.

### 4.2 Lineage model

**One logical relay message. One visible delivery row per recipient. Multiple
physical provider attempts recorded under that row.**

```
delivery_recipients.<memberKey> = {
  status:   DeliveryStatus,   // the EFFECTIVE recipient status
  sid:      string,           // the CURRENT (latest) attempt's provider SID
  attempt:  number,           // durable claim counter (Sec 3)
  attempts: [
    { n: 1, sid: 'SMaaa', status: 'undelivered', errorCode: '30003',
      sentAt: '...', resolvedAt: '...' },
    { n: 2, sid: 'SMbbb', status: 'delivered', sentAt: '...', deliveredAt: '...' },
  ],
}
```

Each `relaysid` pointer gains the attempt number `n`, so a callback resolves to
`(conversationId, tsMsgId, memberKey, n)` and updates the right attempt.

### 4.3 The retry job

`relay.retrySend` (`app/src/jobs/relayRetrySend.ts`). Payload carries
**identifiers only**:

```
{ relayConversationId, sourceTsMsgId, memberKey, senderNameOverride?, attempt }
```

The handler re-reads the durable source message and reconstructs the outbound
exactly as `relayFanOut` does - `composeRelayBody(senderName, body)` with the
same sender-label resolution, and `mediaAttachmentsOf()` **re-presigned fresh
per attempt** (never replaying a stored presigned URL; the `retrySend` rule at
`RETRY_PRESIGN_TTL_SECONDS`). `senderNameOverride` rides the payload exactly as
it already does on the fan-out continuation, so a sender rename between the
original and the retry cannot change the relayed text.

Duplicate-delivery guard: the existing `putJobExecutionMarker(jobId, ...)`
pattern, identical to `retrySend`.

### 4.4 Pre-send gates, re-run per attempt

Before each retry the job re-runs the applicable relay send gates:

1. The group is still open (not closed/archived).
2. The member/phone relationship is still valid **and unchanged** - see 4.5.
3. The recipient is not suppressed and has not opted out
   (`isMemberSuppressed`).
4. Global send gates (breaker, manual mode, `smsSendingEnabled`) via the same
   refusal machinery, treated as `SendRefusedError`.

A refusal **ends the retry chain without sending** and writes truthful
operator-facing copy onto the row. It is not a job failure.

### 4.5 Changed destination - refuse

If the member's phone differs from the phone the failed attempt was sent to,
the retry is **refused** and the row goes terminal-undelivered. The issue
forbids silently redirecting an old failed leg to a newly changed number; this
branch reads that as "do not redirect at all". A staff member who wants the
message at the new number sends it deliberately.

### 4.6 Backoff and cap

60s / 120s / 240s, cap 3 - **identical to the 1:1 policy** in
`retrySend.retryBackoffMs` / `MAX_SEND_RETRY_ATTEMPTS`.

Matching is load-bearing, not cosmetic. The open decision in
`quiet-hours-ungated-automated-paths` recommends accepting automatic delivery
retries as an explicit quiet-hours exemption, and its stated rationale is the
bound: "a retry lands at most ~7 minutes after the original send". Relay
inherits that bound by matching the policy, so this branch adds **no new
quiet-hours exposure and no quiet-hours gate**. A divergent relay policy would
invalidate that reasoning and reopen the decision.

### 4.7 Effective status derivation

- A **delivered attempt wins permanently.** Once any attempt reaches
  `delivered`, the effective status is `delivered` and no later callback can
  regress it - including a late `undelivered` from an older attempt.
- A late/duplicate callback for a **non-current** attempt updates that
  attempt's own record and never the effective status, except for the
  delivered-wins rule above.
- The existing forward-only machine
  (`updateRecipientDeliveryStatus`) continues to guard the effective status.
  Attempt-scoped writes are child-field writes under `attempts`, so they cannot
  clobber a concurrent effective-status transition (the lesson already encoded
  in that method's spec-15.2b comment).
- The existing message-refresh event is emitted after each **effective**
  transition, not per attempt.

### 4.8 Idempotency matrix

| event | required outcome |
|---|---|
| duplicate Twilio callback (same SID, same status) | no duplicate claim, no duplicate text |
| duplicate queue delivery of `relay.retrySend` | job marker suppresses; no second provider send |
| two concurrent 30003 callbacks for the same recipient | atomic `ADD` lets exactly one claim attempt N |
| out-of-order callbacks across attempts | effective status obeys forward-only + delivered-wins |
| callback for an attempt whose retry was refused | recorded on the attempt; chain already terminal |

## 5. Design: group rail binding propagation

### 5.1 What is actually wrong

The read-back is **not** verifying that Twilio performed the add. It is
harvesting `messagingBinding.address`, which is the receipt-attribution key.
`buildParticipantMap` (`groupRail.ts:224-231`) skips any participant whose
`address` is empty - and that field is what Twilio populates asynchronously.
The participant exists the instant Twilio returns 200; the binding materializes
seconds later. So `missingFromMap` reports members "missing" who are provably
attached.

Cost, measured on the 2026-08-13 migration of 132 threads: 81
`group_rail_participants_incomplete` warnings, 178
`group_rail_participant_add_failed` refusals (Twilio 50386/50437 "participant
already exists"), and 2 false `rail_failed` records for rails a direct read
minutes later showed fully bound.

### 5.2 The fix

On a **freshly created** rail, authority for "is this member attached" comes
from the create's own per-member `failures`
(`createConversationWithParticipants` already returns them), **not** from map
coverage.

- Members absent from `failures` are attached. A short map for them is binding
  propagation.
- Short map on a fresh create -> **bounded re-read ladder**: re-read
  participants after a short delay, at most 2 bounded retries, to fill in the
  addresses.
- **Repair** is entered only for members the create actually refused.
- **`rail_failed`** is recorded only for members repair also refused.
- Per-member 50386/50437 during repair are treated as **success pending
  re-read**, not refusals - they are positive evidence the member is attached.
- Members still unbound after the ladder are logged at a level that does not
  feed the error alarm, with the propagation reason named.

### 5.3 What does not change

- The **adopt** path keeps its read-back as authoritative. We did not create
  those participants and have no `failures` list, so Twilio is the only source
  of roster truth there.
- **The compose gate is not weakened.** Spec 6.1 requires a participant map
  covering the roster before compose is enabled - a short map would send to a
  subset while the UI showed the whole group and leave the absent member's
  receipts unattributable. The ladder fills the map; it does not bypass the
  check. A rail that is still short after the ladder and after repair is still
  a failure.
- The dead-adoptee delete-and-recreate heal, the claim, and the deterministic
  UniqueName protocol are untouched.

## 6. The unfiled provider-status sweep

The high's file flags an un-done sweep: "any other place that branches on a raw
provider status string with a `!== 'success'` fallthrough has the same
exposure."

A literal grep for `!== 'success'` across `app/src` returns **zero hits**, so
the sweep as literally worded finds nothing. The real shape from the voice
incident is broader: **a branch on a raw provider status whose unenumerated
default is non-terminal** ("not finished yet, keep waiting") rather than
terminal. `voiceTranscript.ts` now models the correct form - only
`'not-completed'` is non-terminal and everything else falls through to the
terminal stamp.

This branch runs that sweep as a **read-only audit** over every provider-status
branch in `app/src` (messaging, voice, media, email, group conversations,
job dispatch). Findings inside M5's anchor files are fixed here. Findings
outside them are **filed as a new issue** with `file:line` citations rather
than dragged into this branch's diff. The audit result is committed as a
mission record either way - the sweep is not dropped.

## 7. Testing

### Unit / integration (vitest, DynamoDB Local)

1. **Claim is atomic** - concurrent claims on one slot yield distinct attempt
   numbers; exactly one reaches the cap boundary.
2. **Cap reachable with a dead queue** - `enqueue` stubbed to always throw:
   broadcast reaches `finalize()` and leaves no recipient `queued`; relay marks
   every deferred recipient `failed`. This is the regression test for the
   anchor bug and must fail on `main`.
3. **Broadcast finalize on enqueue failure** - the broadcast row leaves
   "Sending". Asserted on the row, not on a log line.
4. **Counter survives a frozen envelope** - replaying the identical envelope
   repeatedly advances the durable count and terminates.
5. **Relay 30003** - one callback claims and enqueues exactly one retry;
   duplicate callback sends no duplicate text; other members receive nothing.
6. **Relay cap** - exhausted chain is terminal-undelivered and stops promising
   a retry.
7. **Relay gate refusals** - closed group / suppressed member / opted out /
   changed destination each end the chain without sending.
8. **Out-of-order + delivered-wins** - a late `undelivered` from attempt 1
   cannot regress an effective `delivered` from attempt 2.
9. **MMS retry** - preserves original content and presigns fresh; never
   replays a stored URL.
10. **Rail ladder** - a create whose participants have no binding yet resolves
    without entering repair and without a `rail_failed`; a create with a real
    per-member failure still repairs; 50386/50437 during repair is not a
    refusal; the adopt path is unchanged.

### E2E (Playwright, hermetic)

11. A relay group with one failing leg: the recipient shows retrying, then
    delivered-on-retry, with **one** message bubble and **one** row for that
    recipient - never duplicate conflicting sends.

## 8. Dashboard - the fence

The only dashboard change is that the chip stops lying.

`ERROR_CODE_REASONS['30003']` is currently the unconditional string
`'Phone unreachable - will retry'`. It becomes **context-aware**: the retry
promise appears only when a retry was actually claimed and is pending.
Otherwise the copy is `Phone unreachable` and the final error code stays
exposed.

Everything else about the chip - lineage disclosure, attempt detail,
one-bubble presentation rules, the wider taxonomy - is `T-DELIVERY-CHIPS`,
which sequences after M5 and renders what this branch's lineage produces.

New operator-facing copy goes through the message catalog per the repo rule.

## 9. Risks and watch items

- **`relayFanOut.ts` is a conflict surface** with M2, M3 and T-DELIVERY-CHIPS.
  Keep the diff inside the continuation/cap region and the new retry seam.
- **`twilio.ts` is a conflict surface** with M4, M12 and T-PUSH. The
  status-callback branch only, and no reordering of the pointer/message/system
  marker resolution sequence.
- **The relay branch returns before the generic 30003 branch.** The fix must
  add relay handling to the relay branch, not remove the early return - the
  early return exists so a relay leg never falls into 1:1 handling.
- **Ordering trap**: `putRelaySidPointer` is written AFTER the provider send
  returns, so a fast callback can outrun it. The existing single-retry lookup
  window in `/status` covers this and must keep covering it for retry
  attempts - a new attempt's pointer has the same race.
- **`npm test` contention**: three other missions share this machine and one
  DynamoDB Local container. A red `npm test` is not a regression until proven
  under a clean access key and compared against the merge base by failing FILE.
- **`reuseExistingServer` adopts a stale stack on a commit match.** Confirm no
  orphaned listener on the lane's ports before each e2e run.

## 10. Post-merge obligations

None expected. No new dependencies, no infrastructure change, no schema
migration (new attributes are optional and read-compatible), no
environment-variable change.
