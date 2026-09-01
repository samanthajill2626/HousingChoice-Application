# Retry counters and the cap-and-close branch - design

Bundle M5 (`docs/issues/_CLUSTERS.md`, re-derived 2026-08-31 @5ce9912f).
Branch `feat/retry-counter-durable`, cut from `main@5ce9912f`.

| sev | issue | this branch |
|---|---|---|
| high | `retry-counter-in-envelope-makes-caps-unreachable` | **closes** |
| low | `rail-binding-propagation-retry` | **closes** |
| med | `relay-30003-retry-lineage` | **deferred - see Sec 2.1** |

Design history: four adversarial review rounds plus a post-gate simplification,
`design-review/adjudications.md`.

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
branch - the code written specifically to stop a stuck state - is unreachable.
**The mechanism that advances the state is the mechanism that failed.**

This is the shape that hung a one-second prod voicemail on "Transcribing..."
indefinitely on 2026-08-16. The voice legs were patched in `a755c6f8`.

**The claim is scoped, because the blanket form is false** and building against
it produces fixes for behavior that already ships (this happened three times
during design review):

| site | state |
|---|---|
| `broadcastFanOut`, `relayFanOut` | **envelope-counted. The bug.** |
| `retrySend` (1:1) | **already durable** - the webhook reads `message.retry_attempt` off the persisted row |
| `retrySend`'s enqueue failure | **already handled** - twilio.ts:2727-2731 catches, logs ERROR, leaves the message terminal |
| `groupRail` | **already correct** - the in-repo precedent: wraps its enqueue, returns a degraded result the caller acts on |

So the code change is at **two sites**, and the fix is structural: the count
moves into a durable record and is claimed BEFORE the enqueue.

## 2. Scope

**In:**

- `app/src/jobs/broadcastFanOut.ts`, `app/src/jobs/relayFanOut.ts` - a durable
  pass counter, claimed at the top of each pass.
- `app/src/repos/messagesRepo.ts`, `app/src/repos/broadcastsRepo.ts` - the claim
  primitive.
- `app/src/services/groupRail.ts` - binding-propagation handling, job and import
  paths only (Sec 4).
- `dashboard/src/routes/contact/deliveryStatus.ts` - the 30003 copy on legs that
  have no retry (Sec 6).
- A bounded provider-status audit (Sec 5).

**Out - hard fences:**

- `routes/webhooks/twilio.ts` **in its entirety.** With relay-30003 deferred,
  this branch has no reason to touch it at all. (M4, M12, T-PUSH own it.)
- `app/src/repos/conversationsRepo.ts` - bundle M1. This constrains the rail fix
  and is why Sec 4 takes the shape it does.
- `jobs/tourReminders.ts` - `feat/tour-reminder-ladder-phase-b`.
- M1's other files: `routes/contacts.ts`, `routes/today.ts`,
  `rosterResolution.ts`.
- Delivery-chip rendering beyond the one copy fix - `T-DELIVERY-CHIPS`.
- Native Twilio group-text receipt behavior and the 1:1 retry/collapse path.

### 2.1 Why relay-30003 is deferred

`relay-30003-retry-lineage` stays **open**, re-bundled as its own mission.

Three adversarial rounds failed to converge its design. The pattern was
consistent and is documented in the adjudications: each round's blocking
findings were in the material written to close the previous round's blocking
findings, and they clustered almost entirely in the lineage state machine -
per-attempt idempotency, an atomic effective-status promotion, the pointer
write-after-send race, cap semantics, and gate-refusal accounting, all on one
DynamoDB item. The anchor issue converged after round one and stayed quiet.

That is a mission's worth of design, not a rider. Its own file lists nine
acceptance criteria spanning a new job, a new lineage store, webhook changes and
dashboard rendering.

**What actually transfers - stated precisely, because the loose version is
wrong.** M5 paired them because "the durable attempt record is what that lineage
hangs off". What this branch lands is the **pattern**: a durable counter outside
the wholesale-written slot, claimed atomically before the work, placed so every
exit advances it, with a cap branch that is therefore always reachable.

It does **not** land a counter or a store the lineage can reuse.
`fanout_attempt` is a scalar pass counter for the CONTINUATION ladder; review
established the two ladders must not share a field, since a continuation would
silently consume the retry chain's budget. The lineage mission needs its own
**per-recipient, per-attempt** structure - which is precisely the part that did
not converge here - and builds it alongside, following this branch's pattern
rather than extending its data.

**What ships in the meantime.** No relay retry exists today and none is added
here, so the dashboard's `will retry` promise on those legs is false in both
worlds. Sec 6 stops it, which is the mission's "touch the dashboard only as far
as the current chip stops lying" fence, satisfied more simply than before.

## 3. The durable pass counter

### 3.1 One scalar per item, claimed at the top of the pass

```
broadcasts.<broadcastId>.fanout_attempt = number
messages.<conversationId>#<tsMsgId>.fanout_attempt = number
```

A single top-level number, not a per-recipient map and **emphatically not a
field inside the recipient slot**. The slot is written WHOLESALE on every pass
(`setRecipientDelivery`, messagesRepo.ts:2777-2785; `setRecipient`,
broadcastsRepo.ts:584-605), so a counter living there is erased each time a
status is recorded - it would read 1 forever, **the exact bug this branch
removes, reintroduced by its own fix.** A builder must not "tidy" it back in.

**Why a scalar and not per-recipient.** Per-recipient granularity was needed by
the relay-30003 lineage, which Sec 2.1 defers. For THIS ladder it buys nothing:
recipients inside a continuation are attempted together and success is terminal,
so per-recipient counts stay in lockstep with the pass count. Review's rule was
that the two LADDERS must not share a field - not that this ladder must count
per recipient. With one ladder left, a scalar is the honest shape, and it counts
exactly what the envelope's `attempt` counted: **passes**.

The simplification is not cosmetic. It removes, rather than answers, three
findings the map version had to carry: the parent-map seeding problem, the
creation-site edit that would have reached into fenced `twilio.ts`, and the
400KB item-size question on a 1500-recipient broadcast.

### 3.2 Seeding: none required

`ADD` on an ABSENT top-level numeric attribute treats it as zero and creates it.
There is no parent document path to seed, so there is no seeding step, no
creation-site edit, and no cold-path fallback.

This also settles read-compat completely: an item written before this branch has
no `fanout_attempt`, and its first claim creates it at 1. **No backfill, no
migration, no exception handling.** In-flight envelopes carrying `attempt: N`
still parse; N selects the backoff step only.

### 3.3 The claim

One primitive per repo:

```
claimFanoutPass(<key>, cap): Promise<
  | { outcome: 'claimed'; attempt: number }
  | { outcome: 'capped';  attempt: number }
  | { outcome: 'missing' }
>
```

An atomic `ADD fanout_attempt :one`, with a `ConditionExpression` asserting the
item exists and `fanout_attempt < :cap` (`attribute_not_exists(fanout_attempt)`
covering the zero case). `claim.attempt` is read from
`ReturnValues: 'UPDATED_NEW'`, which now returns **a single number** - the claim
never re-reads the item to learn its own result, and there is no payload concern
to weigh.

On `ConditionalCheckFailedException`, a **strongly consistent** read
(`ConsistentRead: true`) disambiguates `capped` from `missing`; an eventually
consistent read could report `missing` for an item that exists and skip the
close.

Atomicity matters even with one ladder: two concurrent deliveries of the same
continuation cannot both claim the same pass number.

### 3.4 Placement: at the TOP of the pass, so every exit is covered

This is the load-bearing detail, and an earlier revision got it wrong by putting
the claim at the continuation point:

```
defineJobHandler(JOB, async (raw) => {
  const payload = parse(raw);
  ...
  if (!await putJobExecutionMarker(jobId, ...)) return;   // true duplicate: no claim

  const claim = await repo.claimFanoutPass(key, CAP);     // <-- HERE
  if (claim.outcome === 'missing') { log; return; }
  if (claim.outcome === 'capped')  { await close(); return; }

  ... the send loop, which may throw ...
  ... the continuation enqueue, which may throw ...
});
```

**Claiming at the continuation point would cover only the enqueue failure.**
Each loop also carries an earlier `throw` for an unrecognised send error
(broadcastFanOut.ts:459, relayFanOut.ts:535) that never reaches the continuation
block at all.

Claiming at the top means **every** exit from the handler - unknown send error,
enqueue failure, crash, timeout - happens after the count advanced. The counter
records what was actually attempted rather than what was successfully scheduled,
which is what makes it a truthful record of the work done.

**The claim sits BEFORE the marker, and this is forced.** The obvious ordering -
marker first, so a duplicate cannot consume a pass - does not work here, because
**`jobId` is STABLE across redeliveries**:

- `buildEnvelope` mints `jobId: randomUUID()` ONCE, at enqueue (jobs.ts:188),
  and the envelope travels in the SQS message body.
- `dispatchJob` uses a complete envelope VERBATIM (jobs.ts:262); the fresh
  `randomUUID()` nearby is only for the synthesized envelope-less path. Its own
  docblock says "the new jobRunId + **the stable jobId**" (jobs.ts:286).
- `putJobExecutionMarker` is a conditional PUT with **no TTL**
  (messagesRepo.ts:2630-2649), so the suppression is permanent.

A redelivery therefore hits the marker, gets `false`, and returns. With the
claim after the marker, `fanout_attempt` would freeze at 1 forever - **the exact
frozen-counter bug this branch exists to remove.**

Claiming before the marker costs a rung to a true duplicate. That is the right
trade: a duplicate cannot double-send anyway (the per-recipient terminal-status
skip is what prevents that, not the counter), whereas a frozen counter defeats
the entire design.

### 3.4a Enqueue failure closes IMMEDIATELY

The same fact overturns the other half. An earlier revision had the handler
simply THROW on enqueue failure and rely on SQS redelivering into the cap. **A
redelivery does no work** - it is suppressed at the marker. Nothing comes back.

So on enqueue failure the handler runs the **close branch immediately** - which
is what the anchor issue proposed ("wrap each re-enqueue and, on failure, run
the cap/close branch immediately") and what `a755c6f8` did for the voice legs.

```
try {
  await enqueue(JOB, { ...payload, attempt: claim.attempt }, { runAt: backoff });
} catch (err) {
  log.error(...);
  await close();      // the ONLY path to terminal - nothing will redeliver
  return;
}
```

Round 1's objection to this (that an immediate close discards retries the
durable counter made reachable) was sound reasoning from a false premise: those
retries are not reachable, because redelivery is a no-op. The durable counter
still earns its place - it makes the cap reachable across the LEGITIMATE
continuations, each of which is a new enqueue with a fresh `jobId` - but it
cannot rescue a failed enqueue on its own.

**Pre-existing bug, discovered here and FILED, not fixed.** Both fan-outs throw
deliberately on an unrecognised send error, commented "let the job FAIL so SQS
redelivers the whole envelope (the marker is per-jobId; the redelivery is a
fresh jobId via the visibility timeout)" - broadcastFanOut.ts:456-459,
relayFanOut.ts:531-535. **That comment is false**, and `retrySend.ts:122-128`
states the truth. On `main` today that throw is a no-op that burns receive count
to the DLQ while the row stays `sending`. It is the anchor issue's symptom
through a third door, it predates this branch, and fixing it means deciding what
an unknown per-recipient error should DO - a behavior change with its own blast
radius. Sec 9 files it.

### 3.5 Cap semantics

Because the claim now counts **passes**, it counts exactly what the envelope
field counted, and the translation is one-for-one:

> `cap = MAX_FANOUT_ATTEMPTS` / `MAX_BROADCAST_ATTEMPTS`, unchanged in value and
> in meaning. The total number of send passes per recipient is identical to
> `main`.

The old code closed when `nextAttempt > MAX`; the claim refuses when
`fanout_attempt` has reached `MAX`. Same number of passes, no off-by-one - the
hazard that existed only because the map version counted enqueues instead.

A test still asserts the total provider-send count per recipient equals `main`'s
on both ladders, because this is invisible in any test that does not count.
### 3.6 The close branches are the EXISTING ones

An earlier revision claimed `broadcastFanOut`'s cap branch fails to call
`finalize()`. **That is false** - it already does. Building against the claim
would have added a second finalize.

What is true: when `enqueue` throws, no path reaches any finalize, so the
broadcast stays "Sending" forever. The fix routes that failure into the existing
close, never adding a new one.

| site | close = |
|---|---|
| `broadcastFanOut` | the EXISTING cap branch: mark remaining `failed`/`transient_cap`, bump stats, emit progress, `finalize()` |
| `relayFanOut` | the EXISTING cap branch: mark remaining `failed`/`transient_cap` |

### 3.7 Preserve relayFanOut's existing backoff exactly

`relayFanOut` selects its delay with `fanOutBackoffMs(payload.attempt ?? 1)`
while the continuation runs AS `nextAttempt` - an apparent off-by-one against
`broadcastFanOut`'s commented, deliberate choice of the next step. It sits
inside the edited region. **This branch does not change it.** It is a timing
change with its own blast radius and no issue asking for it. Do not silently
"fix" it while editing around it; if it is wrong, it is a separate issue.

## 4. Group rail binding propagation

### 4.1 What is actually wrong

The read-back is **not** verifying that Twilio performed the add. It harvests
`messagingBinding.address`, the receipt-attribution key. `buildParticipantMap`
(groupRail.ts:224-231) **skips any participant whose `address` is empty** - and
that field is what Twilio populates asynchronously. The participant exists the
instant Twilio returns 200; the binding materializes seconds later. So
`missingFromMap` reports members "missing" who are provably attached.

Measured on the 2026-08-13 migration of 132 threads: 81
`group_rail_participants_incomplete` warnings, 178
`group_rail_participant_add_failed` refusals (Twilio 50386/50437 "participant
already exists"), and 2 false `rail_failed` records for rails a direct read
minutes later showed fully bound.

### 4.2 Where the fix applies - and where it must NOT

`ensureGroupRail` has three callers:

| caller | this branch |
|---|---|
| job (`jobs/groupRail.ts:59`) | **fixed** |
| import (`lib/import/convertGroups.ts:598`) | **fixed** - and this is where the measured harm occurred |
| **inline send backstop (`groupSend.ts:381`, `healRail` :425)** | **UNCHANGED** |

**The inline path is left alone deliberately, and this is a hard constraint, not
a preference.** Two independent reasons, both discovered in review:

1. It is reached from the send route (api.ts:1361), so a re-read ladder with
   delays would sit inside a staff HTTP request.
2. Every workable variant leaked the `rail_creating` claim. That claim is
   released ONLY by `setTwilioConversation` or `recordRailFailure`
   (`conversationsRepo.ts`, the `recordRailFailure` / `setTwilioConversation`
   declarations around :979 and :1008 and their implementations at :2436 and
   :2484). A path that does neither wedges the thread until the ~5-minute
   expiry, and introducing a third release means editing
   `conversationsRepo.ts` - **a Sec 2 hard fence owned by M1.**

**How "unchanged" is expressed** - `ensureGroupRail` does not know its caller,
and the repair / `rail_failed` / 50386 rules are shared code (spec R4). Caller
identity is therefore made EXPLICIT rather than inferred: `GroupRailRequest`
gains an optional flag (default off) that the job and import callers pass to opt
IN to the propagation handling. `groupSend` passes nothing, so every shared rule
in Sec 4.3 is bypassed on that path and its behavior is bit-for-bit today's.

The measured harm came from the import path. Fixing the two job-side callers
closes the reported issue without touching the request path or the claim
lifecycle.

### 4.3 The rule

**The premise, stated explicitly.** The bulk `ConversationWithParticipants`
create returns `failures: []` **unconditionally** (groupConversations.ts:486):
it is all-or-nothing, so a 200 means Twilio accepted every participant and a
refusal throws instead. Per-member `failures` are real only on the
individual-add fallback (`attach`, groupConversations.ts:539-569). The rule
below is safe on both paths but for different reasons, and a future change
making the bulk create partial would break it silently - **so a test pins the
premise.**

> A member the create did NOT refuse is attached, on Twilio's own 200. A short
> map for that member is binding propagation. It is never a `rail_failed`.

Everything follows from that one sentence:

- **Ladder** - a short map on a fresh create triggers at most 2 bounded re-reads
  with short delays, to fill in the addresses.
- **Repair** is entered only for members the create actually refused.
- **`rail_failed`** requires a repair refusal. Not a short map, and not a member
  still unbound after the ladder.
- **50386/50437 during repair** are success-pending-re-read, not refusals - they
  are positive evidence the member is attached. Scoped to the repair of a
  freshly created rail, so the adopt path's read-back authority is untouched.
- **Still unbound after the ladder** - logged below alarm level with the
  propagation reason named; the rail proceeds.

### 4.4 What does not change

- The **adopt** path keeps its read-back as authoritative. We did not create
  those participants and have no `failures` list, so Twilio is the only source
  of roster truth there.
- **The compose gate is not weakened.** Spec 6.1 requires a participant map
  covering the roster before compose is enabled. What changes is only the
  CONCLUSION drawn from a short map on a fresh create: propagation, not damage.
  A member the create refused and repair could not attach is still a failure,
  exactly as today.
- The dead-adoptee delete-and-recreate heal, the claim protocol, and the
  deterministic UniqueName protocol are untouched.

## 5. The provider-status sweep

The high's file flags an un-done sweep: "any other place that branches on a raw
provider status string with a `!== 'success'` fallthrough has the same
exposure."

A literal grep for `!== 'success'` across `app/src` returns **zero hits**. The
real shape from the voice incident is broader: **a branch on a raw provider
status whose unenumerated default is non-terminal** ("not finished yet, keep
waiting") rather than terminal. `voiceTranscript.ts` now models the correct form.

Bounded to a definite enumeration: every site in `app/src` that branches on a
status string **received from a provider** - Twilio message/call/
transcription/conversation status, SES event type, and the media and
job-dispatch status reads. For each, record at `file:line` whether the
unenumerated default is terminal.

Disposition, **by region, not by filename** - `twilio.ts` is an anchor file of
the bundle but Sec 2 fences all of it, so a filename-scoped rule would authorize
edits the fences forbid:

- inside a region this branch already edits -> fixed here;
- anywhere else -> **filed as one new issue** with citations.

The audit is committed as a mission record either way. A sweep that finds
nothing is a valid result that still gets written down.

## 6. Dashboard - stop the chip lying

**The problem.** `ERROR_CODE_REASONS['30003']` is
`'Phone unreachable - will retry'` (em dash in the live string). For relay
fan-out legs and native group-text legs **no retry is scheduled** - the relay
pointer branch of `/status` returns before the 1:1 retry branch - and this
branch does not add one. The promise is false.

**The mechanism already exists.** `deliveryReason(errorCode, opts)`
(deliveryStatus.ts:628-640) already selects `MMS_ERROR_CODE_REASONS` over
`ERROR_CODE_REASONS` from an `opts.media` flag. The fix follows that precedent
exactly: a sibling override map selected by a new opt, passed by
`presentRelayDelivery` (deliveryStatus.ts:387-416), which already calls
`deliveryReason(s.errorCode, opts)`.

**Native group text DOES get a retry - verified, and it changes the scope.** An
earlier revision widened the fix to every leg `presentRelayDelivery` renders, on
the assumption that group-text legs get no retry either. **That assumption is
false.** The 30005/30006 arm (twilio.ts:2633) and the 21610 arm (:2691) each
carry an explicit `group_text` guard; **the 30003 arm carries none**, so a
native group-text message's 30003 reaches `enqueueSendRetry` like any 1:1.

So the copy change is scoped to **relay legs only**, and the presenter is told
which it is rather than inferring it.

| surface | 30003 copy |
|---|---|
| 1:1 bubble | `Phone unreachable - will retry` - **unchanged, correct**: a retry is scheduled |
| native group-text legs | **unchanged, correct**: the 30003 arm has no group guard, so a retry is scheduled |
| broadcast badge | unchanged |
| **relay fan-out legs** | **`Phone unreachable`** - no retry exists, here or after this branch |

**All FOUR `deliveryReason` call sites are updated, not just the rollup.**
Fixing `presentRelayDelivery` alone would leave the per-recipient row beneath
the chip still promising a retry the rollup above it had stopped promising -
breaking the invariant `Timeline.tsx` states in its own comment at :1035-1042
("One `isMms` feeds the rollup, this row and the accessible name, so the three
cannot disagree"). The sites are `Timeline.tsx:582`, `:849`, `:1045`, `:1390`
plus the `presentRelayDelivery` pass-through at `deliveryStatus.ts:416`; each
receives the same relay discriminator its `media` flag already travels beside.

**On touching `Timeline.tsx`.** `_CLUSTERS.md` lists it under
`T-DELIVERY-CHIPS`, but that is **Tier 2** - unscheduled backlog, not the
ordered mission queue - and no live worktree is touching `Timeline.tsx` or
`deliveryStatus.ts` (checked across all ten). Cameron authorized the edit on
that basis. A partial fix here would be worse than none.

The `(error 30003)` tail is appended by `deliveryReason` itself and is
unchanged; the override supplies only the phrase. The em dash in the untouched
1:1 string stays byte-identical - it is pre-existing text, and the ASCII rule
governs newly authored lines.

`ERROR_CODE_REASONS` is dashboard presentation, not automated send copy, so the
message-catalog rule does not apply (its own comment at :606 says so).

## 7. Testing

### Unit / integration (vitest, DynamoDB Local)

1. **The counter survives a status write** - the regression test for the defect
   that nearly shipped (Sec 3.1). Claim, then perform a normal per-recipient
   status write, then read the count back: it must still be there. **Fails
   against any design that puts the counter in the slot.**
2. **Claim is atomic** - concurrent claims on one key yield distinct numbers;
   exactly one reaches the cap boundary.
3. **A dead queue reaches a terminal state in ONE pass** - `enqueue` stubbed to
   always throw. The close runs immediately (Sec 3.4a): the broadcast finalizes
   with no recipient left `queued` and stops showing "Sending"; relay marks
   every deferred recipient `failed`. **This is the regression test for the
   anchor bug and must fail on `main`.** It must NOT be written as "throw, then
   redeliver, then reach the cap" - redelivery is suppressed by the marker, so
   such a test would pass vacuously while proving nothing.
4. **The broadcast row leaves "Sending"** on that path - asserted on the row,
   not a log line.
5. **The claim advances across legitimate continuations** - a successful
   continuation chain walks `fanout_attempt` 1, 2, 3 and closes at the cap.
6. **Total send count is unchanged from `main`** on both ladders (Sec 3.5).
7. **Claim against a pre-branch item** - an item with no `fanout_attempt`
   attribute claims successfully at 1 (`ADD` creates it), with no seeding step.
7a. **The claim precedes the execution marker** - pinned by construction, since
   the ordering is forced by `jobId` stability (Sec 3.4) and would otherwise be
   an inviting "tidy". Assert that a redelivered envelope carrying the SAME
   `jobId` still advances `fanout_attempt`, even though the handler returns at
   the marker.
7b. **A duplicate delivery still cannot double-send** - the per-recipient
   terminal-status skip, not the counter, is what guarantees this. Assert no
   second provider send for an already-`sent` recipient.
8. **Rail** - a create whose participants have no binding yet resolves without
   repair and without a `rail_failed`; a create with a real per-member failure
   still repairs; 50386/50437 during repair is not a refusal; the adopt path is
   unchanged. **The inline path is pinned by CONSTRUCTION, not by adjective**:
   assert `groupSend` calls `ensureGroupRail` without the opt-in flag, and that
   with the flag absent the ladder, the repair-scoping and the 50386 handling
   are all skipped. ("Byte-identical to `main`" is not an assertion a test can
   make.)
9. **The bulk-create premise is pinned** - `ConversationWithParticipants`
   returning `failures: []` is all-or-nothing (Sec 4.3). If it ever returns 200
   with a partial roster, this test fails rather than the rule breaking silently.
10. **Chip copy, all four call sites** - a relay 30003 leg renders
    `Phone unreachable` with the `(error 30003)` tail in the rollup, the
    per-recipient row and the accessible name, so the three cannot disagree;
    **1:1, native group text and the broadcast badge are unchanged**.

### E2E (Playwright, hermetic)

11. **The relay 30003 copy**, end to end: a relay leg that failed 30003 shows
    `Phone unreachable` and promises no retry. This is the user-facing change
    this branch actually makes, and it is reachable through the existing seeded
    world.

    **The broadcast dead-queue case is NOT an e2e test.** Nothing in the
    hermetic stack can make `enqueue` throw, and adding a seam for it means
    editing `routes/dev.ts`, which is out of scope. That behavior is covered at
    integration level (tests 3 and 4), where `enqueue` is stubbable - which is
    the right level for it regardless.

## 8. Risks and watch items

- **`relayFanOut.ts` is a conflict surface** with M2, M3 and T-DELIVERY-CHIPS.
  Keep the diff to the claim at the top of the handler plus the continuation/cap
  region.
- **The claim's PLACEMENT is the fix, not just its existence** (Sec 3.4). A
  reviewer or a later refactor that moves it down next to the enqueue "where it
  is used" silently reopens the unknown-error path. Test 7a is what catches
  that; do not delete it as redundant with test 3.
- **Do not touch `twilio.ts`.** With relay-30003 deferred there is no reason to,
  and three other bundles own parts of it.
- **Do not touch `conversationsRepo.ts`** - it is what forces Sec 4.2's shape.
- **The slot type stays untouched** (Sec 3.1). A later change that moves a field
  back into the slot re-opens `dashboard/src/api/types.ts` and native group text.
- **`npm test` contention**: three other missions share this machine and one
  DynamoDB Local container. A red `npm test` is not a regression until proven
  under a clean access key and compared against the merge base by failing FILE.
- **`reuseExistingServer` adopts a stale stack on a commit match.** Confirm no
  orphaned listener on the lane's ports before each e2e run.

## 9. Post-merge obligations

**No infrastructure, dependency, or environment work.** No new dependencies, no
infra change, no env var, no schema migration - the new attribute is optional
and self-seeding (Sec 3.2).

Three non-infra obligations, all owed at handback rather than after merge:

0. **`throw-for-redelivery-defeated-by-job-marker` is filed** (done - severity
   high). Discovered while verifying whether a post-throw redelivery could
   advance the counter. It cannot, and both fan-outs rely on it doing so. This
   branch does not fix it: the remedy requires deciding what an unrecognised
   per-recipient send error should DO, which is a behavior change with its own
   blast radius. Sec 3.4a records how this branch works around it.
1. **The provider-status audit's out-of-region findings are filed as an issue**
   (Sec 5).
2. **`relay-30003-retry-lineage` is updated** - and it must carry the DESIGN
   KNOWLEDGE, not just the fact of the split. Three review rounds bought these,
   and a future mission that has to rediscover them pays for them twice. The
   issue records:

   - it is now its own mission; what transfers from this branch is the pattern
     and primitives, not a reusable counter (Sec 2.1);
   - **the effective-status trap**: `ALLOWED_PRIOR.delivered` is
     `['queued','sent']`, so "a delivered retry wins" needs an explicit scoped
     transition - the forward-only machine forbids it outright;
   - **the idempotency trap**: gating a retry claim on the slot transition caps
     the ladder at ONE retry, invisibly, because a second `undelivered` cannot
     transition an already-`undelivered` slot. The gate belongs on the attempt
     record. Any test exercising a single retry passes against the broken form;
   - **the fence**: `relayAnnouncements.ts:289` writes relaysid pointers for
     intro, member-added and tour-reminder rung sends, so a retry keyed on "the
     pointer resolved" reaches `jobs/tourReminders.ts`. Announcement legs have
     no source message to replay and must be excluded structurally;
   - **the copy debt this branch creates**: relay legs now read
     `Phone unreachable` with no retry promise. When the lineage ships, that
     copy becomes wrong in the other direction and must be revisited at all four
     `deliveryReason` call sites (Sec 6). Native group text and 1:1 are NOT
     affected - their 30003 retry is real.
