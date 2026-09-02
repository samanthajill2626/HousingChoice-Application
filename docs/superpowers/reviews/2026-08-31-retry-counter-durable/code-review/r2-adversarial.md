# Adversarial review round 2 - feat/retry-counter-durable @08007e15

Round 1 reviewed d2d15b4e (report: `.superpowers/review/adversarial-report.md`,
committed as `docs/superpowers/reviews/2026-08-31-retry-counter-durable/code-review/r1-adversarial.md`).
Adjudications read at
`docs/superpowers/reviews/2026-08-31-retry-counter-durable/code-review/adjudications-r1.md`.

Order of work as charged: fresh hunt first, then the fix diff cold, then
challenges, then fix verdicts.

Empirical work this round:

- `cd app && npx vitest run test/broadcastFanOut.test.ts test/relayFanOut.test.ts` -> 97/97 pass (same case count as round 1; the wave added assertions inside existing cases, no new cases).
- `node -e` TDZ probe reproducing the exact closure shape the fix introduces (output quoted in NF1).
- No full suite run; the live self-QA session was not disturbed; worktree left clean.

**Counts: 1 should-fix, 5 notes, 0 must-fix. Fix verdicts: SF2 real but
PARTIAL; SF1 filing accurate; SF3/N1/N2 rulings accepted (two conceded
outright). 2 adjudication challenges, both sharpenings rather than overturns.**

---

# 1. What round 1 missed - fresh findings

## NF1 (should-fix) - the fix introduced a temporal-dead-zone hazard inside the one function whose contract is "nothing is left queued"

**Files:** `app/src/jobs/broadcastFanOut.ts:263` (declaration) vs `:324`
(`let claim`); `app/src/jobs/relayFanOut.ts:842` vs `:882`.

`closeBroadcast` / `closeRelay` are hoisted `async function` declarations, so
they are callable from the top of the handler. Before the wave they read only
bindings declared ABOVE them - `payload` (a parameter), `repo` (`:248`),
`snapshot` (`:249`), plus `events` / `log` / `audit` from the registrar scope -
so calling one from anywhere in the handler was safe by construction. The wave
added a read of `claim`, a `let` declared **61 lines below** the function in
`broadcastFanOut` and **40 lines below** it in `relayFanOut`.

Any close added inside that window now throws
`ReferenceError: Cannot access 'claim' before initialization` - not a wrong log
field, a CRASH inside the close, which leaves exactly the half-closed entity
(recipients still `queued`, row still `sending`, redelivery suppressed by the
job marker) that D8 exists to prevent.

**Empirical proof of the shape** (`node -e`, reproducing the closure exactly):

```
EARLY CALL -> ReferenceError: Cannot access 'c' before initialization
LATE CALL  -> 3
```

**Why this is not hypothetical.** The window in `broadcastFanOut` is not empty
scaffolding - it contains the unit read (`:301-306`) and the recipient-key
computation (`:310-320`). "The broadcast's unit read failed, close it rather
than half-send" is precisely the kind of fourth close a follow-on mission would
add, and it would be added where the failure is, i.e. inside the window. The
failure mode is also unusually quiet: it only fires on the new path, in
production, at the moment the system is already degraded.

**Fix (small, and strictly better on its own terms).** Pass the number in:
`closeBroadcast(recipientKeys, code, fanoutAttempt, cause?)`. That also removes
a real ambiguity - the close currently *infers* which decision it is describing
from a mutable binding, when every call site already knows. Alternatively hoist
`let claim: FanoutClaimResult | undefined;` to sit beside `const repo` /
`const snapshot` at `:248-249`, which restores the "everything the close reads
is declared above it" invariant the file previously had (and documents at
`:244-247`).

**Regression test that would fail today:** none exists and none is needed - the
guard is structural. If a test is wanted, a unit case that calls the close
before the claim is assigned is not writable without editing the handler; the
cheap protection is the parameter.

## NF2 (note) - two of the four new assertions do not discriminate; only the close-B pair is load-bearing

The charge asks directly: would the new assertions pass if `fanoutAttempt`
logged the envelope value? For close A, **yes**.

The continuation is enqueued with `attempt: nextAttempt` where
`nextAttempt = claim.attempt + 1` (`broadcastFanOut.ts:599`,
`relayFanOut.ts:1074`). So pass 1 enqueues `attempt: 2`, pass 2 enqueues
`attempt: 3`, and the pass that reaches close A carries envelope `attempt === 3`
**and** `claim.attempt === 3`. `expect(closeLines(capture)[0]!['fanoutAttempt']).toBe(3)`
(`broadcastFanOut.test.ts:462`, `relayFanOut.test.ts:639`) therefore passes
byte-for-byte against the pre-fix code SF2 reported. Close C is the same story
(both are 1) and is not asserted at all, correctly.

The close-B pair IS the real test and is well built:
`fanoutAttempt = 3` beside `envelopeAttempt = 1`
(`broadcastFanOut.test.ts:497-499`, `relayFanOut.test.ts:680-682`) is only
satisfiable by reading the durable counter, and it also pins the two fields as
distinguishable. That is adequate coverage.

This is not a defect in the fix - it is a claim the wave record should not make.
The build record should say the discrimination lives in close B, not that all
four closes are now covered.

## NF3 (note) - the rename is partial: three sibling lines still emit bare `attempt` carrying the envelope value

`broadcastFanOut.ts:539` (per-recipient transient-defer WARN), `:565`
("broadcast send pass complete" INFO), `relayFanOut.ts:995`, `:1035` ("relay
fan-out complete" INFO).

The fix's own comment states the goal as "the two must not be confusable"
(`broadcastFanOut.ts:279-284`). After the wave, one job run can emit
`attempt: 1` on the pass-complete line and `envelopeAttempt: 1, fanoutAttempt: 3`
on the close line, with `attempt` and `envelopeAttempt` being the same concept
under two names.

Honest scope: the residual numeric DIVERGENCE is narrow. On close A and close C
the envelope and the claim agree, and close B returns before the pass-complete
line is emitted, so no line prints a *wrong* number today. This is naming
consistency and future-proofing, not a second instance of the SF2 bug - which is
why it is a note. Round 1 named these four lines in the SF2 finding body; the
adjudication accepted SF2 and the wave fixed one of the two shapes.

## NF4 (note) - `fanoutAttempt` on a close C describes context, not a decision

`broadcastFanOut.ts:612` / `relayFanOut.ts:1088` reach the close with
`claim.outcome === 'claimed'`, so the line prints the pass number that ran
(typically 1) beside `closeCode: enqueue_failed`. The comment above the
derivation says the field "names the number the close was DECIDED on" - true for
closes A and B, not for C, where the decision was "the queue refused" and the
number is context. No operator harm (reading "we were on pass 1" is correct and
useful); the comment overstates by one case. Worth a word only because the whole
finding it descends from was about a log field being read as something it is not.

## NF5 (note) - the claim x group-rail-ladder territory: walked, and genuinely uncoupled

Charged as untouched territory, so recording the walk rather than silence.

- No shared state. The ladder lives in `services/groupRail.ts` and touches
  `conversations` rows; the claim touches `broadcasts` / `messages` rows.
- Neither fan-out can reach the ladder. `relayFanOut` sends through the raw
  messaging adapter from a pool number, never a rail. `broadcastFanOut` resolves
  `conversations.createOrGetByParticipantPhone(phone, 'tenant_1to1')`
  (`broadcastFanOut.ts:391`) and sends through `sendMessage`, so it never routes
  into `groupSend`. And no fan-out passes `awaitBindingPropagation`, so even if
  it did the ladder would not arm.
- Timer coupling is throughput-only, and bounded. The jobs consumer dispatches a
  poll batch CONCURRENTLY - `await Promise.all(messages.map((m) => this.handleMessage(m)))`
  (`app/src/adapters/sqsJobConsumer.ts:129`), `MaxNumberOfMessages` default 10
  (`:111`) - so N laddering rail jobs cost `max(4s)`, not `N x 4s`, and do not
  head-of-line-block a fan-out continuation. The serial-semaphore visibility
  concern that forced `maxMessagesPerPoll: 2` on the inbound-mail consumer
  (`worker.ts:245-249`) does not transfer.
- A late continuation is harmless anyway: the counter is durable and the
  backoff is SQS `DelaySeconds` (visibility), not processing order.

**One round-1 assumption repaired by this walk.** I reasoned about redelivery as
if dispatch were serial. It is not - up to 10 handlers run concurrently in one
worker. The claim design survives that: `putJobExecutionMarker` is a conditional
`PutCommand` with `attribute_not_exists(tsMsgId)`
(`app/src/repos/messagesRepo.ts:2656-2664`), so two in-process concurrent
deliveries of one envelope still resolve to exactly one execution, and
`claimFanoutPass` is a conditional `ADD` that is atomic regardless. Concurrency
strengthens rather than weakens the round-1 conclusion.

## NF6 (note) - a duplicated roster member inflates `deferred` in the relay close line

`relayFanOut.ts:899` passes `pending.map(relayMemberKey)`. `relayMemberKey`
collapses to `contactId` (else `phone#<E164>`), so a roster carrying the same
member twice - the shape `duplicate-relay-group-warning` exists for - yields the
same key twice. `closeRelay` then writes that slot twice; the write is
idempotent (same status, same code) and the snapshot guard reads the pre-pass
value both times, so there is no state damage, but `deferred: memberKeys.length`
overcounts on the one operator line this branch promises. `broadcastFanOut` is
immune - its `pending` derives from `Object.keys(recipients)`. Trivial fix if
touched: `[...new Set(pending.map(relayMemberKey))]`.

---

# 2. The fix diff, reviewed cold

`git diff d2d15b4e..08007e15 -- app/` is 33 added lines across four files.

**Can the derivation lie?** Reviewed all four call sites against
`const fanoutAttempt = claim !== undefined && claim.outcome !== 'missing' ? claim.attempt : undefined;`:

| call site | `claim` state at call | reported | correct? |
|---|---|---|---|
| close B (`broadcastFanOut.ts:337`, `relayFanOut.ts:899`) | `capped` | unchanged stored count | yes - this is the number that refused the claim |
| unreachable guard (`:582` / `:1052`) | `undefined`, or `capped`/`missing` | field absent, or stored count | yes - pino omits `undefined`, so no `null` noise |
| close A (`:591` / `:1061`) | `claimed` | the rung this pass took | yes |
| close C (`:612` / `:1088`) | `claimed` | the rung this pass took | yes (see NF4 on the comment) |

The narrowing is written defensively rather than relying on TS narrowing a
captured `let`, which is correct - TypeScript cannot narrow a mutable binding
inside a closure, and the two-step guard is what makes `.attempt` typecheck
across the `claimed | capped` union while excluding `missing`. No lie found on
any reachable path.

**One unreachable lie-shape, recorded not raised.** `capped` falls back to
`attempt: 0` when the re-read finds no numeric `fanout_attempt`
(`broadcastsRepo.ts:684`, `messagesRepo.ts:2831`). Reaching it requires a
`ConditionalCheckFailedException` whose consistent re-read shows the item
present with the counter absent - impossible under the condition
(`attribute_not_exists(#fa) OR #fa < :cap`), since a CCF with the item present
means `#fa` exists and is `>= cap`. If it ever happened the line would read
`fanoutAttempt: 0` beside `transient_cap`. Not worth code; worth knowing.

**Test discrimination:** see NF2 - close B discriminates, close A does not.

**The prose change** at `broadcastFanOut.ts:568-574` (the stale slice-2 comment
the conformance reviewer caught) is accurate: close A does fire on
`claim.attempt >= MAX_BROADCAST_ATTEMPTS`, i.e. AT the last rung, and no fourth
pass exists. Verified against `:591`.

**Nothing else moved.** The diff touches no repo method, no condition
expression, no close-path control flow, and no test fixture. Re-ran both fan-out
suites: 97/97, identical case count to round 1.

---

# 3. Adjudication challenges

## SF3 rejection - ACCEPTED, with one wording correction to the handback note

The redelivery-suppression proof is decisive and my round-1 remedy was wrong: a
post-throw redelivery carries the same jobId and dies at the execution marker,
so "leave them queued and let redelivery walk the counter" cannot work, and an
immediate close is the only route to a terminal state. D9/D10 stand. I withdraw
the remedy.

The one half I would correct is the *characterisation*, not the ruling. The
adjudication says the missing re-drive tool "is the same operational gap main's
cap-close already has". The gap is the same; the REACHABILITY is not. Main's
cap-close fires only after a genuine three-pass ladder - a rate-limit storm that
survived 10s and 20s of backoff. Close C (`broadcastFanOut.ts:612`) fires on
**pass 1**, on any single `enqueue` throw: an SQS 5xx, a throttle, a
`hopCount > MAX_HOP_COUNT` refusal (`jobs.ts:167-170`), or the no-adapter
misconfiguration `worker.ts:120-123` records as a past prod incident. So the
frequency at which recipients enter the unrecoverable terminal state is new even
though the state is not. Suggested handback wording: "newly reachable on pass 1"
rather than "same as main".

## N4 - ruling stands, but the bound deserves its number and its failure MODE

Adjudicated as "true and bounded; the claim already spans multi-second Twilio
calls." Both clauses are right. Two facts sharpen it:

1. **The consequence is a hard throw at a staff HTTP request, not a degrade.**
   A `groupSend` that loses the claim gets
   `{status:'failed', reason:'another rail creation is already in flight'}`
   (`groupRail.ts:444`), and `groupSend.ts:381-389` turns
   `twilioConversationSid === undefined` into a thrown
   `GroupRailUnavailableError`. The operator's reply fails.
2. **The competing claim is started by ordinary inbound traffic.** The
   `groupRail.ensure` enqueuer is wired into the Twilio inbound webhook
   (`app/src/routes/webhooks/twilio.ts:353`). So the sequence is: a member texts
   a rail-less group -> the webhook enqueues the ensure job -> the worker picks
   it up and now ladders -> staff read that inbound and reply within seconds ->
   the reply is refused. That is a plausible ordinary sequence, not a contrived
   race.

On magnitude: the ladder arms only when `missing.length > 0` on a
non-adopted rail (`groupRail.ts:580`), i.e. exactly the freshly-created-rail
case, which is exactly when a human is most likely to be looking at that thread.
Up to 2s + 2s on a create-path window otherwise measured in one or two Twilio
round-trips is a multiple of the window, not a margin on it. I am not asking for
a code change - D16 already reasoned this trade and the ladder buys back 81
false incomplete-roster warnings - but the handback line should carry the
failure mode (a thrown send refusal) and the trigger (inbound traffic), because
"bounded by ~2s" reads as invisible and this one is not.

## N1 and N2 same-as-main rulings - CONCEDED

- **N2 conceded outright.** I re-read `finalize` (`broadcastFanOut.ts:653-687`):
  the status is re-derived from the fresh item every time
  (`allFailed = total > 0 && fresh.stats.failed >= total`, then
  `markFailed : markSent`), so a second finalize on unchanged state reproduces
  the same terminal status. My `failed -> sent` flip claim required the
  recipient mix to change between finalizes, which no path does once every slot
  is terminal. The duplicate best-effort `broadcast_sent` audit row is real and
  is main's shape. Ruling correct.
- **N1 conceded.** The per-key loop and the marker are byte-identical in shape
  to main's cap branch. The one half the adjudication did not address is that
  close B can close the FULL audience where close A closes only
  `transientRemaining` - but close B is reachable only via an operator re-drive
  of a spent ladder, so the exposure is an operator-initiated recovery, not a
  production path. Not worth pressing.

## SF1 filing - checked, and it is faithful

`docs/issues/group-text-30003-leg-retry-promise-unverified.md` was read in full
against the code it cites. Every `refs` line resolves, both levels are stated
without collapsing them, `rollUpAggregate`'s leg-code copy onto the message row
is carried (the half that makes the message-level chip non-separable), and the
"suggested fix" correctly identifies the axis as LEG-vs-MESSAGE rather than
relay-vs-group-text. It also states that the D20 pin test must be INVERTED
rather than deleted, which is the right instruction for the follow-on. I have no
correction to make to it. Accept-evidence-reject-remedy is the right call given
the spec Sec 2 fence.

---

# 4. Are the fixes real or merely plausible?

- **SF2 - REAL, but PARTIAL.** The close line now reports the durable counter,
  the derivation is correct on every reachable path (section 2), and close B is
  genuinely pinned by a discriminating assertion. Partial on two counts, neither
  fatal: three sibling lines still emit the old bare `attempt` name (NF3), and
  two of the four new assertions are decoration (NF2). It also introduced NF1,
  which is the only should-fix in this report.
- **SF1 - REAL as a filing.** Faithful, correctly scoped, actionable.
- **The stale-comment fix - REAL.** Verified against the branch it describes.
- **SF3 / N1-N6 - no change was made and none was owed**, with the two wording
  sharpenings above.

Nothing in the wave regressed behavior: the code diff changes only a log
payload and two comments, and both fan-out suites are green at 97/97.
