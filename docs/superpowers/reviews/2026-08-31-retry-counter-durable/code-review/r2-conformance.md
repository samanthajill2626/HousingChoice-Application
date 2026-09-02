# M5 spec-conformance review, ROUND 2 - feat/retry-counter-durable @ 08007e15

Round 1 reviewed `d2d15b4e` and is at `.superpowers/review/conformance-report.md`
(committed copy: `docs/superpowers/reviews/2026-08-31-retry-counter-durable/code-review/r1-conformance.md`).
Adjudication: `.../code-review/adjudications-r1.md`. Fix wave: `5c3913a9`, `08007e15`.

READ-ONLY. No suite was run (live self-QA session in this worktree). Working
tree clean at `08007e15`; the fix wave touched 4 code/test files and 4 docs, and
nothing outside that list.

Charge order followed: misses first, fix diff cold second, adjudication
challenges third, fix verdicts last.

---

## 1. What round 1 MISSED

### M1 - the D20 group-text exemption (found by the adversarial reviewer, not by me). CONFIRMED, and it is my miss

`SF1` is a genuine round-1 failure on my part, and it is the mission's own named
failure pattern - a mechanism credited by name without tracing whether it is on
the path in question. I verified that D20's group-text exclusion was PINNED by a
test and that the spec's stated rationale (a message-level 30003 reaches
`retrySend` with no `group_text` guard) was true. I never asked WHICH ROW's error
code reaches that enqueue. It is the message row's, and the per-recipient row a
staff member actually reads is written by a different subsystem that schedules
nothing.

I re-verified every citation in the filing independently, cold:

- `app/src/routes/webhooks/twilio.ts:2408` - `messages.getByProviderSid(MessageSid)`. ACCURATE.
- `app/src/routes/webhooks/twilio.ts:2567` - `enqueueSendRetry({...})` inside the
  30003 arm, no `group_text` guard; the very next arms (`case '30005'`/`'30006'`
  at `:2574-2575`) are the guarded ones. ACCURATE.
- `app/src/services/groupReceipts.ts:422` - `messages.updateRecipientDeliveryStatus(...)`.
  ACCURATE. A repo-wide grep of that file for `enqueueSendRetry` / `retrySend` /
  `SEND_RETRY` returns NOTHING, which is the load-bearing negative: the leg path
  schedules no retry.
- `app/src/services/groupReceipts.ts:336` - `rollUpAggregate`, and `:353`
  `messages.updateDeliveryStatus(...)` carrying `rollup.errorCode`. ACCURATE -
  so a leg-originated 30003 really can land on the message row.
- `dashboard/src/routes/contact/Timeline.delivery.test.tsx:517` - the D20 pin.
  ACCURATE.

The ruling (accept evidence, reject remedy, file) is correct: spec Sec 2 fences
native group-text receipt behavior and `relay-30003-retry-lineage` demands
separate evidence for exactly this extension. My round-1 verdict on the S5a
work-map row stays CONFORMS-to-spec; the SPEC's D20 rationale is what was thin,
and that is now filed rather than shipped.

### M2 - NEW. The plan's third-enqueuer confirmation was never recorded (conclusion holds; I verified it)

Plan slice 3 carried an explicit instruction I did not check for in round 1:

> **Third enqueuer:** `services/relayQueuedMessages.ts:93` also enqueues
> `RELAY_FANOUT_JOB` ... their counter is absent and they claim at 1.
> **Confirm that by reading before relying on it**; if a flushed message can
> already carry a counter, it inherits an exhausted budget.

`slice-3.md` contains no mention of `relayQueuedMessages`, "third enqueuer", or
`queued_pending`. The confirmation the plan demanded is absent from the build
record.

I performed it here, and the conclusion HOLDS - provably, not by inspection of
the happy path:

- `app/src/services/relayQueuedMessages.ts:64` selects only
  `m.direction === 'outbound' && m.delivery_status === 'queued_pending'`.
- `:89` transitions the message to `queued` BEFORE enqueueing the fan-out.
- `app/src/repos/messagesRepo.ts:122` - `ALLOWED_PRIOR.queued_pending = []`.
  Nothing may transition INTO `queued_pending`. A released message therefore can
  never re-enter the flush set, so no message reaching this enqueuer has ever run
  a fan-out pass, so none can carry a `fanout_attempt`.

Verdict: requirement SATISFIED IN FACT, UNRECORDED in the build record. No code
change. Worth one line in the handback so the next reader does not re-buy it.

### M3 - NEW. The claim's `missing` arm has ZERO test coverage in both job suites

`broadcastFanOut.ts:327-332` and `relayFanOut.ts:889-894` handle
`claim.outcome === 'missing'` with a `log.warn` and a bare `return` - new
production code on both jobs. Neither `broadcastFanOut.test.ts` nor
`relayFanOut.test.ts` contains any case reaching it (grep for `vanished` /
`'missing'` in both suites returns nothing). The repo integration suite proves
the REPO returns `missing`; nothing proves the JOB does the right thing with it.

Severity: LOW. The behavior is log-and-return on a vanished item, spec Sec 7
never asks for it, and D8's "every exit reaches a terminal state" is vacuous when
the item is gone. But it is an untested new branch and it is the one arm where a
future edit could silently start closing a broadcast that does not exist. Note,
not a must-fix.

### M4 - NEW. A `Timeline.tsx` comment overstates D21's single-derivation claim

`dashboard/src/routes/contact/Timeline.tsx:863-866` (shipped in slice 5a):

> The product flag for every LEG-scoped reason in this bubble: the rollup, the
> accessible-name recital and the per-recipient row. ONE derivation, so the three
> cannot disagree (D21) ...

`isRelayLeg` (`:867`) in fact feeds only TWO of the three: the rollup (`:914`)
and the per-recipient row (`:1065`). The accessible-name recital recomputes the
flag independently inside `recipientSummaryName` at `:587`
(`relay: rosterKind === 'relay'`).

D21's invariant is NOT broken: `recipientSummaryName` is called at `:933-940` and
`:953-960` with MessageBubble's own `rosterKind` (`:936`, `:956`), the same prop
`isRelayLeg` derives from, so the two derivations cannot disagree. What is wrong
is only the comment, which credits one derivation for three positions. Same
species as M1 at a much smaller scale. Cosmetic.

### M5 - things round 1 took on a slice report's word that I have now checked directly

All four hold:

- The corrected fan-out comments cite `jobs.ts:188` - `jobId: randomUUID()` is
  at exactly `:188` inside `buildEnvelope`, with the second `randomUUID()` at
  `:269` in `dispatchJob`'s repair path. ACCURATE.
- They cite `retrySend.ts:122-128` for the correct semantics - that paragraph
  ("The envelope's jobId (stable across redeliveries ...)") occupies exactly
  those lines. ACCURATE.
- Sweep site #24, `adapters/messaging.ts:545-547`: `default: return 'queued'`
  with the "anything new Twilio adds" comment. ACCURATE, and it is correctly
  called the root of the class.
- Proof 11's fourth position is REAL end-to-end, not a component-test artifact:
  the close writes `errorCode: code` into the recipient slot,
  `broadcastFormat.ts:150` carries `slot.errorCode` into the view, and
  `BroadcastResults.tsx:58-62` passes it to `DeliveryBadge`. An operator on the
  results table really does read the new prose.

What I still cannot check: RED-ON-MAIN remains second-hand (quoted verbatim in
`slice-2.md` / `slice-3.md`), and `npm run issues` regenerates a gitignored index.

---

## 2. The fix diff, reviewed COLD (`d2d15b4e..08007e15`)

### 2a. The `fanoutAttempt` derivation - CORRECT

```
const fanoutAttempt =
  claim !== undefined && claim.outcome !== 'missing' ? claim.attempt : undefined;
```
(`broadcastFanOut.ts:284-285`, `relayFanOut.ts:854-855`)

- **Type**: `claim` is `FanoutClaimResult | undefined`. The two-part guard narrows
  to `{claimed, attempt} | {capped, attempt}`, both of which HAVE `attempt`. The
  `'missing'` member is the only one without it, so the guard is exactly the
  narrowing the union requires - not defensive noise.
- **Semantics per outcome**: `capped` returns the UNCHANGED stored count
  (`broadcastsRepo.ts:679`, `messagesRepo.ts:2831` - `item.fanout_attempt ?? 0`),
  so close B logs 3; `claimed` returns the pass just taken, so close A logs the
  cap and close C logs 1. That is the number each close was DECIDED on. Correct.
- **Reachability of `missing`**: both jobs `return` on `missing` before any close
  call, so no close can ever observe it. The guard is purely type-level, and the
  fix's own comment does not claim otherwise.
- **`undefined` case**: only the unreachable-by-construction guard can call a
  close with `claim === undefined`. `JSON.stringify` drops an `undefined` value,
  so the field is simply absent rather than logged as null - an honest rendering.
- **TDZ hazard - checked explicitly, because this is the shape a rushed fix gets
  wrong.** Both closes are hoisted function declarations defined ABOVE the
  `let claim` they now read (`closeBroadcast` `:263` vs `let claim` `:324`;
  `closeRelay` `:842` vs `:882`). Every call site is below the declaration -
  broadcast `:337, :582, :591, :612`, relay `:899, :1052, :1061, :1088`. No call
  can execute in the temporal dead zone. Safe.

### 2b. The test assertions' discriminating power - ADEQUATE, with one honest caveat

The load-bearing case is asserted in BOTH suites:

- `broadcastFanOut.test.ts` close B: `fanoutAttempt` 3 AND `envelopeAttempt` 1.
- `relayFanOut.test.ts` close B: the same pair.

That is the only shape where the two numbers DIVERGE, and it is the exact
scenario SF2 described. It would fail against the pre-fix code, which logged 1.

Caveat, stated rather than hidden: the close-A assertions
(`fanoutAttempt === 3`) are NON-DISCRIMINATING on their own - close A is reached
on the third envelope, which carries `attempt: 3`, so the old field would also
have printed 3. Close C (both values 1) is not asserted at all. Neither is a
defect: close B carries the proof, and close A's assertion is still a useful
regression pin on the field NAME. But a reader must not mistake the close-A line
for evidence that the field reads the durable counter.

### 2c. The corrected comment - ACCURATE

`broadcastFanOut.ts:571-574` replaces "Beyond the cap -> mark those failed" with
a statement that close A fires on `claim.attempt >= MAX_BROADCAST_ATTEMPTS`, so
the pass spending the final rung is the one that marks the deferred recipients
failed. That matches `:589` exactly, and the parenthetical ("no fourth pass
exists to do it later") is the right reason. This closes round-1 note N1.

`relayFanOut.ts` needed no equivalent: slice 3 had already rewritten its
continuation comment, and it never carried the "Beyond the cap" wording.

### 2d. The new issue file - FACTUALLY SOUND

All six `refs` verified above (M1). Three further claims checked:

- "no `group_text` guard on the 30003 arm while 30005/30006 carry one" - the
  guarded arms begin at `:2574`, immediately after the 30003 arm's `break`.
  Consistent with the spec's own R4-6 record.
- "`rollUpAggregate` copies the WORST leg's error code onto the message row" -
  `groupReceipts.ts:348` derives `rollup` from all slots and `:353-356` writes
  `rollup.errorCode`. Supported.
- The "Suggested fix" correctly declines to prescribe, naming the real open
  question (is the axis relay-vs-group-text, or LEG-vs-MESSAGE?) and telling the
  next mission to confirm before building. That is the right register for a
  filing whose whole purpose is to stop the next reader inheriting a one-level
  rationale.

The severity (`low`) is defensible: the misread is real but the surface is a
per-recipient row on native group texts only.

---

## 3. Adjudication challenges

**No substantive disagreement.** SF1's accept-evidence/reject-remedy split is
right (twice-fenced). SF2 is right and fixed. SF3's rejection is right: the
spec's round-1 B5 adopted the reviewer's preferred throw-and-redeliver shape and
the scalar-check pass proved it dead, so an immediate close is the only path to a
terminal state; anything else is the anchor bug.

One QUALIFICATION, offered as a sharpening rather than a reversal:

**N1's "SAME-AS-MAIN" is true of the LOOP, looser about REACHABILITY.** The
adjudication says a crash mid-close leaving later slots queued is same-as-main
because "the old cap branch had the identical per-key loop under the identical
marker". The loop is indeed byte-for-byte the same shape (`recordRecipient` ->
`bumpStats` -> `emitBroadcastProgress`, then one `log.error`, then `finalize`).
But main reached it from ONE trigger (the cap); this branch reaches it from
three, two of which are new. So the partial-close window is not equally
FREQUENT, only equally SHAPED.

The ruling still stands, and for a stronger reason than the one given: on close
C, main's alternative was not a clean failure but the anchor bug itself - the
enqueue threw, the job failed, the redelivery was suppressed, and every recipient
stayed queued forever. A partially-completed close is strictly better than that.
I would put that sentence in the record rather than "SAME-AS-MAIN", which invites
a future reader to conclude the new paths were compared to a main that had them.

---

## 4. Are the fixes real or merely plausible?

**Real.** Each was checked against the mechanism, not the claim:

| fix | verdict | why it is not merely plausible |
|---|---|---|
| SF2 `fanoutAttempt` / `envelopeAttempt` in both close logs | REAL | reads the union member that actually carries the decision number, including `capped`'s unchanged stored count; no TDZ hazard across all 8 call sites; `undefined` degrades to an absent field |
| SF2 test assertions | REAL | close B asserts 3 beside 1 in BOTH suites - the only divergent shape, and red against the pre-fix code. Close A's assertion is a name pin, not proof (stated above) |
| N6 stale `broadcastFanOut.ts:563` comment | REAL | new text matches `:589`'s actual predicate and gives the correct reason |
| SF1 filing | REAL | all six refs and three derived claims independently verified; correctly scoped as evidence-for-the-next-mission rather than a fix |
| SF3 rejection | REAL | re-derived from the marker mechanism, not from the adjudication's summary |

Nothing in the fix wave introduced a regression I can find, and nothing in it is
cosmetic-passing-as-substantive.

---

## 5. Round-2 verdict summary

- **MUST-FIX: none.**
- **New findings: 3** (M2 unrecorded third-enqueuer confirmation, M3 untested
  `missing` arm, M4 overstated `Timeline.tsx` comment) - all NOTE severity, none
  blocking.
- **Round-1 miss owned: 1** (M1, the D20 leg-level trace; caught by the
  adversarial reviewer, filed, evidence independently re-verified here).
- **Adjudication challenges: 0 reversals, 1 qualification** (N1's "SAME-AS-MAIN"
  understates that close B and close C are new reachability into an old loop; the
  ruling survives on a better argument).
- Round-1's own notes N1 (stale comment) and the SF2 overlap are now CLOSED.
  Round-1 notes N2 (`relay` boolean vs `rosterKind`), N3 (non-ASCII confined to
  design-review records), N4 (`rail-verify` inertness), N5 (log message rename)
  and N6 (unreachable guard) stand unchanged.

## 6. Could not verify (unchanged from round 1)

1. Gate results - no suite run; the live self-QA session owns this worktree.
2. RED-ON-MAIN for close C - second-hand, quoted verbatim in `slice-2.md` sec 3
   and `slice-3.md` sec 3. The method used (new tests against the untouched job)
   is stronger than the worklist's comment-out-the-fix alternative.
3. `npm run issues` - regenerates a gitignored index.
4. The e2e spec's runtime behavior - read for construction only.
