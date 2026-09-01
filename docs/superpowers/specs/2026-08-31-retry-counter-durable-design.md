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

The two fan-out continuation loops answer NO. Each advances its attempt counter
by writing `attempt + 1` into the envelope it enqueues:

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
indefinitely on 2026-08-16. The voice legs were patched in `a755c6f8`.

**Scoping the claim precisely** (spec R1, A7/B6). The blanket form "every capped
retry loop keeps its count in the envelope" is FALSE, and building against it
would produce a wrong fix:

- `broadcastFanOut` and `relayFanOut` - **envelope-counted. The real bug.**
- `retrySend` (1:1) - **already durable.** The webhook reads
  `message.retry_attempt` off the persisted row and the handler stamps it onto
  the new message. Its gap is different and much smaller (Sec 3.6).
- `groupRail` - already correct; the in-repo precedent, wrapping its enqueue and
  returning a degraded result the caller acts on.

The fix at the two real sites is structural, not defensive: **the count moves
into a durable record and is claimed BEFORE the enqueue.** A dead queue then
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

### 3.1 Where the count lives - a SIBLING map, not the slot

**The obvious home is wrong and would have produced a silent no-op.** Both
per-recipient slots are written WHOLESALE on every pass:

- `setRecipientDelivery` - `SET delivery_recipients.#mk = :d`
  (messagesRepo.ts:2777-2785)
- `setRecipient` - the same whole-slot set (broadcastsRepo.ts:584-605)

A counter stored *inside* the slot is therefore overwritten every time the
fan-out records a status. It would read 1 forever - the exact failure this
branch exists to remove, reintroduced by the fix.

So the counters live in **sibling top-level maps on the same item**, which no
whole-slot writer touches:

```
broadcasts.<broadcastId> = {
  recipients:       { <contactKey>: { status, errorCode } },   // UNCHANGED
  fanout_attempts:  { <contactKey>: number },                  // NEW
}

messages.<conversationId>#<tsMsgId> = {
  delivery_recipients: { <memberKey>: { status, sid, ... } },  // UNCHANGED
  fanout_attempts:     { <memberKey>: number },                // NEW
  retry_attempts:      { <memberKey>: number },                // NEW
  retry_lineage:       { <memberKey>: { <n>: RelayAttempt } }, // NEW (Sec 4.2)
}
```

Two consequences worth stating, because both are load-bearing:

- **`RelayRecipientDelivery` does not change.** That type is shared with native
  group text and hand-mirrored in `dashboard/src/api/types.ts`; leaving it alone
  keeps both surfaces out of this branch.
- **The two shared whole-slot writers are not edited.** Their child-write
  discipline was itself the subject of a prior fix wave; re-opening them to add
  a field is risk this design does not need to take.

### 3.2 Two ladders, two counters

`fanout_attempts` and `retry_attempts` are **separate on purpose**. The fan-out
continuation ladder (transient 429/30022, backoff 5/10/20s, cap 3) and the 30003
retry ladder (backoff 60/120/240s, cap 3) are different ladders with different
caps. One shared field would let a continuation silently consume the 30003
chain's retries.

Per-recipient rather than per-job is also deliberate: it is the granularity the
30003 lineage needs, and it does not change the effective retry budget, since
recipients inside one continuation are attempted together and success is
terminal.

### 3.3 The claim

A new repo primitive at both repos:

```
claimAttempt(<keys>, key, field, cap): Promise<
  | { outcome: 'claimed'; attempt: number }
  | { outcome: 'capped';  attempt: number }
  | { outcome: 'missing' }
>
```

Implemented as an atomic `ADD <field>.#k :one` guarded by a `ConditionExpression`
asserting the parent item exists and the count is below `cap`
(`attribute_not_exists` covering the zero case). On
`ConditionalCheckFailedException`, a **strongly consistent** read
(`ConsistentRead: true`) disambiguates `capped` from `missing` - an eventually
consistent read here could report `missing` for a slot that exists and skip the
close.

Atomic `ADD` matters: two concurrent callbacks for one recipient cannot both
claim the same attempt number.

`missing` means the parent item genuinely does not exist - there is nothing to
advance and nothing to close. It is logged, not silently swallowed.

### 3.4 The handler shape - and why the close rule SPLITS

```
const claim = await repo.claimAttempt(keys, key, field, CAP);
if (claim.outcome === 'missing') { log; return; }
if (claim.outcome === 'capped')  { await close(); return; }   // ALWAYS reachable

try {
  await enqueue(JOB, { ...payload, attempt: claim.attempt }, { runAt: backoff });
} catch (err) {
  // See below - the response depends on whether anything will redeliver.
}
```

An earlier revision closed immediately on ANY enqueue failure, described as
"belt and braces". That was a contradiction (spec R1, B5): the durable counter
exists precisely so the cap stays reachable, and closing on the first blip
**discards the retries the design just made reachable**, permanently failing a
recipient over a transient queue error. The two rules are not complementary;
they conflict.

The rule splits on whether a redelivery exists:

| site | on enqueue failure | why |
|---|---|---|
| **Consumer-side** - inside a job handler (`broadcastFanOut`, `relayFanOut`) | **THROW.** Let SQS redeliver the envelope. | The count already advanced durably, so the redelivered envelope reaches the cap and closes. A transient blip costs a redelivery, not a recipient. SQS bounds the loop via `maxReceiveCount`/DLQ. |
| **Producer-side** - inside the webhook (`enqueueSendRetry`, the relay 30003 claim) | **CLOSE NOW.** | Nothing redelivers a webhook. If the enqueue does not land, no later event will ever run the close. |

The envelope's `attempt` field is retained but becomes **advisory**: logged, and
used to select the backoff step, never for the cap decision. Payload parsers keep
accepting it so in-flight envelopes still parse.

### 3.5 Read-compat

A missing entry in a counter map is zero and claims to 1. In-flight envelopes
carrying `attempt: N` still parse; N selects the backoff step only. No backfill
migration. The durable value is authoritative from the first claim onward.

### 3.6 The 1:1 site - a different, smaller gap

`retrySend`'s count is **already durable** (`message.retry_attempt`), so nothing
moves. Its actual defect: if `enqueueSendRetry` throws in the webhook, no retry
is ever scheduled, and the dashboard goes on promising one. That is a
producer-side failure by the table above, so it closes immediately - and the
chip stops promising (Sec 8). No counter change, no new schema.

### 3.4 Read-compat

A slot with no `attempt` attribute is treated as zero and claimed to 1. In-flight
envelopes carrying `attempt: N` still parse; their N is used only for the
backoff step. No backfill migration. The durable value is authoritative from
first claim onward.

### 3.7 Per-site close branches

**Correction (spec R1, A3/B3).** An earlier revision claimed `broadcastFanOut`'s
cap branch fails to call `finalize()` and called that "the single most
user-visible defect in the bundle". **That is false.** The cap branch already
calls `await finalize(...)` before returning. Building against the false claim
would have added a second finalize.

What is true: when `enqueue` throws, **no path reaches any finalize**, so the
broadcast stays "Sending" forever. The fix routes the failure into the EXISTING
close, never adding a new one.

| site | close = |
|---|---|
| `broadcastFanOut` | the EXISTING cap branch, unchanged: mark remaining recipients `failed`/`transient_cap`, bump stats, emit progress, `finalize()` |
| `relayFanOut` | the EXISTING cap branch: mark remaining recipients `failed`/`transient_cap` |
| `retrySend` (1:1) | leave the message terminally undelivered; the chip stops promising a retry (Sec 8) |
| `relayRetrySend` | close the recipient's lineage terminal-undelivered (Sec 4) |

Since both fan-outs are consumer-side (Sec 3.4), their enqueue failure THROWS
and the close runs on the redelivery that reaches the cap. The close branches
themselves are reached through the existing code path in every case.

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

The slot itself is UNCHANGED and keeps carrying the effective status. Lineage
lives in the sibling map (Sec 3.1), keyed by member and then by attempt number:

```
delivery_recipients.<memberKey> = { status, sid, ... }   // UNCHANGED - effective

retry_lineage.<memberKey> = {
  "1": { sid: 'SMaaa', status: 'undelivered', errorCode: '30003',
         sentTo: '+1555...', senderLabel: 'Dana', sentAt, resolvedAt },
  "2": { sid: 'SMbbb', status: 'delivered',
         sentTo: '+1555...', senderLabel: 'Dana', sentAt, deliveredAt },
}
```

**A MAP keyed by attempt number, never a list** (spec R1, B10/A14). A list
cannot be created or extended by a nested child-field update, and indexed writes
would reintroduce exactly the whole-value race that child-field writes were
adopted to kill. Each attempt is an independent document path, so two attempts'
callbacks cannot clobber each other.

Two fields exist to satisfy rules stated elsewhere and would otherwise be
unimplementable:

- **`sentTo`** - the E164 actually sent to. Without it, Sec 4.5's
  changed-destination refusal has nothing to compare against: `relayMemberKey`
  is `contactId` OR `phone#<E164>` (messagesRepo.ts:152-158), so the destination
  is recoverable from the key only for phone-keyed members - precisely the ones
  whose phone cannot have changed.
- **`senderLabel`** - the resolved sender label at first send. `senderNameOverride`
  is team-send-only, so it cannot carry a member-authored relay's sender name
  (spec R1, A10). Replaying the stored label is what makes "preserve the exact
  original representation" true for member-authored relays.

Each `relaysid` pointer gains the attempt number `n`, so a callback resolves to
`(conversationId, tsMsgId, memberKey, n)`. **Read-compat**: a pointer with no
`n` is attempt 1. No backfill.

### 4.3 The retry job

`relay.retrySend` (`app/src/jobs/relayRetrySend.ts`). Payload carries
**identifiers only**:

```
{ relayConversationId, sourceTsMsgId, memberKey, attempt }
```

The handler re-reads the durable source message and reconstructs the outbound
exactly as `relayFanOut` does - `composeRelayBody(senderLabel, body)` and
`mediaAttachmentsOf()` **re-presigned fresh per attempt**, never replaying a
stored presigned URL, at the same 3600-second TTL the manual route and the relay
legs use.

The sender label comes from **`retry_lineage.<memberKey>.<n>.senderLabel`**, not
from the payload and not from a fresh roster read. `senderNameOverride` is
team-send-only and cannot carry a member-authored relay's sender name (spec R1,
A10), and a fresh roster read would let a rename between the original and the
retry change the relayed text. The label is captured at first send and replayed.

**Registration and metering** (spec R1, B13). `relay.retrySend` is a new
outbound-SMS job: it registers in `registerHandlers.ts` alongside the others and
goes through the same breaker and token-bucket metering as the fan-out. A retry
storm must trip the breaker exactly as a send storm does.

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

**The forward-only machine FORBIDS the guarantee this section needs, and an
earlier revision asserted it anyway** (spec R1, A2/B2). Verified:

```
ALLOWED_PRIOR.delivered = ['queued', 'sent']      // messagesRepo.ts:120-129
```

There is no `undelivered` predecessor. Once attempt 1 writes `undelivered`,
attempt 2's `delivered` callback is rejected as a regression by the very machine
the spec said it was keeping. "A delivered attempt wins" was a slogan the
mechanism could not deliver.

**Resolution - one scoped transition, not a loosened machine.** A new repo
method `resolveRetryDelivered(conversationId, tsMsgId, memberKey, n)` performs
the `undelivered -> delivered` effective transition, conditional on:

1. the slot's current status being `undelivered` (or `failed`), AND
2. `retry_lineage.<memberKey>.<n>.status` being `delivered`.

`ALLOWED_PRIOR` is **not** modified. Loosening it would let any caller regress a
terminal status app-wide - a far larger change than this branch is entitled to,
and one that would silently weaken the 1:1 path and native group text too.

The remaining rules:

- A **delivered attempt wins permanently.** After the scoped transition above,
  the slot is `delivered`, and `ALLOWED_PRIOR` already forbids every regression
  out of it. The guarantee now rests on the machine instead of contradicting it.
- A late/duplicate callback for a **non-current** attempt writes only that
  attempt's own lineage entry and never the effective status, except through the
  scoped transition above.
- Attempt-scoped writes are child-field writes under
  `retry_lineage.<memberKey>.<n>`, so they cannot clobber a concurrent
  effective-status transition (the lesson already encoded in
  `updateRecipientDeliveryStatus`'s spec-15.2b comment).
- The existing message-refresh event is emitted after each **effective**
  transition, not per attempt.

### 4.8 The claim is gated on the transition

The 1:1 path gates its retry on `if (transitioned && ErrorCode)` - the
forward-only transition returning true is what makes a duplicate callback a
no-op. The relay branch needs the same gate (spec R1, A6/B14): atomic `ADD`
prevents two callbacks claiming the same attempt NUMBER, but it does not by
itself stop a redelivered callback from claiming a SECOND attempt and sending a
second text.

So: **the relay retry is claimed only when
`updateRecipientDeliveryStatus` actually transitioned the slot.** A redelivered
30003 callback finds the slot already `undelivered`, transitions nothing, and
claims nothing.

### 4.9 Idempotency matrix

| event | required outcome | mechanism |
|---|---|---|
| duplicate Twilio callback (same SID, same status) | no duplicate claim, no duplicate text | the slot does not transition, so Sec 4.8's gate claims nothing |
| duplicate queue delivery of `relay.retrySend` | no second provider send | `putJobExecutionMarker(jobId)` |
| two concurrent 30003 callbacks for one recipient | exactly one claims attempt N | atomic `ADD` |
| out-of-order callbacks across attempts | effective status never regresses | `ALLOWED_PRIOR` + the scoped transition (Sec 4.7) |
| callback for an attempt whose retry was refused | recorded on the attempt; chain already terminal | lineage child write, no effective transition |
| **fan-out redelivery while a retry is in flight** | no double-send | see below |

**The last row is a real trap** (spec R1, B14). `relayFanOut` skips a recipient
whose slot is in a TERMINAL state (sent/delivered/failed) - but `undelivered`
is not in that skip set, so a redelivered fan-out envelope could re-send to a
member whose 30003 retry is already in flight. The fan-out's skip set must treat
`undelivered` as terminal for its own purposes: the retry ladder owns that
recipient from the moment the slot goes `undelivered`.

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
(`createConversationWithParticipants`, groupConversations.ts:539-569), **not**
from map coverage.

**The single rule, stated once** (an earlier revision gave two contradictory
answers for the same member - spec R1, A11/B8):

> A member the create did NOT refuse is attached, on Twilio's own 200. A short
> map for that member is binding propagation. It is never a `rail_failed`.

Everything else follows:

- **Repair** is entered only for members the create actually refused.
- **`rail_failed`** requires a repair refusal. Not a short map; not a member
  still unbound after the ladder.
- Per-member 50386/50437 during repair are **success pending re-read**, not
  refusals - they are positive evidence the member is attached.
- Members still unbound after the ladder are logged below alarm level with the
  propagation reason named, and the rail proceeds.

### 5.3 Where the ladder may run - NOT in a staff request

`ensureGroupRail` is called INLINE from `groupSend` (groupSend.ts:381, and
`healRail` at :425), which is reached from the send route (api.ts:1361). A
ladder of delayed re-reads there would sit inside a staff HTTP send (spec R1,
B16).

| path | behavior |
|---|---|
| job (`jobs/groupRail.ts:59`) and import (`lib/import/convertGroups.ts:598`) | ladder allowed: at most 2 re-reads, short fixed delays |
| **inline send backstop (`groupSend`)** | **no ladder, no repair.** A member the create did not refuse is treated as attached and the send proceeds |

The inline path is a backstop whose job is to get the message out. It does not
block a staff send to watch a binding propagate; the job path converges the rail
afterwards.

### 5.4 What does not change

- The **adopt** path keeps its read-back as authoritative. We did not create
  those participants and have no `failures` list, so Twilio is the only source
  of roster truth there.
- **The compose gate is not weakened.** Spec 6.1 requires a participant map
  covering the roster before compose is enabled - a short map would send to a
  subset while the UI showed the whole group and leave the absent member's
  receipts unattributable. What changes is only the CONCLUSION drawn from a
  short map on a fresh create: propagation, not damage. A member the create
  refused and repair could not attach is still a failure, exactly as today.
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

This branch runs that sweep as a **read-only audit**, bounded to a definite
enumeration rather than an open-ended reading of the app: every site in
`app/src` that branches on a status string **received from a provider**
(Twilio message/call/transcription/conversation status, SES event type, the
media and job-dispatch status reads). For each, the audit records whether the
unenumerated default is terminal or non-terminal, at `file:line`.

Disposition follows Sec 2's fences, which it does not override:

- inside M5's anchor files -> **fixed here**;
- outside them -> **filed as one new issue** with citations, not dragged into
  this diff.

The audit result is committed as a mission record either way - the sweep is not
dropped, and a sweep that finds nothing is a valid result that still gets
written down.

## 7. Testing

### Unit / integration (vitest, DynamoDB Local)

0. **The counter survives a status write** - the regression test for the defect
   that nearly shipped (Sec 3.1). Claim an attempt, then perform a normal
   per-recipient status write, then read the count back. It must still be
   there. This test fails against any design that puts the counter in the slot.
1. **Claim is atomic** - concurrent claims on one key yield distinct attempt
   numbers; exactly one reaches the cap boundary.
2. **Cap reachable with a dead queue** - `enqueue` stubbed to always throw. The
   handler throws, the envelope is redelivered, the durable count advances each
   pass, and the cap branch runs: the broadcast finalizes with no recipient left
   `queued`; relay marks every deferred recipient `failed`. **This is the
   regression test for the anchor bug and must fail on `main`.**
3. **Broadcast leaves "Sending"** on that path - asserted on the row, not on a
   log line.
4. **Counter survives a frozen envelope** - replaying the identical envelope
   repeatedly advances the durable count and terminates.
5. **Relay 30003** - one callback claims and enqueues exactly one retry; a
   duplicate callback transitions nothing and so claims nothing (Sec 4.8); other
   members receive nothing.
6. **Relay cap** - the exhausted chain is terminal-undelivered.
7. **Relay gate refusals** - closed group / suppressed member / opted out /
   changed destination each end the chain without sending. The changed-destination
   case compares against the stored `sentTo`.
8. **Delivered-wins via the scoped transition** - attempt 2's `delivered`
   promotes an `undelivered` slot; a late `undelivered` from attempt 1 then
   cannot regress it.
9. **MMS retry** - preserves original content, presigns fresh, never replays a
   stored URL, and replays the stored `senderLabel` rather than re-resolving it.
10. **Fan-out does not double-send** - a redelivered fan-out envelope skips a
    recipient whose slot is `undelivered` with a retry in flight.
11. **Rail** - a create whose participants have no binding yet resolves without
    repair and without a `rail_failed`; a create with a real per-member failure
    still repairs; 50386/50437 during repair is not a refusal; the inline
    `groupSend` backstop neither ladders nor repairs; the adopt path is
    unchanged.

### E2E (Playwright, hermetic)

12. A relay group with one failing leg retries to delivered, showing **one**
    message bubble and **one** row for that recipient - never duplicate
    conflicting sends.

    **This test must not wait out the real backoff.** `retryBackoffMs` starts at
    60s and is a module constant with no injection seam (spec R1, A9/B9), so a
    wall-clock test would need over a minute and would be the slowest spec in
    the suite. The flow drives the retry job's execution directly and asserts
    the lineage and effective-status transitions.

## 8. Dashboard - the fence

The only dashboard change is that **the chip stops promising a retry.**

`ERROR_CODE_REASONS['30003']` is currently the unconditional
`'Phone unreachable - will retry'` (note: the live string uses an em dash, and
`deliveryReason` appends an `(error 30003)` tail - both must be preserved
verbatim in whatever replaces it). It becomes simply `Phone unreachable`, with
the error code still exposed by the existing tail.

**Why unconditional rather than context-aware.** An earlier revision made the
copy conditional on whether a retry was actually claimed. That is not buildable
inside the fence (spec R1, A8/B7): the retry-pending signal exists on neither
the wire nor the per-leg render site, and the reason string is produced from a
message-level rollup that Sec 2 fences out. Adding a wire field and a per-leg
render site IS `T-DELIVERY-CHIPS`.

Unconditional is also the more honest minimum. Today the chip promises a retry
that never happens for relay legs; after this branch a relay retry may well
happen, but the chip is not the surface that reports it. Saying less is
truthful in both cases. `T-DELIVERY-CHIPS` adds the retry-aware variant when it
renders the lineage this branch produces.

`ERROR_CODE_REASONS` is dashboard presentation, not automated send copy, so the
message-catalog rule does not apply to it (spec R1, B15).

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
- **Preserve `relayFanOut`'s existing continuation backoff exactly.** It selects
  the delay with `fanOutBackoffMs(payload.attempt ?? 1)` while the continuation
  runs AS `nextAttempt` - an apparent off-by-one against `broadcastFanOut`'s
  commented-and-deliberate choice of the next step. It sits inside the edited
  region (spec R1, A12). This branch does NOT change it: it is a timing change
  with its own blast radius and no issue asking for it. Do not silently "fix" it
  while editing around it; if it is wrong, it is a separate issue.
- **The slot type stays untouched.** `RelayRecipientDelivery` is shared with
  native group text and hand-mirrored in `dashboard/src/api/types.ts`. The
  sibling-map design (Sec 3.1) is what keeps both out of this branch; a later
  revision that moves a field back into the slot re-opens both surfaces.

## 10. Post-merge obligations

**No infrastructure, dependency, or environment work.** No new dependencies, no
infra change, no env var, and no schema migration - every new attribute is
optional and read-compatible (Sec 3.5), so old rows and in-flight envelopes keep
working.

Two non-infra obligations the branch does create:

1. **The provider-status audit's out-of-fence findings are filed as a new
   issue** (Sec 6) - owed at handback, not after merge.
2. **`T-DELIVERY-CHIPS` inherits the rendering half**: the lineage this branch
   produces has no reader until that bundle runs. Until then the retry happens
   and is durable, but the dashboard shows only the effective status. That is a
   known, deliberate gap, not a defect.
