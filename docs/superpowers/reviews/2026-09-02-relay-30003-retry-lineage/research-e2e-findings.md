# Research findings - e2e harness, fake, queue, worker seam

Read-only research pass for plan Tasks 11, 12, 14 and 15, against the live tree
at `W:\tmp\relay-30003-retry-lineage` (`feat/relay-30003-retry-lineage`). Only
places where the tree CONTRADICTS the approved spec or plan are recorded here;
the verified reference (which corrects nothing) is in the gitignored
`.superpowers/sdd/worklist-e2e-harness.md`.

**The spec's two load-bearing harness assumptions both HOLD** and are recorded
here so nobody re-derives them: the fake's delivery-status callback DOES carry
`To` (`fake-twilio/src/engine/signer.ts:219`, fed from the real destination at
`fake-twilio/src/engine/engine.ts:505`), so D5's ladder key is reachable and the
browser proof can pass; and the fake's arming IS one-shot per destination
(`engine.ts:463-464`), so Sec 7's "the retry naturally lands clean as the next
message to that handset" is correct.

---

## 1. BLOCKING-adjacent (MUST-HANDLE): the retry job does NOT run in the worker in the hermetic lane

**Plan says** (Task 14, header, plan line 1749-1753):
`**The backoff seam is WORKER-side, not `dev.ts`.** The retry job runs in the separately spawned worker (`scripts/e2e-session.mjs:381`); `app/src/routes/dev.ts` is app-side and cannot reach it.`

**The tree holds** the opposite about WHICH process runs it.
`scripts/e2e-session.mjs:109-256` never sets `JOBS_QUEUE_URL` (grepped: it
appears only in `app/src/**`, tests and the three `.env*.example` files), so
`app/src/jobs/queueWiring.ts:122-138` wires `InProcessOutboundQueueAdapter`,
which dispatches inside the SAME process that enqueued
(`app/src/adapters/scheduler.ts:165-185`). The claim's `enqueue` happens in
`POST /webhooks/twilio/status`, i.e. the APP process
(`app/src/routes/webhooks/twilio.ts:2442-2560`), and the app registers every
handler for exactly this reason (`app/src/index.ts:36-57`). `e2e/README.md:569-571`
states it flatly: `The lane runs jobs in-process in the APP *and* spawns a real
worker with its own pollers.` The spawned worker
(`scripts/e2e-session.mjs:380-382`) registers the same handlers but never
receives this job in the lane.

**Why it matters, and it is not academic.** The plan's stated reason points at a
wrong implementation. A builder reading "worker-side" would naturally set the
var on the worker child only - `spawnNode` already supports it
(`scripts/e2e-session.mjs:304-305`, `envOverride` merged over `childEnv`, as
`web-next` and `fake-twilio` do at `:419-422` and `:442-458`). That would leave
the APP process on the production 60/120/240 ladder, and Task 14's
`toContainText('delivered 2/2 - 1 on retry', { timeout: 60_000 })` would fail
on a correct build, ~60s per run, with no signal pointing at the env var.

**What to do.** Keep the seam exactly where the plan puts it
(`registerHandlers.ts`, called by BOTH `index.ts:56` and `worker.ts:112`), but
set the value as a LITERAL in `childEnv` (`scripts/e2e-session.mjs:109-256`),
which both `startApp` and `startWorker` inherit with no override, in both
`npm run e2e` and `npm run e2e:session`. Fix the plan's rationale sentence so
the next reader does not re-derive it wrongly. Note also the useful corollary:
because the job runs app-side, its WARN/ERROR lines DO reach
`GET /__dev/logtail`, which is the opposite of the usual worker caveat
(`app/src/routes/dev.ts:231-235`).

**Severity: MUST-HANDLE.**

---

## 2. MUST-HANDLE: rung 1 is enqueued by the WEBHOOK, so a registration-scoped backoff never reaches it

**Plan says** (Task 14 Step 1, plan line 1751-1764):
`Read `E2E_RELAY_RETRY_BACKOFF_MS` at handler registration and pass it as `deps.backoffMs`.`
with `registerRelayRetryLegJobHandler(... ? { backoffMs: () => override } : undefined)`.

**The tree holds** that the first rung's enqueue is not in the handler at all.
Plan Task 12 Step 3 item 8 puts `enqueueRelayRetryLeg` inside the webhook's
claim helper, and Task 11 declares it as a FREE function -
`enqueueRelayRetryLeg(payload, attempt, deps?: Pick<RelayRetryLegJobDeps,'backoffMs'>)`
(plan lines 1223-1226). The registrar's `deps` object is a closure argument to
`registerRelayRetryLegJobHandler`; nothing in the plan connects the two. The
existing precedent has the same split and no override to carry -
`enqueueSendRetry` computes `runAt` from the module-level `retryBackoffMs`
(`app/src/jobs/retrySend.ts:73-77`, `:40-42`) with no relation to
`registerRetrySendJobHandler`'s deps (`:93`).

**Consequence.** Rung 1 - the only rung the browser proof waits for - would take
the production 60s while rungs 2 and 3 (enqueued from inside the handler) took
the lane override. Task 14 Step 2's assertion 1
(`'1 retrying'`, 30s) and assertion 2 (`'delivered 2/2 - 1 on retry'`, 60s)
would both sit on the wrong side of that.

**What to do.** Have `registerRelayRetryLegJobHandler` store the resolved
backoff in MODULE scope and have `enqueueRelayRetryLeg` default to it (the two
live in one module, and per finding 1 they are in one process in the lane).
State that explicitly in Task 11's Interfaces block, and make Task 14 Step 1's
unit assertion cover the ENQUEUE side, not only the handler side.

**Severity: MUST-HANDLE.**

---

## 3. MUST-HANDLE: `e2e/support/selectors.md` pins the exact copy D15/D19 change, and no task touches it

**The tree holds**, at `e2e/support/selectors.md:49` (the per-recipient-rows
row), the maintained register of every delivery string this feature rewrites:
it enumerates `Delivered`, `Sent`, `Sending`, `Sent - not confirmed`,
`Queued - not confirmed`, the `Not sent - opted out` variants, the two app-owned
codes (`transient_cap`, `enqueue_failed`) with their prose, and then:
`A relay 30003 reads `Undelivered - Phone unreachable (error 30003)` and must
not promise a retry; native Group MMS keeps its existing `will retry` promise.`

**Spec/plan say** D19's row grammar becomes `Retrying - Phone unreachable (error
30003)` and `Delivered on retry` (spec Sec 5, second table), and D15 adds four
more app-owned internal codes to the same map
(`retry_group_closed`, `retry_member_removed`, `retry_number_changed`,
`retry_opted_out`). The plan's File Structure and Tasks 8, 9 and 14 name no
`e2e/support/selectors.md`, and Task 15 is scoped to `docs/issues/`.

**Consequence.** The one file the harness treats as the selector/copy contract
would go stale on the exact strings the feature exists to add, in the same
paragraph that already tracks the two sibling internal codes. AGENTS.md points
every spec author at this file.

**What to do.** Add `e2e/support/selectors.md` to Task 14's file list: extend
row 49 with the two new relay row strings and the four new internal codes, and
soften the "must not promise a retry" clause to the post-D19 rule (no
`will retry` promise; a claimed retry says `Retrying`). Leave the native
group-text half untouched - it is fenced, and
`docs/issues/group-text-30003-leg-retry-promise-unverified.md:78-81` records that
`Timeline.delivery.test.tsx:517` pins it deliberately.

**Severity: MUST-HANDLE.**

---

## 4. NOTE: `relay-inbound-source-has-no-delivery-rollup.md` says the retry "renders nothing" for inbound - the spec says otherwise

**The tree holds**, at
`docs/issues/relay-inbound-source-has-no-delivery-rollup.md:60-62`:
`the mission that found this; its retry works for inbound sources but renders
nothing for them, by design.`

**Spec says** the opposite for two of the three positions. Sec 2:
`**It does NOT follow that inbound sources render nothing.** Two of D21's three
positions exist there: the per-recipient rows (`Timeline.tsx:948-951`) and a
dedicated accessible-name recital ... which is the ONLY delivery information a
screen-reader user gets from that bubble. Those two are IN scope on both
directions.` Sec 5 repeats it, and Sec 7 intention 12 makes the inbound recital
its own test. Only the visible CHIP is out of scope.

**Consequence.** The issue understates the shipped behavior on precisely the
accessibility surface the spec argues hardest about. Task 15 Step 3's stated
check is "that the second names all three hosts" - it does (`:39-45`, verified)
- so this sentence would pass unexamined.

**What to do.** In Task 15 Step 3, correct that clause: the retry renders no
CHIP on an inbound source; the per-recipient rows and the
`inboundRecipientName` recital DO carry the new states. Keep the issue OPEN.

**Severity: NOTE.**

---

## 5. NOTE: `relay-member-key-collapses-two-phones-one-contact.md` misdescribes where the destination is recorded

**The tree holds**, at
`docs/issues/relay-member-key-collapses-two-phones-one-contact.md:63-65`:
`it records the destination on the leg at send time so a retry can refuse when
the number has changed since.`

**Spec says** nothing is recorded on the leg. D5: `Only the DIGEST is stored (see
D11)`. D11 puts it on the RETRY ROW (`relay_retry_dest_digest`, one of the six
stored lineage values, plan Task 1). D17 is explicit that
`RelayRecipientDelivery` is NOT changed - `no per-leg retry state is stored on a
slot, which is what keeps D1's promise that the failed slot is never rewritten`.
The distinction is load-bearing: "on the leg" describes the in-place-promotion
alternative the spec REJECTED (Sec 10).

**What to do.** Task 15 Step 3 already asks whether this file's recorded
workarounds "still describe what actually shipped". They do not, in that clause.
Rewrite it as: the retry ROW stores a digest of `<root tsMsgId>|<destination
E164>`, and the retry job compares that digest against the member's current
number before sending. Keep the issue OPEN.

**Severity: NOTE.**

---

## 6. NOTE: D4's duplicate-DELIVERY guard cannot be exercised end to end in the lane

**Spec Sec 7 intention 2** requires the two guards to be tested separately:
`A duplicate JOB DELIVERY is stopped by the execution marker. A test that
exercised only the create would pass while the queue hazard shipped live.`

**The tree holds** that the hermetic lane has no mechanism that can redeliver a
job. The in-process adapter runs an immediate job exactly once and SWALLOWS a
throw (`app/src/adapters/scheduler.ts:193-204`), and runs a delayed job exactly
once through a bare `void this.deps.dispatch(wire)` with no catch
(`:180-184`) - a throw there surfaces as an `unhandledRejection`, which
`app/src/lib/errors.ts:128-132` logs at ERROR and survives (only
`uncaughtException` exits, `:119-126`). Only `SqsJobConsumer` redelivers, and
only in a deployed stack.

**Consequence.** This is not a defect in the plan - Task 11 Step 1 correctly
puts the guard in a unit test. It is recorded so nobody at self-QA or handback
reads a green `npm run e2e` as evidence for D4, and so nobody tries to
manufacture a redelivery in the lane. It also means a thrown retry handler in
the lane produces an ERROR line and a silently lost rung rather than a crash -
worth knowing when the browser proof mysteriously stalls at `1 retrying`.

**Severity: NOTE.**
