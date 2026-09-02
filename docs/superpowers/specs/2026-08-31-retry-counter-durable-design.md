# Retry counters and the cap-and-close branch - design

Bundle M5 (`docs/issues/_CLUSTERS.md`, re-derived 2026-08-31 @5ce9912f).
Branch `feat/retry-counter-durable`, cut from `main@5ce9912f`.

| sev | issue | this branch |
|---|---|---|
| high | `retry-counter-in-envelope-makes-caps-unreachable` | **closes** |
| low | `rail-binding-propagation-retry` | **partly** - three of five callers (Sec 5) |
| med | `relay-30003-retry-lineage` | **deferred** - Sec 2.1 |

**This document states DECISIONS and INVARIANTS.** Mechanics - control flow,
where a line goes, which helper lives in which file, test seams - belong to
`docs/superpowers/plans/2026-09-01-retry-counter-durable.md`. Review history and
rejected alternatives are in `design-review/adjudications.md`.

## 1. The invariant

**If the mechanism that advances state fails permanently, does this path still
reach a terminal state?**

The two fan-out continuation loops answer NO. Each advances its attempt counter
by putting `attempt + 1` into the envelope it enqueues, so the counter only
moves when the queue accepts the message. A broken queue freezes it, the same
value is recomputed forever, and the cap-and-close branch - written specifically
to stop a stuck state - is unreachable. **The mechanism that advances the state
is the mechanism that failed.**

This is the shape that hung a one-second prod voicemail on "Transcribing..."
indefinitely on 2026-08-16 (patched for voice in `a755c6f8`).

**Only two sites have it.** The blanket form of the claim is false, and building
against it produces "fixes" for behavior that already ships:

| site | state |
|---|---|
| `broadcastFanOut`, `relayFanOut` | **envelope-counted. The bug.** |
| `retrySend` (1:1) | already durable - the webhook reads `message.retry_attempt` off the persisted row |
| `retrySend`'s enqueue failure | already handled - twilio.ts:2727-2731 catches, logs ERROR, leaves the message terminal |
| `groupRail` | already correct - wraps its enqueue, returns a degraded result the caller acts on |

## 2. Scope

**In:** `jobs/broadcastFanOut.ts`, `jobs/relayFanOut.ts`,
`repos/messagesRepo.ts`, `repos/broadcastsRepo.ts`, `services/groupRail.ts` and
its three job/import/script callers, `dashboard/routes/contact/deliveryStatus.ts`,
`dashboard/routes/contact/Timeline.tsx`, plus a bounded provider-status audit.

**Out - hard fences:**

- `routes/webhooks/twilio.ts` **in its entirety** - M4, M12, T-PUSH.
- `repos/conversationsRepo.ts` - M1. This constrains Sec 5.
- `jobs/tourReminders.ts` - `feat/tour-reminder-ladder-phase-b`.
- `routes/contacts.ts`, `routes/today.ts`, `rosterResolution.ts` - M1.
- Delivery-chip rendering beyond the copy fix - `T-DELIVERY-CHIPS`.
- Native group-text receipt behavior and the 1:1 retry/collapse path.

`Timeline.tsx` is listed under `T-DELIVERY-CHIPS` in `_CLUSTERS.md`. Cameron
authorized editing it on 2026-09-01: that bundle is Tier 2 backlog, not the
ordered queue, and no live worktree touches it. Sec 8 obliges amending the
cluster doc.

### 2.1 Why relay-30003 is deferred

`relay-30003-retry-lineage` stays **open** as its own mission. Three review
rounds failed to converge its lineage state machine - per-attempt idempotency,
an atomic effective-status promotion, the pointer write-after-send race, cap
semantics and gate-refusal accounting, all on one item - while the anchor
converged after one. Its file lists nine acceptance criteria spanning a new job,
a new store, webhook changes and dashboard rendering. That is a mission.

**What transfers is the PATTERN, not the data**: a durable counter outside the
wholesale-written slot, claimed before the work, positioned so every exit
advances it, with a therefore-reachable cap. This branch's counter belongs to
the continuation ladder and must NOT be shared with a retry ladder - a
continuation would silently consume the retry budget.

**Interim user-visible state:** no relay retry exists today and none is added
here, so the dashboard's "will retry" on relay legs is false in both worlds.
Sec 6 stops it.

## 3. Decisions: the durable counter

**D1. The count lives in the durable record, not the enqueued envelope**, and is
claimed BEFORE the work it authorises.

**D2. It is a top-level scalar per item, NOT a field in the recipient slot.**
Both per-recipient slots are rewritten WHOLESALE on every pass
(`setRecipientDelivery`, `setRecipient`), so a counter inside one is erased each
time a status is recorded - it would read 1 forever, which is the bug this
branch removes. This is the single most important constraint in the document.

**D3. A scalar, not a per-recipient map.** Recipients in a continuation are
attempted together and success is terminal, so per-recipient counts would stay
in lockstep with the pass count. It counts what the envelope's `attempt`
counted: passes. This also means no parent-map seeding problem, no creation-site
edit, and no item-size question.

**D4. No migration and no backfill.** An item without the attribute claims at 1.
In-flight envelopes still parse; their `attempt` is advisory only.

**D5. The claim is atomic**, so concurrent deliveries cannot claim the same pass
number.

**D6. It is claimed once per pass, after the duplicate-delivery guard and after
the job has determined it will actually attempt sends.** Two properties are
required and the plan must preserve both:

- a job that returns without attempting any send does NOT consume a pass;
- a duplicate delivery does NOT consume a pass - the ladder advances on
  CONTINUATIONS, each a fresh enqueue with a fresh `jobId`, so nothing is gained
  by claiming earlier and a duplicate could otherwise reach a close.

**D7. Timing and pass count are UNCHANGED from `main`.** Same number of send
passes per recipient, same backoff delays. The two files pass deliberately
different arguments to their backoff functions - one waits the next step, the
other the current one - and that difference is preserved, not normalised.

**D8. Every exit reaches a terminal state, with no recipient left `queued`.**
Three distinct situations need closing, and they are not one shared code path:
the cap being reached with recipients still deferred; a pass beginning when the
cap is already spent; and an enqueue failure. Precision note (recorded
adjudication, 2026-09-01, not a design change): every exit EXCEPT the D12
unknown-error `throw`, which is a FOURTH exit and is filed rather than fixed -
so "every exit" here means every exit this branch closes.

**D9. An enqueue failure closes immediately rather than throwing.** A redelivered
envelope is suppressed by the job-execution marker (`jobId` is stable across
redeliveries and the marker has no TTL), so nothing comes back - an immediate
close is the only path to a terminal state. This is what the anchor issue
prescribes and what `a755c6f8` did for voice.

**D10. The close reason distinguishes "retries exhausted" from "never
scheduled".** Reusing the cap's code for an enqueue failure would tell an
operator retries ran when none did.

**D11. `relayFanOut`'s existing continuation backoff is NOT corrected.** It looks
off-by-one against `broadcastFanOut`'s deliberate choice and sits inside the
edited region. It is a timing change with its own blast radius and no issue
asking for it; if it is wrong, it is a separate issue.

## 4. Decisions: what this does NOT fix

**D12. The `throw`-to-force-redelivery path stays broken, and is filed.** Both
loops throw on an unrecognised send error expressly so SQS redelivers - but the
redelivery is suppressed at the marker, returns successfully, and the consumer
deletes the message. No retry, no DLQ, no alarm; and because the throw exits the
recipient loop, one unrecognised error on recipient 3 of 800 strands 798.
Filed as `throw-for-redelivery-defeated-by-job-marker` (high). Not fixed here:
the remedy requires deciding what such an error should DO while preserving the
never-text-twice guarantee the marker currently provides.

## 5. Decisions: group rail binding propagation

**The defect.** The participant map is built only from participants whose
Twilio messaging binding has an address, and Twilio populates that binding
ASYNCHRONOUSLY. A seconds-old rail therefore reads as short of its roster and
`ensureGroupRail` enters the repair path. The 2026-08-13 migration of 132
threads produced 81 incomplete-roster warnings, 178 "participant already exists"
refusals, and 2 `rail_failed` records for rails a later read showed fully bound.

**D13. Re-read before concluding damage.** On a rail created in THIS call, a
short participant map triggers a small bounded number of delayed re-reads before
the code concludes the rail is short. Members whose binding appears are simply
present.

**D14. Both of the reads that can conclude damage get this** - the validation
read after create AND the read after repair. The 2 false `rail_failed` records
were written after the POST-REPAIR read, so laddering only the first would leave
the headline symptom reachable.

**D15. The authority model is UNCHANGED.** The re-read stays authoritative and
completeness is NOT derived from the create's per-member failures. The code's
own rationale forbids that substitution: an add can succeed and still leave a
shape Twilio will not bind. This branch fixes a TIMING false-alarm, nothing else.

**D16. Only three of five callers get it**, opted in explicitly rather than
inferred: the job, the import (where the harm occurred), and the operator
verify script. The two `groupSend` paths - the inline send backstop and
`healRail` - keep today's behavior exactly, because they are reached from a
staff HTTP request and because every variant that changed them either leaked the
`rail_creating` claim or required editing fenced `conversationsRepo.ts`. **The
defect therefore remains live on those two paths**, and Sec 8 says so rather
than claiming a clean sweep.

**D17. The adopt path is excluded** even though it faces the same window: its
read-back is the only source of roster truth, and widening the change there
deserves its own evidence. Filed.

**D18. No 50386/50437 handling is added.** Traced: repair failures are already
collected and discarded without affecting the outcome, so the change would alter
no behavior. The refusal LOG LINES originate in a file this branch does not
edit. Filed rather than shipped as a no-op that reads like a fix.

## 6. Decisions: dashboard

**D19. Relay fan-out legs stop promising a retry.** No relay retry is scheduled
today - the relay pointer branch of the status webhook returns before the 1:1
retry branch - and this branch adds none.

**D20. Native group text is NOT included** - but **the original rationale for
that was WRONG, and is corrected here rather than quietly left standing.**

The decision was justified as "its 30003 retry is real: the 30005/30006 and
21610 arms each carry a `group_text` guard, and the 30003 arm carries none, so a
group-text 30003 reaches the retry enqueue like any 1:1." The premise is true;
the conclusion does not follow. The retry is ENQUEUED and then **cannot
succeed**: `retrySend` calls `sendMessage`, which throws
`GroupTextSendNotSupportedError` for `conversation.type === 'group_text'`
(`sendMessage.ts:293`), and the handler catches `SendRefusedError`, logs, and
stops the chain. A native group-text leg promises a retry that never sends -
exactly the falsehood D19 exists to remove.

Found by the planner's plan-blind adversarial reviewer at handback. It is the
sixth instance in this mission of the pattern Sec 10 names: a mechanism traced
partway - here to the enqueue - and credited for what happens after it.

**The exclusion stands anyway, on Cameron's 2026-09-01 ruling**, for reasons
that do not depend on the broken premise: the promise is equally false on
`main`, so keeping it regresses nothing, and widening the override reaches a
render path this branch fenced. The debt is tracked as
`group-text-30003-leg-retry-promise-unverified` (now PROVEN, not suspected),
which also records that the three tests pinning the carve-out encode this
rationale and will need to flip when it is fixed.

**D21. Every render position for a relay leg's reason changes together.**
`Timeline.tsx` states the invariant in its own comment: one flag feeds the
rollup, the per-recipient row and the accessible name, so the three cannot
disagree. A partial fix that leaves a row contradicting the chip above it is
worse than none.

**D22. The two app-invented close codes render as operator prose, not as raw
tokens.** Unmapped, they print as `Delivery failed (error <code>)` - printing an
app-invented code as though it were a carrier error number, which is precisely
the defect the internal-code map exists to fix. The pre-existing one is included
because introducing its sibling correctly while leaving it raw would be half a
fix in a file already being edited.

**D23. The copy must read correctly in every position it can appear**, including
a broadcast's results badge. Unlike the existing internal code, these two get no
per-position interception, so one string serves an aggregate summary and a
single recipient's row.

## 7. What must be proven

Test INTENTIONS. The plan specifies the seams, fixtures and mechanics.

1. The counter survives a normal per-recipient status write. **Fails against any
   design that puts it in the slot** (D2).
2. Concurrent claims cannot take the same pass number (D5).
3. **With enqueueing broken, the entity reaches a terminal state with no
   recipient left `queued` - and the broadcast stops showing "Sending".** The
   regression test for the anchor bug; **must fail on `main`** (D9).
4. All three closing situations leave that same terminal shape, including on a
   first-pass envelope and on a relay inbound source message - the two shapes
   where a wrong recipient set marks nothing and the test passes vacuously (D8).
5. Total send count per recipient AND the backoff delays both equal `main`'s, on
   both ladders. Counting sends alone would not catch a ladder shifted a step
   (D7).
6. A pass that enqueues a continuation does NOT finalize the entity (D8).
7. A duplicate delivery claims nothing and sends nothing; a job that attempts no
   send consumes no pass (D6).
8. An item written before this branch claims successfully (D4).
9. Rail: a fresh create whose bindings have not propagated resolves without
   repair and without `rail_failed`; a genuinely unbound member still repairs;
   the post-repair read also ladders; **the adopt path ladders on neither read**;
   and the two `groupSend` callers behave exactly as on `main` (D13-D17).
10. Chip copy: a relay 30003 leg promises no retry in every position; 1:1,
    native group text, email and the broadcast badge are unaffected. The
    group-text case must be pinned explicitly rather than relying on a default
    (D19-D21).
11. Both internal codes render as prose in every position, including the
    broadcast badge (D22-D23).

**E2E (hermetic):** a relay leg that failed 30003 shows no retry promise. The
broadcast dead-queue case is deliberately not e2e - nothing in the hermetic
stack can make enqueueing fail without a dev seam this branch is not adding, and
it is covered at integration level where that is stubbable.

## 8. Post-merge obligations

**No infrastructure, dependency, environment or schema work.** The new attribute
is optional and self-creating.

Owed at handback:

1. `throw-for-redelivery-defeated-by-job-marker` filed (done, high) - D12.
2. The provider-status sweep's out-of-region findings filed (Sec 9).
3. `rail-binding-propagation-retry` updated, **not silently closed**: covered for
   three callers, deliberately live on the two `groupSend` paths (D16), with the
   adopt-path exposure (D17) and the refusal log noise (D18) recorded.
4. `_CLUSTERS.md` M5 amended: it directs "land the backend lineage here and let
   T-DELIVERY-CHIPS render it", and this branch does the opposite on both counts.
5. `relay-30003-retry-lineage` carries its design knowledge forward so the
   follow-on mission does not re-buy it: the forward-only status machine forbids
   a delivered retry from superseding an undelivered leg without an explicit
   scoped transition; gating a retry claim on the slot transition caps the ladder
   at ONE retry invisibly, so the gate belongs on the attempt record; the relay
   announcement path writes the same SID pointers, so a pointer-keyed retry
   reaches fenced `tourReminders.ts`; a two-level lineage map WILL hit the
   parent-path seeding problem this branch's scalar avoids; and the relay chip
   copy set here must be revisited when a retry becomes real.

## 9. The provider-status sweep

The anchor issue flags an un-done sweep for `!== 'success'` fallthroughs. A
literal grep returns **zero hits**; the real shape from the voice incident is a
branch on a raw provider status whose unenumerated default is NON-TERMINAL
("keep waiting") rather than terminal.

Bounded to a definite enumeration: every site in `app/src` branching on a status
string received from a provider. Record at `file:line` whether the unenumerated
default is terminal. Disposition **by region, not by filename** - inside a region
this branch already edits, fix it; anywhere else, file one issue. **One
in-region exception, named in advance:** the unknown-error `throw` in both
fan-outs is D12 and is filed, not fixed.

A sweep that finds nothing is a valid result and is still written down.

## 10. Risks

- **D2 is the trap.** The obvious home for the counter is the recipient slot,
  and it silently produces a no-op that looks correct.
- **D6's positioning is a real constraint, not a preference** - both properties
  it names have a failing case.
- **When this document says "the existing X handles this", trace X from the new
  call site.** Several errors in this design's history had that exact shape,
  including a close branch that turned out unreachable from where the plan
  wanted to call it.
- `relayFanOut.ts` conflicts with M2, M3 and T-DELIVERY-CHIPS.
- **`npm test` contention:** three other missions share this machine and one
  DynamoDB Local container. A red `npm test` is not a regression until re-run
  under a clean access key and compared against the merge base by failing FILE.
- **`reuseExistingServer` adopts a stale stack on a commit match.** Confirm no
  orphaned listener on the lane's ports before each e2e run.
