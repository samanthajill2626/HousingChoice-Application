# Plan review R1, reviewer B - retry-send-window plan v1

Reviewed: `docs/superpowers/plans/2026-09-25-retry-send-window.md` (plan v1 as
committed at `d35f3e91`, 21 tasks) against
`docs/superpowers/specs/2026-09-24-retry-send-window-design.md` (draft 7.1 as
committed at `d35f3e91`) and the code on `feat/retry-send-window` (source
identical to `main` @`da04d0cb`; the plan's `f49a2fe9` and `fd38ba73` citations
resolve to the same code). Also in scope: spec D3, D3a, D7, D14 and the draft
6/7/7.1 edits.

## Method and limits

- Read-only. The worktree has no `node_modules`, so no test or typecheck ran.
  Judgements that something "compiles", "is red" or "passes" come from reading
  the code the plan quotes and the code it calls.
- Checked against the files: the quoted "old" text of every edit I sampled in
  Tasks 2-17 and 20 (all matched), the helpers and fixtures each new test calls
  (`createFakeWorld`, `makeWebhookHarness({ env })`, `seedOutbound`,
  `makeFakes`, `makeRetryApp`, `seedRetryRow`, `failNextLeg`, `slotOf(ts, key)`,
  `deliverDelayed` shifting `delayed[]`, the ticker helpers), every caller of
  the send wrapper (all ten pass `automated` explicitly, as D14 says), every
  writer and reader of `retry_due_at`, `retry_window_start`, `automated`,
  `recipient_contact_id` and `relay_retry_window_start`, and every dashboard
  reader of the 30003 copy (`deliveryReason` call sites, `shareRecipientReason`,
  EmailCard, rollup, rows).
- Verified the token-bucket semantics Task 6 relies on: a bounded `acquire` on a
  drained bucket throws `TokenBucketBusyError` from the pre-sleep deadline check
  (`app/src/lib/tokenBucket.ts:193-196`) and never calls the test's throwing
  `sleep`, so Task 6's red and green states are real.
- Verified the gate-5 baseline claim by running eslint READ-ONLY in the main
  checkout (`da04d0cb`, identical source) over every `.ts`/`.tsx` file the plan
  touches: exactly one error, `dashboard/src/routes/contact/Timeline.tsx:1495`
  `react-hooks/set-state-in-effect`, as the plan says.
- UNVERIFIED (live behavior no read can settle): that CloudFront forwards a
  fresh origin `Date` header on `/api/*` (the config is `CachingDisabled`,
  `infra/modules/cloudfront/main.tf:166`, which makes it very likely).

## The plan changed during this review

At 22:09-22:14 EDT, after reviewer A's file landed (22:06), the planner began an
UNCOMMITTED revision of both files (spec "draft 7.2", `git diff --stat`: plan
160 lines, spec 84 lines). Findings below are against v1; each notes whether
the in-flight revision (as last observed at 22:13:57) already addresses it.
Finding 1 is about the in-flight revision itself.

Headline: v1 is mechanically sound. I found no quoted anchor that fails to
match, no new test that would not compile, and no unnamed writer of the new
state. No BLOCKING defect in v1. One MEDIUM (a setup instruction that is false),
the rest LOW; plus one HIGH that exists only in the half-applied revision.

---

## Findings

### 1. [HIGH] In-flight revision: Task 4 still builds the two-write claim-time close that spec draft 7.2 removed

What is wrong. Spec draft 7.2 (uncommitted) rewrites D3: a declined rung is
"APPENDED already closed ... written in the claim's one append transaction",
and "The claim's enqueue-failure close (`closeRetryLegEnqueueFailed`) is
unchanged and remains its only close" (spec lines ~174-197 of the working
tree). The in-flight plan edits follow that in Task 16's Interfaces ("the claim
appends the declined rung already closed"), Task 20 Step 4 (the
`relay-retry-stranded-claim-window` note is DROPPED because "the claim adds no
new stranding site"), the residuals table (the "Stranded claim-time close" row
removed) and Task 21's handback ("A claim-time decline is a closed APPEND, not
a close"). But Task 4 itself is unchanged: its Files list still renames
`closeRetryLegEnqueueFailed` -> `closeClaimedRetryLeg` with a code parameter,
Step 5(d) still defines it, Step 5(h) still appends the rung OPEN and then
closes it, and Step 2 still pins "keeps gate_refused and names the stranded
rung at ERROR when the claim-time close throws" (plan working tree, lines
~1628, ~1635, ~2206, ~2423, ~2653, ~2701, ~2807).

Evidence. `grep -n closeClaimedRetryLeg` on the working-tree plan returns 7 hits
at 22:13:57; `git diff` of the spec shows the D3 rewrite and the section 9
"Stranded claim-time close" residual deleted.

What it implies. If the revision lands as observed, a literal builder builds the
two-write close (the stranding window the revised spec says no longer exists),
its tests pin that mechanism, Task 20 skips recording the stranding in the
issue because its stated premise is false, and the handback tells SOR "no
attempt record can exist for it" about a close that does exist. Before
re-dispatch, Task 4 needs: the declined rung appended with its member slot in
`refuseGate`'s final shape (legacy `{status:'failed', errorCode}`; versioned
`{status:'failed', requestedTransport?, transportAggregationState:'excluded',
errorCode}` - `assertTransportPersistenceShape`,
`app/src/repos/messagesRepo.ts:959-966`, accepts `excluded` at append), no
rename of `closeRetryLegEnqueueFailed`, the close-throws test replaced, and
Task 16's interface cite of `twilio.ts:627-660` as a source of the declined
shape removed. (If the planner was about to do exactly this, close it.)

### 2. [MEDIUM] Task 1 Step 0 says slices 1-2 need no DynamoDB Local because globalSetup is "fail-soft" - it is fail-LOUD (addressed in the in-flight revision)

What is wrong. v1 Task 1 Step 0: "Every app suite this slice touches (Tasks 1,
3, 4, 5, 6) ... needs no DynamoDB Local - `app/test/globalSetup.ts` is
fail-soft when Docker is down. Start `npm run db:start` before the other
slices' integration suites". That contradicts the plan's own Global
Constraints (line 26) and Task 2 Step 3, and the code: `globalSetup.ts:14-17`
("FAIL-LOUD (changed 2026-08-21)") and `:69-88` throw unless
`ALLOW_SKIP_DYNAMO_TESTS=1`. The false claim comes from a stale comment at
`app/vitest.config.ts:121-123` ("Fail-soft: if Docker is down the setup warns
and returns").

What it implies. A builder who follows Step 0 gets a globalSetup error at Task 1
Step 2 instead of the promised "cannot import" red, and Task 1 Step 4 cannot
pass. The in-flight edit rewrites Step 0 to start DynamoDB Local; the stale
vitest.config.ts comment remains in the repo (out of this branch's scope).

### 3. [LOW] v1's stated mid-build state for Tasks 10-17 is wrong (addressed in-flight)

v1 says "Between Task 10 and Task 17 ... the bubble shows the plain failure -
under-promising only". Until Task 15 the chip still reads the code-keyed em-dash
"will retry" on EVERY 30003 (`deliveryStatus.ts:778`), declined retries
included - over-promising; and from Task 12 to Task 17 the server's 409
`retry_pending` reads the generic "Couldn't send" (`Timeline.tsx:130`). Nothing
ships between tasks, so only the stated contract is wrong. The in-flight edit
states both correctly.

### 4. [LOW] Two comments the builder copies call a missing conversation an ERROR dead end; code, test and ruling say WARN (addressed in-flight)

v1 Task 10's `oneToOneRetryDecision.ts` header ("1. the conversation row -
missing: decline, ERROR (a real anomaly)") and the rewritten twilio.ts severity
comment (B) ("a dead end (retries exhausted, the 15-minute send window closed,
the conversation row missing) is its own ERROR line") contradict the code
(`level: 'warn'`), the DECLINES test (WARN) and the planner ruling (Global
Constraints; self-review notes). The header also says the parity table lives in
`test/sendRefusalPreview.test.ts`; it is in `test/sendMessage.test.ts`. D12
exists to stop comments that lie; these would lie from their first commit. The
in-flight edit fixes both ERROR claims (check the parity-table file name too).

### 5. [LOW] The drift guard was overclaimed: a NEW send-path gate turns nothing red (addressed in-flight)

v1's parity comment: "A gate added to, reordered in or removed from sendMessage
... turns this red"; spec 7.1 D3a: "share one set of predicates, so they cannot
drift". `previewSendRefusal` re-implements the gate SEQUENCE
(`sendMessage.ts:298-391` stays as is); the 24-row table only exercises the
conditions it sets. A new gate on a condition no row sets (for example a
quiet-hours gate for automated sends, which `quiet-hours-ungated-automated-paths`
may yet add, or a closed-conversation gate) passes both suites while the
decision keeps promising retries the job refuses (bounded to about 6 minutes
per message). The in-flight edit makes the plan comment and spec 7.2 honest
("a new gate in the send path needs a new row"). The residual risk is process
only; a structural single composition (the wrapper mapping
`previewSendRefusal`'s code to its error) was not chosen, which is acceptable
once stated.

### 6. [LOW] v1 did not deliver test intention 4's "one table drives both tests" for the decision (addressed in-flight)

v1 Task 7 says Task 10's decision test "can run the same rows", but Task 10's
test used its own 8-row REFUSALS table, so the decision's own input mapping
(`automated ?? true`, recipient-or-phone fallback) was never run against the
send path's cases. The in-flight Task 10 Step 8b adds an `it.each` over
`SEND_REFUSAL_CASES` through `decideOneToOneRetry`; I traced every row (kill
switch, opt-out on each record, deleted, consent, manual mode, raw phone) and
each yields the table's code at WARN or `retryAt(1)`. Note it still does not
run the rows through the JOB's input mapping (`retrySend.ts`), which is coded a
second time; the two mappings agree today.

### 7. [LOW] Spec section 4 readers had no recorded disposition in v1 (addressed in-flight)

Section 4 requires each listed reader "as a task or a watch item"; v1 was
silent on `useRelayThread.ts:101-142`, `relayRetryJoin.ts:135-164`/`:453`,
`Timeline.tsx:1077`/`:1975-1984`/`:2004-2019`, `twilio.ts:3129`,
`messagesRepo.ts:2335`. None needs a change (I checked each: they read
relay lineage or `retry_of` only; `buildRelayItems` is a fixed field list shared
with `useGroupThread`, so it drops `retry_due_at` - which keeps a D3a fail-open
stamp on a group text off the group view). The in-flight edit adds these as
watch items. `types.ts:2308-2315`/`:2509-2515` are still unlisted (harmless).

### 8. [LOW] D13 "Unit tests inject the clock" is not honored at three of the four checkpoints, and the spec is not amended

Spec D13's first bullet: "Unit tests inject the clock." Only the pure helpers
(Task 1), the one-to-one decision (Task 10, `nowMs`) and the one-to-one job
(Task 11, `now` dep) inject it. The relay claim (`nowMs: Date.now()`, Task 4
Step 5(f)), the relay job gate and transient re-check (`Date.now()`, Task 5
Step 3(f)/(g)) and the one-to-one webhook arm (`nowMs: Date.now()`, Task 10
Step 7(C)) read the wall clock, and their tests use wall-clock-relative
fixtures (`minutesAgo`, `Date.now() - 30_000`). The deviation lives only in the
self-review notes ("The webhook gets no clock seam"). Consequence: no
integration-level test pins an exact boundary (only the pure helper does), and
every such test depends on its 30-second-or-more margin holding on a loaded
runner. Either amend D13 to say the webhook and relay job are tested with
wall-clock-relative margins, or add a clock seam; today plan and spec disagree.

### 9. [LOW] Spec: section 1's expiry bound is stated for all automatic retries, but a relay leg's "Retrying" follows a 15-minute budget

Section 1: the screen "stops promising it within `RETRY_PROMISE_GRACE_MS` plus
one ticker interval after it was due". D8 carves the relay promise out ("it
stays governed by its live rung", `relayRetryJoin.ts:370-377`), and the join
keeps a non-terminal rung "Retrying" until `STALE_SENT_AFTER_MS` of quiet
(`relayRetryJoin.ts:224-235`, `:330-335`). A rung stranded between append and
enqueue (`relay-retry-stranded-claim-window`) therefore reads "Retrying" for up
to 15 minutes. Section 1 should scope the bound to the one-to-one bubble and
name the relay horizon; as written it promises more than D8 delivers. (Under
v1's two-write close a DECLINED rung could also strand open and read
"Retrying"; the in-flight one-write design removes that case.)

### 10. [LOW] Spec D3a: "the breaker is the one refusal the arm cannot preview" is inaccurate; section 9 omits the provider-error case

A provider-side error on the retry's own send cannot be previewed either: the
Twilio adapter rethrows create errors unchanged (`app/src/adapters/messaging.ts:690-707`),
`retrySend` rethrows any non-`SendRefusedError` (`app/src/jobs/retrySend.ts:208-219`)
AFTER its execution marker (`:129-146`), so the SQS redelivery is suppressed as
a duplicate and the retry is lost while the stamp keeps "will retry" and hides
Retry until expiry. That is the same class as section 9's "A promise with
nothing behind it", whose list names the breaker, a fail-open refusal, a
job-time decline, a failed correction and (in 7.2) a crash or throw before the
enqueue, but not a provider error at send. Say "the breaker and provider-side
send errors" and add it to the section 9 list; the plan's residuals table
follows it.

### 11. [LOW] D14 changes what `automated` means without correcting its documented meaning; the audit trail loses "machine-initiated"

`SendMessageInput.automated` is documented as "True for machine-initiated sends
(reminders, AI in Phase 2) - these are what the circuit breaker meters and what
manual mode refuses" (`app/src/services/sendMessage.ts:208-212`). Under D14 the
automatic retry of a person's send is machine-initiated and passes `false`.
Task 8 Step 3a appends a D14 sentence but keeps the now-false first sentence
(D12's rule is to correct such comments). The same value lands on the row and in
the `message_sent` audit row (`sendMessage.ts:457-461`), which has no retry
field, so the audit can no longer tell an automatic retry of a staff text from
a staff member pressing Retry (the ROW still can, by `retry_attempt`). Nothing
in code reads the audit flag today (`grep message_sent` finds only writers), so
the consequence is a misleading doc and a less informative audit trail: correct
the doc to "gated like a machine send", and consider stating in D14 that the
flag now means gating, not origin.

### 12. [LOW] Task 21's "Relay for SOR" section does not follow Cameron's recorded standing instruction

`rulings.md:83-86` records: "the final handback ends with a 'Relay for SOR'
section - one fenced, ASCII-only block with full W:\ paths - carrying Branch A's
five items for send-outcome-reconcile unchanged plus this branch's own
hand-off". Task 21's template puts "Relay for SOR" mid-document (Issues,
Deferred and Build-time deviations follow it), as prose sections with
repo-relative paths, and never carries Branch A's SOR items
(`docs/superpowers/reviews/2026-09-24-share-skip-fix/planner-verdict.md:117-126`).
If the instruction binds the planner's final handback rather than the build
handback, say so in the plan; either way no task currently owns producing that
block.

---

## Checked and sound (not findings)

- Task 3's evaluator is behavior-preserving apart from the intended pool-number
  reorder: `logSafeStoredMemberKey(memberKey)` equals `logSafeMemberKey(member)`
  for a matched member (`relayAnnouncements.ts:157-161`), so the WARN lines keep
  their fields; the removed imports are used nowhere else in the job.
- Task 4 v1: the root slot keeps `sentAt` through the failure write (real repo
  writes child fields, `messagesRepo.ts:3616-3633`; the fake spreads the slot);
  `resolveRelayRetryBackoff()` with no deps is the same chain
  `enqueueRelayRetryLeg` uses from the webhook; the pre-existing relay severity
  battery and claim tests seed open groups with the member on the roster, so
  the new preview claims them as before.
- The D7 one-write stamp, the forward-only transition (`messagesRepo.ts:133-142`),
  the arm's transition gate and the withdrawal path all hold; the concurrency
  pin (Review Focus 2) is sound against the fake's synchronous check-and-set.
- Every one-to-one fixture that posts a 30003 goes through `seedOutbound`, so
  Task 10's realistic-time move is complete; no seed or dev seam writes a 30003
  or any retry field.
- Task 14: every existing fetch double already carries `headers` (parseBody
  reads them), so reading `Date` first breaks none; the dashboard pins `Date`
  with a bare `setSystemTime`, so the whole-second fixtures round-trip.
- Task 17: the memo snapshot is retaken on every tick and every rendered-set
  change, and a live promise always arms the ticker, so expiry lands within one
  tick; `StreamItem`/`MessageBubble` have single call sites.
- Task 19: `workers: 1`, a reseed precedent (`share-skip-fix.spec.ts:38-39`), an
  absent-Origin POST precedent, Tasha's lean-seed consent and auto mode, and the
  neighbour count (1 + 3 = the stated 5 with this spec) all check out.
