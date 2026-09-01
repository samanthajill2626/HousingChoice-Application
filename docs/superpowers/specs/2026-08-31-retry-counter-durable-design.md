# Retry counters and the cap-and-close branch - design

Bundle M5 (`docs/issues/_CLUSTERS.md`, re-derived 2026-08-31 @5ce9912f).
Branch `feat/retry-counter-durable`, cut from `main@5ce9912f`.

| sev | issue | this branch |
|---|---|---|
| high | `retry-counter-in-envelope-makes-caps-unreachable` | **closes** |
| low | `rail-binding-propagation-retry` | **partly** - three of five callers (Sec 4.3) |
| med | `relay-30003-retry-lineage` | **deferred - Sec 2.1** |

**This document states decisions, not their history.** Eight review rounds
produced it; the reasoning, the rejected alternatives and the four corrected
misattributions live in `design-review/adjudications.md`. Where a decision is
counter-intuitive the body says WHY, but it never argues with an earlier draft -
a builder has only this file, and rebuttal-style prose left two sections
disagreeing after one of them was edited.

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
freezes it, `nextAttempt` is recomputed identically forever, and the close
branch - written specifically to stop a stuck state - is unreachable. **The
mechanism that advances the state is the mechanism that failed.**

This is the shape that hung a one-second prod voicemail on "Transcribing..."
indefinitely on 2026-08-16 (patched for voice in `a755c6f8`).

**Only two sites have this bug.** The blanket form of the claim is false, and
building against it produces "fixes" for shipping behavior:

| site | state |
|---|---|
| `broadcastFanOut`, `relayFanOut` | **envelope-counted. The bug.** |
| `retrySend` (1:1) | already durable - the webhook reads `message.retry_attempt` off the persisted row |
| `retrySend`'s enqueue failure | already handled - twilio.ts:2727-2731 catches, logs ERROR, leaves the message terminal |
| `groupRail` | already correct - wraps its enqueue, returns a degraded result the caller acts on |

## 2. Scope

**In:**

- `app/src/jobs/broadcastFanOut.ts`, `app/src/jobs/relayFanOut.ts` - the durable
  pass counter and three close paths (Sec 3).
- `app/src/repos/messagesRepo.ts`, `app/src/repos/broadcastsRepo.ts` - the claim
  primitive (Sec 3.3).
- `app/src/services/groupRail.ts` - the propagation re-read ladder and the
  opt-in flag on `GroupRailRequest` (Sec 4).
- `app/src/jobs/groupRail.ts`, `app/src/lib/import/convertGroups.ts`,
  `app/scripts/rail-verify.ts` - the three callers that pass that flag. One line
  each (Sec 4.3).
- `dashboard/src/routes/contact/deliveryStatus.ts` - the relay 30003 copy and
  two internal-code entries (Sec 5).
- `dashboard/src/routes/contact/Timeline.tsx` - the relay leg call sites
  (Sec 5). Cameron authorized this file on 2026-09-01, after the design session
  that names this document (dated 2026-08-31) had begun: `T-DELIVERY-CHIPS` is
  Tier 2 backlog, not the ordered mission queue, and no live worktree touches
  `Timeline.tsx` or `deliveryStatus.ts`.
- A bounded provider-status audit (Sec 6).

**Out - hard fences:**

- `routes/webhooks/twilio.ts` **in its entirety** - M4, M12, T-PUSH.
- `app/src/repos/conversationsRepo.ts` - M1. This constrains Sec 4.
- `jobs/tourReminders.ts` - `feat/tour-reminder-ladder-phase-b`.
- `routes/contacts.ts`, `routes/today.ts`, `rosterResolution.ts` - M1.
- Delivery-chip rendering beyond the copy fix - `T-DELIVERY-CHIPS`.
- Native group-text receipt behavior and the 1:1 retry/collapse path.

### 2.1 Why relay-30003 is deferred

`relay-30003-retry-lineage` stays **open** as its own mission. Three review
rounds failed to converge its lineage state machine - per-attempt idempotency,
an atomic effective-status promotion, the pointer write-after-send race, cap
semantics and gate-refusal accounting, all on one DynamoDB item - while the
anchor converged after one. Its own file lists nine acceptance criteria spanning
a new job, a new store, webhook changes and dashboard rendering. That is a
mission, not a rider.

**What transfers is the pattern, not the data**: a durable counter outside the
wholesale-written slot, claimed before the work, placed so every exit advances
it, with a therefore-reachable cap. `fanout_attempt` is a scalar pass counter for
the continuation ladder and is NOT reusable by the retry ladder - the two must
not share a field, or a continuation silently consumes the retry budget. The
lineage mission builds its own per-recipient, per-attempt structure alongside.

**Interim user-visible state:** no relay retry exists today and none is added
here, so the dashboard's `will retry` on relay legs is false in both worlds.
Sec 5 stops it.

## 3. The durable pass counter

### 3.1 One scalar per item

```
broadcasts.<broadcastId>.fanout_attempt = number
messages.<conversationId>#<tsMsgId>.fanout_attempt = number
```

**Not a field inside the recipient slot.** Both slots are written WHOLESALE on
every pass - `setRecipientDelivery` (messagesRepo.ts, `SET
delivery_recipients.#mk = :d`) and `setRecipient` (broadcastsRepo.ts, the same
shape for `recipients.#ck`). A counter living there is erased each time a status
is recorded: it would read 1 forever, which is the exact bug this branch
removes. Do not "tidy" it into the slot.

**A scalar, not a per-recipient map.** Recipients inside a continuation are
attempted together and success is terminal, so per-recipient counts would stay
in lockstep with the pass count. It counts exactly what the envelope's `attempt`
counted: passes.

**Known incidental readers.** `fanout_attempt` is a new top-level attribute on
`MessageItem`, and the thread route returns message items by spread
(`api.ts` ~:2152-2165), so it ships to the browser. Harmless - nothing reads it -
but it is a reader, and the dashboard's mirrored types may warn. Do not add it
to `dashboard/src/api/types.ts`; leave it unmodelled.

**Writers that would erase it.** Any unconditional whole-ITEM `Put` of a
broadcast or message row overwrites the attribute. The seed/import paths that do
this are nominal (they create rows that have no counter yet), but a future
whole-item Put on a live row would silently reset the ladder. The claim's
`ADD` is the only writer.

### 3.2 Seeding: none

`ADD` on an ABSENT top-level numeric attribute treats it as zero and creates it.
No parent document path exists, so there is no seeding step, no creation-site
edit, and no read-compat work: an item written before this branch claims at 1.

**The one in-flight case worth naming.** An envelope enqueued BEFORE deploy and
consumed after it carries `attempt: N`, but its item has no `fanout_attempt`, so
it claims at 1 and gets a full ladder rather than the `N - 1` it had left - up
to three extra passes for that one chain. Bounded, self-correcting, affects only
envelopes in flight across the deploy, and the alternative (seeding the counter
from the envelope) would re-import the untrusted value the branch exists to stop
trusting. Accepted.

### 3.3 The claim

```
claimFanoutPass(<key>, cap): Promise<
  | { outcome: 'claimed'; attempt: number }
  | { outcome: 'capped';  attempt: number }
  | { outcome: 'missing' }
>
```

An atomic `ADD fanout_attempt :one` with a `ConditionExpression` asserting the
item exists and `fanout_attempt < :cap` (`attribute_not_exists` covering zero).
`claim.attempt` is read from `ReturnValues: 'UPDATED_NEW'`, which returns
`{ fanout_attempt: N }` - the claim never re-reads the item to learn its own
result.

On `ConditionalCheckFailedException`, a **strongly consistent** read
(`ConsistentRead: true`) disambiguates `capped` from `missing`; an eventually
consistent read could report `missing` for an item that exists and skip the
close.

**Accepted risk:** `ADD` is not idempotent, so an SDK-level transport retry that
succeeded server-side but appeared to fail could double-increment, costing one
rung. The AWS SDK's default retry policy makes this rare, and the consequence is
a shortened ladder, never a duplicate send. Not worth a transaction.

### 3.4 Placement: after the duplicate-delivery guard, before the send loop

```
defineJobHandler(JOB, async (raw) => {
  const payload = parse(raw);

  // existing duplicate-delivery guard, unchanged, INCLUDING its else-branch
  // (both handlers WARN and continue when jobId is absent)
  const jobId = getContext()?.jobId;
  if (typeof jobId === 'string' && jobId.length > 0) {
    if (!await messages.putJobExecutionMarker(jobId, ...)) return;   // duplicate
  } else { log.warn(...); }

  // existing NOTHING-TO-DO guards, unchanged and STILL ABOVE the claim:
  //   broadcastFanOut - broadcast row missing / not sending
  //   relayFanOut     - source message missing, conversation missing/closed,
  //                     no recipients, empty body-and-media, sender unresolved
  //   (five early returns in relayFanOut; none of them attempts a send)
  ...

  const claim = await repo.claimFanoutPass(key, CAP);   // <-- HERE
  if (claim.outcome === 'missing') { log; return; }
  if (claim.outcome === 'capped')  { await closeB(); return; }

  ... the send loop, which may throw ...
  ... close A / the continuation enqueue / close C (Sec 3.5) ...
});
```

**Below the marker, but below the nothing-to-do guards too.** Those guards
return without attempting any send; claiming above them would burn a rung on a
job that did nothing - the same defect as claiming above the marker, one level
down. The claim goes immediately before the first line that can cause a provider
send.

**Close B needs the row, which the guards have already loaded.** Both handlers
read their entity in those guards (the broadcast row; the source message and
conversation), so close B has what it needs without an extra read. That is
another reason the claim sits below them rather than at the top of the handler.

**AFTER the marker.** The ladder advances on CONTINUATIONS, and every
continuation is a fresh `enqueue()` - `buildEnvelope` mints a new
`jobId: randomUUID()` per enqueue (jobs.ts:188) - so a continuation always
passes the marker and always claims. Placing the claim before the marker buys
nothing and does active harm: a duplicate delivery would then consume a rung and
could itself reach `capped`, running a close that is not idempotent and can flip
a finished broadcast to failed.

**BEFORE the send loop.** Every exit from the real work - the unrecognised-error
`throw` (broadcastFanOut.ts:456-459, relayFanOut.ts:531-535), the enqueue
failure, a crash, a timeout - then happens after the count advanced. The counter
records what was ATTEMPTED, not what was successfully scheduled.

**What a redelivery does: nothing, by design.** `jobId` is stable across SQS
redeliveries (the envelope carries it in the message body; `dispatchJob` uses a
complete envelope verbatim, jobs.ts:262, and its docblock says "the stable
jobId"), and `putJobExecutionMarker` is a conditional PUT with no TTL. So a
redelivered envelope returns at the marker. That is correct duplicate
suppression - the ladder does not depend on it.

**Consequence, and it is a filed bug, not this branch's:** because a redelivery
is a no-op, the pre-existing `throw`-to-force-redelivery in both loops retries
nothing. See Sec 8 obligation 0.

### 3.5 The `nextAttempt` guard moves, and the arithmetic does NOT change

The claim's cap becomes the authority. But `nextAttempt` is used for three
different things in these loops, and only one of them is the cap. Deleting the
computation outright collapses the ladder and shifts both backoffs.

`claim.attempt` is the CURRENT pass number - identical to today's
`payload.attempt ?? 1`. Define `nextAttempt = claim.attempt + 1`, exactly as
today, and keep using it everywhere except the cap test:

| use | today | after |
|---|---|---|
| **cap test** | `if (nextAttempt > MAX_*)` | **gone** - the claim decides (close A trigger below) |
| **broadcast backoff** | `broadcastBackoffMs(nextAttempt)` | `broadcastBackoffMs(nextAttempt)` - **unchanged** |
| **relay backoff** | `fanOutBackoffMs(payload.attempt ?? 1)` | `fanOutBackoffMs(claim.attempt)` - **the same value** |
| **enqueued payload** | `attempt: nextAttempt` | `attempt: nextAttempt` - **unchanged**, now advisory |

The two files pass DIFFERENT arguments to their backoff functions on purpose -
broadcast waits the next step, relay waits the current one (Sec 3.7). Rewriting
either to a single "claim.attempt" form silently halves or doubles a real delay,
and **Test 6 would not catch it: it counts sends, not delays.** Test 6a pins the
delays.

**Close A's trigger** - the thing the deleted `if` was doing. Close A fires when
this pass is the LAST allowed one and recipients still remain:

```
if (transientRemaining.length > 0) {
  if (claim.attempt >= CAP) { await closeA(transientRemaining); return; }
  await enqueue(... nextAttempt ... backoff as above ...);   // may throw -> close C
}
```

Without this the ladder still terminates - the next pass's claim returns
`capped` and close B fires - but it wastes a job round-trip and defers the
terminal state by one backoff interval. Close A keeps the timing identical to
`main`.

**Close B is still reachable** and is not redundant: a duplicate or stale
envelope can arrive when the counter is already at the cap, having never gone
through close A.

**Cap value:** `cap = MAX_FANOUT_ATTEMPTS` / `MAX_BROADCAST_ATTEMPTS`, unchanged.
The old code closed when `nextAttempt > MAX`; close A fires when
`claim.attempt >= MAX`. Same pass count. Test 6 pins the total provider-send
count against `main`.

### 3.6 THREE closes, and only one already exists

The existing cap branch is nested inside `if (transientRemaining.length > 0)`
and closes over `transientRemaining`, a LOCAL list of the recipients THIS PASS
deferred. It is unreachable from the top of the handler, where that list is
empty. A top-of-pass close that called only `finalize()` would mark the
broadcast **sent while its recipients are still `queued`** - a silent false
success, worse than the hang.

| close | fires when | recipient set | code |
|---|---|---|---|
| **A. Continuation cap** (existing body, new trigger) | `claim.attempt >= CAP` and recipients remain (Sec 3.5) | `transientRemaining` | `transient_cap` |
| **B. Pre-send cap** (NEW) | `claimFanoutPass` returns `capped` | see below | `transient_cap` |
| **C. Enqueue failure** (NEW) | `enqueue` threw | `transientRemaining` | `enqueue_failed` |

**Close B's recipient set is NOT simply `payload.recipientKeys`** - that field is
ABSENT on a first-pass envelope, where the job derives the full audience itself.
Close B marks: `payload.recipientKeys` when present, otherwise **every recipient
on the loaded row still in a non-terminal state**. Both cases read the row the
nothing-to-do guards already loaded (Sec 3.4). A close that marked nothing on a
first-pass envelope would leave the exact stuck row this branch exists to
prevent.

**The helper differs per file - do not force one shape.** `broadcastFanOut`
marks recipients, bumps stats, emits progress and calls `finalize()`.
`relayFanOut` has **no** `finalize()`, **no** `bumpStats` and **no** progress
emit (zero occurrences in the file); its closes end after marking recipients.
Factor one helper PER FILE taking a recipient set and a code - not one shared
across both.

**C closes immediately rather than throwing.** A redelivery is suppressed at the
marker (Sec 3.4), so nothing comes back; an immediate close is the only path to
a terminal state. This is what the anchor issue prescribes and what `a755c6f8`
did for voice.

**`enqueue_failed` is a distinct code because `transient_cap` would be a lie**:
on path C nothing was retried. Sec 5.2 registers both for rendering.

### 3.7 Preserve relayFanOut's existing backoff exactly

`relayFanOut` selects its delay with `fanOutBackoffMs(payload.attempt ?? 1)`
while the continuation runs AS the next attempt - an apparent off-by-one against
`broadcastFanOut`'s deliberate choice of the next step. It sits inside the
edited region. **Do not change it.** It is a timing change with its own blast
radius and no issue asking for it; if it is wrong, it is a separate issue.

## 4. Group rail binding propagation

### 4.1 The defect

`buildParticipantMap` (groupRail.ts:224-231) skips any participant whose
`messagingBinding.address` is missing or empty - including, by design, the
projected business-number participant on every rail. Twilio populates that
binding ASYNCHRONOUSLY, so a seconds-old rail reads as short of its roster and
`ensureGroupRail` enters the repair path.

Measured on the 2026-08-13 migration of 132 threads: 81
`group_rail_participants_incomplete` warnings, 178
`group_rail_participant_add_failed` refusals (Twilio 50386/50437 "participant
already exists" - the members were there all along), and 2 `rail_failed` records
for rails a direct read minutes later showed fully bound.

### 4.2 The fix: re-read before concluding damage

**A bounded ladder, and nothing else.** On a rail created in THIS call whose map
is short, re-read participants up to **2** more times, at **500ms then 1500ms**,
before entering repair. Members whose binding appears are simply present; only
members still unbound after the ladder proceed to repair, exactly as today.

The delays are a starting point sized against a propagation window measured in
seconds, named here so they are reviewable and tunable rather than buried.

**The read-back stays authoritative, and completeness is NOT derived from the
create's `failures` list.** The code's own rationale forbids that substitution:

> "The re-read is authoritative: an add can 'succeed' and still leave a shape
> Twilio will not bind, and a repair that trusted its own return value would
> store a map that does not describe the rail." (groupRail.ts:536-538)

A create can therefore report no failure for a member who is nonetheless not
bound. `created.failures` is also collapsed to a single boolean
(`authorRefusedOnCreate`, groupRail.ts:463) and is gone by the decision point,
so using it would mean threading it forward to defeat a guarantee the file
deliberately keeps. The ladder fixes the timing false-alarm without touching the
authority model.

**The ladder applies to BOTH read-backs, and the second one is where the
measured damage happened.** `ensureGroupRail` reads participants twice: once
after create, and once after repair - and it is that POST-REPAIR read whose
short result produces the 2 false `rail_failed` records the issue cites as its
evidence. A ladder on the create read alone would leave the headline symptom
intact. Both get it, with the same bounds.

**50386/50437 handling is deliberately NOT added.** An earlier draft called for
treating those refusals as success-pending-re-read. Tracing it: repair failures
are ALREADY collected and discarded without affecting the outcome
(groupRail.ts:522-540) - the authoritative re-read decides - so the change would
alter no behavior. The 178 refusal LOG LINES come from
`adapters/groupConversations.ts:563-566`, which this branch does not edit. The
log noise is real but it is a separate, cosmetic change in an untouched file;
Sec 8 files it rather than smuggling it in as a no-op.

### 4.3 Every caller, and what each gets

`ensureGroupRail` has FIVE callers. The ladder is opt-in via a flag on
`GroupRailRequest` (default off), so caller identity is explicit rather than
inferred - the service cannot see who called it, and the repair rules are shared
code.

| caller | ladder |
|---|---|
| `jobs/groupRail.ts:59` (job) | **on** |
| `lib/import/convertGroups.ts:598` (import - where the measured harm occurred) | **on** |
| `app/scripts/rail-verify.ts:198` (operator tool - how the harm was observed) | **on** |
| `services/groupSend.ts:381` (inline send backstop) | **off** |
| `services/groupSend.ts:425` (`healRail`) | **off** |

The two `groupSend` paths are reached from the send route (api.ts:1361), so a
delay ladder there would sit inside a staff HTTP request. They keep today's
behavior exactly: with the flag absent, the ladder, the 50386/50437 handling and
the re-read scoping are all skipped.

**This means the defect remains live on the inline paths**, and the issue is
closed only for the three that opt in. Sec 8 records that honestly rather than
claiming a clean sweep.

### 4.4 Unchanged

The adopt path's read-back, the compose gate (spec 6.1 - a map must cover the
roster before compose is enabled), the dead-adoptee delete-and-recreate heal,
the claim protocol, and the deterministic UniqueName protocol.

**The adopt path faces the same propagation window and does NOT get the ladder.**
An adopted rail can be seconds old too, and the author check
(groupRail.ts:578-584) reads the same asynchronously-populated binding. It is
excluded because the measured harm was all on create, and widening the change to
a path whose read-back is the only source of roster truth deserves its own
evidence. Sec 8 records it rather than leaving it implied.

## 5. Dashboard

### 5.1 The relay 30003 copy

`ERROR_CODE_REASONS['30003']` (deliveryStatus.ts:544) reads
`Phone unreachable`, an EM DASH (U+2014), then `will retry`. It is quoted that
way here rather than reproduced, because this document is ASCII-only and a
hyphen-for-em-dash substitution in a builder's search string finds nothing. The
1:1 entry keeps that exact byte sequence; only the relay override is new text.
For relay
fan-out legs no retry is scheduled - the relay pointer branch of `/status`
returns before the 1:1 retry branch - and this branch adds none.

**Native group text is NOT included.** Its 30003 retry is real: the 30005/30006
arm (twilio.ts:2633) and the 21610 arm (:2691) each carry a `group_text` guard,
and **the 30003 arm carries none**, so a group-text 30003 reaches
`enqueueSendRetry` like any 1:1.

So the override is keyed on `rosterKind === 'relay'`. `presentLegDelivery`
already takes `rosterKind` (deliveryStatus.ts:500-505); `presentRelayDelivery`
does not and gains it, passed by its caller, mirroring the existing parameter
rather than inventing a discriminator.

**All SIX `deliveryReason` call sites, and what each gets:**

| site | surface | change |
|---|---|---|
| `deliveryStatus.ts:416` | relay/group rollup | override when relay |
| `Timeline.tsx:582` | per-leg reason | override when relay |
| `Timeline.tsx:1045` | per-recipient row | override when relay |
| `Timeline.tsx:849` | message-level 1:1 bubble | **unchanged** |
| `Timeline.tsx:1390` | **EmailCard** - not a relay leg at all | **unchanged** |
| `DeliveryBadge.tsx:31` | broadcast results badge | 30003 copy **unchanged**; see below |

**The broadcast badge is where the two internal codes surface.** For a
broadcast, `transient_cap` and `enqueue_failed` render ONLY through
`DeliveryBadge.tsx:31` - so Sec 5.2's change DOES alter what that badge shows,
including on broadcast rows that already carry `transient_cap` today. That is
the intended improvement (a raw token becomes prose), but it must not be
described as "unchanged": the 30003 relay copy leaves it alone, the internal
codes do not. Test 10 covers it.

**`rosterKind === 'relay'` is a DEFAULT, not a discriminator.** At
`Timeline.tsx:796` the value defaults to `'relay'`, so the native-group-text
exclusion holds only because one render site explicitly opts out. That is
fragile by construction: a new call site that forgets the parameter silently
inherits relay copy. Test 13 pins the group-text site explicitly rather than
trusting the default.

The three relay sites must agree: `Timeline.tsx` states the invariant in its own
comment (~:1035-1042) that one flag feeds the rollup, the row and the accessible
name so the three cannot disagree. Fixing the rollup alone would break it.

The `(error 30003)` tail is appended by `deliveryReason` for
`ERROR_CODE_REASONS` codes and is unchanged.

### 5.2 The two internal codes

`transient_cap` and `enqueue_failed` are app-invented codes that no carrier
emits and no operator can look up. Unmapped, they render through
`deliveryReason`'s fallback as `Delivery failed (error transient_cap)` -
**precisely the defect `INTERNAL_CODE_REASONS` exists to fix**, per its own
docblock (deliveryStatus.ts:591-611): plain operator copy and, deliberately, NO
`(error <code>)` tail.

Both are registered there. `transient_cap` is included even though it predates
this branch: introducing `enqueue_failed` correctly while leaving its sibling
rendering as a raw token would be half a fix in a file already being edited.

**Copy constraint.** `contact_opted_out` is precedent for the MAP but not for
the rendering path - it is deliberately intercepted before `deliveryReason` on
the per-leg path (deliveryStatus.ts:505-516) because its copy is written for the
message-level aggregate. These two codes get no interception and render in BOTH
positions from one string, so each must read correctly as a rollup summary and
on a single recipient's row. Test 10 asserts both positions.

## 6. The provider-status sweep

The anchor issue flags an un-done sweep for `!== 'success'` fallthroughs. A
literal grep returns **zero hits**; the real shape from the voice incident is a
branch on a raw provider status whose unenumerated default is NON-TERMINAL
("keep waiting") rather than terminal.

Bounded to a definite enumeration: every site in `app/src` branching on a status
string received from a provider - Twilio message/call/transcription/conversation
status, SES event type, and the media and job-dispatch status reads. Record at
`file:line` whether the unenumerated default is terminal.

Disposition **by region, not by filename** (`twilio.ts` is an anchor file but
Sec 2 fences all of it):

- inside a region this branch already edits -> fixed here;
- anywhere else -> **filed as one new issue**.

**One in-region exception, named in advance** so the rule does not collide with
Sec 3.4 mid-sweep: the unknown-error `throw` in both fan-outs is in-region and
is deliberately NOT fixed - see Sec 8 obligation 0.

A sweep that finds nothing is a valid result and is still written down.

## 7. Testing

### Unit / integration (vitest, DynamoDB Local)

1. **The counter survives a status write** - claim, perform a normal
   per-recipient status write, read the count back. **Fails against any design
   that puts the counter in the slot.**
2. **Claim is atomic** - concurrent claims yield distinct numbers; exactly one
   reaches the cap boundary.
3. **Enqueue failure reaches a terminal state in ONE pass** - close C runs: no
   recipient left `queued`, broadcast finalized and no longer "Sending".
   **Must fail on `main`.** Do NOT write this as "throw, redeliver, reach the
   cap" - a redelivery is suppressed at the marker, so such a test would pass
   vacuously.

   **The seam: `enqueue` is a module import in both jobs, not a dep on the
   handler's deps bag**, so this needs `vi.mock` of `./jobs.js` (or the
   equivalent module mock), not a stub passed through `register*JobHandler`.
   Confirm that before writing the test - a test that cannot actually make
   `enqueue` throw proves nothing and will look green.
4. **The broadcast row leaves "Sending"** on that path - asserted on the row.
5. **The ladder advances across continuations** - a chain walks
   `fanout_attempt` 1, 2, 3 and closes at the cap.
6. **Total provider-send count per recipient equals `main`'s** on both ladders.
6a. **The backoff DELAYS equal `main`'s** on both ladders, asserted on the
   `runAt` passed to `enqueue` for each pass. Test 6 counts sends and would not
   notice a ladder shifted a step (Sec 3.5); the two files pass deliberately
   different arguments and a "simplification" to one form is the likely error.
7. **All THREE closes leave the same terminal shape** - drive A, B and C; assert
   no recipient left `queued`, stats reconciled, row finalized. **B is the
   discriminating case**: against a design reusing the nested cap branch, B
   marks nothing and finalizes as SENT with recipients queued.
7a. **Close B on a FIRST-PASS envelope** - one with no `recipientKeys` - still
   marks every non-terminal recipient. This is the case where "mark
   `payload.recipientKeys`" marks nothing at all (Sec 3.6).
8. **A duplicate delivery claims nothing and sends nothing** - same `jobId`
   returns at the marker; `fanout_attempt` unchanged. This is what makes
   claim-after-marker safe.
9. **A pre-branch item claims at 1** - no `fanout_attempt` attribute, no seeding
   step.
10. **Both internal codes render as prose in BOTH positions** - rollup and
    per-recipient row, with no `(error <code>)` tail.
11. **Rail** - a fresh create whose bindings have not propagated resolves via
    the ladder without repair and without `rail_failed`; a member genuinely
    unbound after the ladder still repairs; **the POST-REPAIR read also ladders**
    (the case that produced the 2 false `rail_failed` records); the
    authoritative re-read still decides the outcome; the adopt path is unchanged.
12. **The two `groupSend` callers are unaffected** - pinned by construction:
    assert they pass no ladder flag and that with the flag absent the ladder and
    the 50386/50437 handling are skipped.
13. **Chip copy** - a relay 30003 leg renders `Phone unreachable` at all three
    relay sites; the 1:1 bubble and the EmailCard are unchanged. **Pin the
    native-group-text site explicitly**, passing `rosterKind: 'group_text'`
    rather than relying on the exclusion: `'relay'` is the DEFAULT
    (Timeline.tsx:796), so a test that omits the parameter asserts nothing.

### E2E (Playwright, hermetic)

14. A relay leg that failed 30003 shows `Phone unreachable` and promises no
    retry.

    **Arm it with `setDeliveryOutcome` (fake-twilio), not seed data.** No seed
    profile carries a `delivery_recipients` map - `e2e/support/selectors.md`
    and `group-text-per-recipient-delivery.spec.ts` both say so - so a spec
    assuming a seeded failed relay leg would assert against an empty list and
    pass while proving nothing.

    The broadcast dead-queue case is deliberately NOT e2e: nothing in the
    hermetic stack can make `enqueue` throw, and adding a seam means editing
    `routes/dev.ts`, which is out of scope. Tests 3, 4 and 7 cover it where
    `enqueue` is stubbable.

## 8. Post-merge obligations

**No infrastructure, dependency, environment or schema work.** The new attribute
is optional and self-creating.

Owed at handback, not after merge:

0. **`throw-for-redelivery-defeated-by-job-marker` is filed** (done, high).
   Both fan-outs throw on an unrecognised send error specifically to force a
   redelivery, commented "a fresh jobId via the visibility timeout". False -
   `retrySend.ts:122-128` states the truth. The suppressed redelivery returns
   SUCCESSFULLY so the consumer deletes the message: no DLQ, no alarm, nothing
   pages. And the `throw` exits the recipient loop, so one unrecognised error on
   recipient 3 of 800 strands 798. NOT fixed here - the remedy requires deciding
   what such an error should DO while preserving the never-text-twice guarantee
   the marker currently provides.
1. **The provider-status sweep's out-of-region findings are filed** (Sec 6).
1a. **Two rail follow-ups are filed** rather than smuggled in: the 178
   `group_rail_participant_add_failed` LOG LINES for 50386/50437 refusals, which
   originate in `adapters/groupConversations.ts:563-566` (a file this branch
   does not edit, and a cosmetic change with no behavioral effect - Sec 4.2);
   and the ADOPT path's exposure to the same propagation window (Sec 4.4).
1b. **`_CLUSTERS.md` M5 is amended.** It says "land the backend lineage here and
   let T-DELIVERY-CHIPS render it". This branch lands no lineage and DOES make a
   dashboard change, on Cameron's 2026-09-01 authorization. Leaving the cluster
   doc contradicting the branch would mislead whoever schedules
   T-DELIVERY-CHIPS.
2. **`rail-binding-propagation-retry` is updated, not silently closed** - the
   ladder covers the job, import and operator-tool callers; the inline
   `groupSend` and `healRail` paths keep today's behavior by deliberate choice
   (Sec 4.3), because releasing the `rail_creating` claim from a new path would
   require editing fenced `conversationsRepo.ts`.
3. **`relay-30003-retry-lineage` carries its design knowledge forward** so the
   follow-on mission does not re-buy it: `ALLOWED_PRIOR.delivered` is
   `['queued','sent']`, so "a delivered retry wins" needs an explicit scoped
   transition; gating a retry claim on the slot transition caps the ladder at
   ONE retry invisibly, so the gate belongs on the attempt record;
   `relayAnnouncements.ts:289` writes relaysid pointers for tour-reminder rungs,
   so a pointer-keyed retry reaches fenced `tourReminders.ts`; the two-level
   `retry_lineage` map WILL hit the parent-path seeding problem this branch's
   scalar avoids, and the in-repo answer is at conversationsRepo.ts:2189-2214;
   and the relay chip copy this branch sets to `Phone unreachable` must be
   revisited when a retry becomes real.

## 9. Risks and watch items

- **The claim's PLACEMENT is the fix.** Moving it next to the enqueue "where it
  is used" reopens the unknown-error path; moving it above the marker reopens
  the duplicate-close hazard. Tests 7 and 8 pin both ends.
- **`relayFanOut.ts` conflicts** with M2, M3, T-DELIVERY-CHIPS. Keep the diff to
  the claim site and the continuation/cap region.
- **When this spec says "the existing X handles this", trace X from the NEW call
  site.** Four errors in this document's review history had that exact shape - a
  mechanism credited by name without checking it was on the path in question,
  including a close branch that turned out unreachable.
- **`npm test` contention**: three other missions share this machine and one
  DynamoDB Local container. A red `npm test` is not a regression until re-run
  under a clean access key and compared against the merge base by failing FILE.
- **`reuseExistingServer` adopts a stale stack on a commit match.** Confirm no
  orphaned listener on the lane's ports before each e2e run.
