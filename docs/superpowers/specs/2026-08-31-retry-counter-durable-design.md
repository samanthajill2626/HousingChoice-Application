# Retry counters and the cap-and-close branch - design

Bundle M5 (`docs/issues/_CLUSTERS.md`, re-derived 2026-08-31 @5ce9912f).
Branch `feat/retry-counter-durable`, cut from `main@5ce9912f`.

| sev | issue | this branch |
|---|---|---|
| high | `retry-counter-in-envelope-makes-caps-unreachable` | **closes** |
| low | `rail-binding-propagation-retry` | **closes** |
| med | `relay-30003-retry-lineage` | **deferred - see Sec 2.1** |

Design history: three adversarial review rounds, `design-review/adjudications.md`.

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

- `app/src/jobs/broadcastFanOut.ts`, `app/src/jobs/relayFanOut.ts` - durable
  per-recipient attempt counts.
- `app/src/repos/messagesRepo.ts`, `app/src/repos/broadcastsRepo.ts` - the claim
  primitive and its seeding.
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
hangs off". What this branch lands is the **pattern and its primitives**: the
sibling-map placement, the seeding shape, the atomic claim-before-enqueue with a
reachable cap, and the repo methods implementing them.

It does **not** land a counter the lineage can reuse. `fanout_attempts` is the
CONTINUATION ladder's counter; review established that the two ladders must not
share a field, since a continuation would silently consume the retry chain's
budget. The lineage mission adds its own `retry_attempts` alongside it, built
the same way.

**What ships in the meantime.** No relay retry exists today and none is added
here, so the dashboard's `will retry` promise on those legs is false in both
worlds. Sec 6 stops it, which is the mission's "touch the dashboard only as far
as the current chip stops lying" fence, satisfied more simply than before.

## 3. Durable attempt counters

### 3.1 A SIBLING map, not the slot

**The obvious home is wrong and would have shipped a silent no-op.** Both
per-recipient slots are written WHOLESALE on every pass:

- `setRecipientDelivery` - `SET delivery_recipients.#mk = :d` (messagesRepo.ts:2777-2785)
- `setRecipient` - the same whole-slot set (broadcastsRepo.ts:584-605)

A counter inside the slot is overwritten every time the fan-out records a
status. It would read 1 forever - **the exact bug this branch removes,
reintroduced by its own fix.** A builder must not "simplify" this back into the
slot.

So the counters are sibling top-level maps on the same item:

```
broadcasts.<broadcastId>.fanout_attempts = { <contactKey>: number }
messages.<...>.fanout_attempts           = { <memberKey>:  number }
```

Consequences, both load-bearing:

- **`RelayRecipientDelivery` does not change.** It is shared with native group
  text and hand-mirrored in `dashboard/src/api/types.ts`; leaving it alone keeps
  both surfaces out of this branch.
- **The two shared whole-slot writers are not edited.** Their child-write
  discipline was itself a prior fix wave; re-opening them is risk this design
  does not need.

### 3.2 Seeding and read-compat

**A nested `ADD` on an absent parent map throws `ValidationException`**, which
under Sec 3.4's throw rule would DLQ the envelope on the very first claim. The
repo already documents this constraint for `delivery_recipients` and
`recipients`, whose parents are pre-seeded at create time so child writes are
legal.

**Two shapes are ruled OUT before the builder tries them**, because both are
already documented as rejected in the files being edited:

- **Not `SET <field> = if_not_exists(<field>, :empty)` alongside the `ADD` in
  one update.** DynamoDB rejects an UpdateExpression that touches both a map and
  a child of that map - overlapping document paths. The repo says so three
  times, in both `setRecipientDelivery` (messagesRepo.ts:2770-2776) and
  `setRecipient` (broadcastsRepo.ts:585-592).
- **Not a seed at the relay creation site.** The relay message's sibling map is
  seeded by `deliveryRecipients: {}` in `twilio.ts` - a Sec 2 hard fence. Seeding
  `fanout_attempts` there would send the builder straight into a file this
  branch must not touch.

**The shape that works: seed lazily, on the cold path only.**

```
try   ADD fanout_attempts.#k :one   (condition: item exists, count < cap)
catch ValidationException:                       // parent map absent
      SET fanout_attempts = :empty  (condition: attribute_not_exists)
      retry the ADD once
```

Two writes, but only the first time a given item is claimed against - every
later claim is one write. This needs no creation-site edit at all, which means
`broadcastsRepo`'s `markSending`, the message append, and `twilio.ts` are all
left alone, and items written BEFORE this branch work identically to new ones.

That is the entire read-compat story: no backfill, no migration, no seeding
change. In-flight envelopes carrying `attempt: N` still parse; N selects the
backoff step only.

### 3.3 The claim

One primitive, at both repos:

```
claimFanoutAttempt(<keys>, key, cap): Promise<
  | { outcome: 'claimed'; attempt: number }
  | { outcome: 'capped';  attempt: number }
  | { outcome: 'missing' }
>
```

An atomic `ADD fanout_attempts.#k :one`, guarded by a `ConditionExpression`
asserting the item exists and the count is below `cap` (with
`attribute_not_exists` covering the zero case), combined with the
`if_not_exists` parent seed from Sec 3.2.

`claim.attempt` is read from **`ReturnValues: 'UPDATED_NEW'`** - the claim never
re-reads the item to learn its own result, which would reintroduce the race the
atomic `ADD` exists to remove. `UPDATED_NEW` on a nested path returns the
enclosing `fanout_attempts` map, and the claimed value is read from it by key.

**Size, both halves.** The map holds one small number per recipient, and a
broadcast is capped at 1500 recipients.

- *Response* - `UPDATED_NEW` returns the whole map, so a claim near the cap
  returns ~1500 short-key/number pairs. Tens of kilobytes, once per continuation
  enqueue (not per recipient). Acceptable.
- *Item* - the same map is stored on an item that already carries a
  1500-entry `recipients` map of richer objects, against DynamoDB's **400KB**
  limit. The counter map is by far the cheaper of the two, but it is additive
  in the exact scenario the claim exists for. The builder measures a
  1500-recipient broadcast item's serialized size with and without it and
  records the numbers; if the margin is thin, the counter map moves to its own
  item keyed by broadcast, which the claim's interface already hides.

On `ConditionalCheckFailedException`, a **strongly consistent** read
(`ConsistentRead: true`) disambiguates `capped` from `missing`; an eventually
consistent read could report `missing` for an item that exists and skip the
close.

### 3.4 The handler shape

```
const claim = await repo.claimFanoutAttempt(keys, key, CAP);
if (claim.outcome === 'missing') { log; return; }        // nothing to advance
if (claim.outcome === 'capped')  { await close(); return; }   // ALWAYS reachable

await enqueue(JOB, { ...payload, attempt: claim.attempt }, { runAt: backoff });
// no catch: see below
```

**On enqueue failure the handler THROWS.** Both remaining sites are
consumer-side, inside a job handler, so SQS redelivers the envelope; the count
has already advanced durably, so the redelivery reaches the cap and runs the
close. A transient blip costs a redelivery, not a recipient, and
`maxReceiveCount`/DLQ bounds the loop.

An earlier revision also closed immediately in a catch, calling it "belt and
braces". It was a contradiction: the durable counter exists precisely so the cap
stays reachable, and closing on the first blip **discards the retries the design
just made reachable.** There is no producer-side site left in scope, so the rule
is simply: throw.

**Known limit, stated rather than hidden.** This makes the *enqueue* failure
reach a terminal state. The pre-existing unknown-error `throw` earlier in each
loop never reaches the claim at all, so for that path the invariant still
answers NO - bounded only by SQS's DLQ. Closing that is a larger change to the
per-recipient error taxonomy and is not in this branch.

The envelope's `attempt` field is retained but becomes **advisory**: logged, and
used to select the backoff step, never for the cap decision.

### 3.5 Cap semantics, stated numerically

The durable claim counts **enqueues** where the envelope field counted
**passes**, so the naive translation buys one extra pass - one extra real text
to a real person. The literal is therefore named, not implied.

Today: `attempt` starts at 1 on the first run, the continuation computes
`nextAttempt = attempt + 1`, and `nextAttempt > MAX_FANOUT_ATTEMPTS` closes.
With `MAX_FANOUT_ATTEMPTS = 3` that is **3 passes total** per recipient.

The claim replaces that comparison, and it is taken once per CONTINUATION
enqueue - of which there are 2 across 3 passes. So:

> **`cap = MAX_FANOUT_ATTEMPTS - 1`** (and `MAX_BROADCAST_ATTEMPTS - 1`), with
> the claim's condition being `count < cap`. The constants keep their current
> values and their current meaning; the CAP PASSED TO THE CLAIM is one less.

Getting this wrong is invisible in every test that does not count sends, so
**test 6 asserts the total provider-send count per recipient equals `main`'s**
on both ladders.

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
3. **Cap reachable with a dead queue** - `enqueue` stubbed to always throw. The
   handler throws, the envelope redelivers, the durable count advances each
   pass, and the cap branch runs: the broadcast finalizes with no recipient left
   `queued`; relay marks every deferred recipient `failed`. **This is the
   regression test for the anchor bug and must fail on `main`.**
4. **The broadcast leaves "Sending"** on that path - asserted on the row, not a
   log line.
5. **A frozen envelope still terminates** - replaying an identical envelope
   repeatedly advances the durable count to the cap.
6. **Total send count is unchanged from `main`** on both ladders (Sec 3.5).
7. **Claim against a pre-branch item** - an item with no counter map claims
   successfully via the `if_not_exists` seed rather than throwing into the DLQ.
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
  Keep the diff inside the continuation/cap region.
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

Two non-infra obligations, both owed at handback rather than after merge:

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
