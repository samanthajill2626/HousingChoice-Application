# Plan review R1, reviewer A - retry-send-window plan v1

Reviewed: `docs/superpowers/plans/2026-09-25-retry-send-window.md` (plan v1, 21
tasks) against `docs/superpowers/specs/2026-09-24-retry-send-window-design.md`
(draft 7.1) and the code on `feat/retry-send-window` (source identical to `main`
@`da04d0cb`; the plan cites `f49a2fe9`, and Tasks 10-11 cite `fd38ba73`, a
docs-only commit whose code equals `f49a2fe9`). Also in scope: spec D3, D3a, D7,
D14 and the draft 6/7/7.1 edits.

Method and limits. Read-only. The worktree has no `node_modules`, so no test,
typecheck or lint was run: every "compiles" or "passes" judgement below is by
reading the code the plan quotes and the code it edits. I checked the quoted
"old" text of every edit in Tasks 2-17 and 20 against the files (all matched),
the helpers and fixtures each new test calls, the TDD red states, and every
writer and reader of the five new row fields. Anything not traced is marked
UNVERIFIED.

Headline. The plan is mechanically sound: I found no quoted anchor that fails to
match, no test that would not compile or would pass vacuously, and no unnamed
mutation surface for the new state. The findings are about guarantees the spec
states that its own mechanisms do not deliver, one avoidable design choice in
D3, and plan-text precision. None blocks the build.

---

## 1. [LOW] D3 declines a rung with two writes (append open, then close) when the decision is already known before the append

What is wrong. D3 creates a declined rung OPEN and then closes it with the
claim's enqueue-failure helper. The plan implements exactly that (Task 4 Step 5
(f) computes `decline` BEFORE `messages.append`, then (h) closes after the
append). The reuse argument does not transfer: `enqueue_failed` needs two writes
because the enqueue outcome is only known after the append
(`app/src/routes/webhooks/twilio.ts:2841-2891`); a gate or window decline is
known before it. The rung could be appended already closed - legacy
`{ status: 'failed', errorCode }`, versioned `{ status: 'failed',
requestedTransport, transportAggregationState: 'excluded', errorCode }`, the
exact literals the plan's own tests pin for both closes - in the SAME
TransactWrite that writes the `sid#` claim pointer. `append` accepts an
`excluded` slot at append time (`app/src/repos/messagesRepo.ts:959-966` only
checks membership in planned/attempted/excluded). The plan concedes this in
Task 20 Step 4 ("a declined rung could be written closed inside the append
transaction itself").

Evidence. Spec D3 ("The close is the one the claim already makes for a rung it
could not enqueue"), spec section 9 "Stranded claim-time close", plan Task 4
Step 5 (f), (h); twilio.ts:2781-2835 (append is the claim);
`dashboard/src/routes/contact/relayRetryJoin.ts:375-377` (a live queued rung
reads `retrying`), `:400-403` (`unconfirmed` after the horizon).

What it implies.
- Section 9's "Stranded claim-time close" residual is created by this choice,
  not inherited: a kill between the two writes, or a failed close, leaves an
  open rung that is never enqueued. The join reads it `Retrying` for the
  staleness budget (15 minutes) and `not confirmed` after - the exact false
  promise this branch exists to remove - and no redelivery can repair it (the
  deduped append returns first).
- D3's guarantee "the claim's existing SSE for the root fires after the close,
  so the screen never sees a declined rung open" is not delivered: the
  dashboard's SSE consumer is a debounced full refetch on ANY
  `message.persisted` (`app/src/jobs/relayRetryLeg.ts:424-427`), so a refetch
  triggered by another leg or thread between the append and the close shows the
  declined rung as `Retrying`.
- The separately guarded close and its extra ERROR path exist only because of
  the second write.
Fix: append a declined rung with its final slot and keep `closeClaimedRetryLeg`
for `enqueue_failed` only. Same data shape, one write, no new residual.

## 2. [LOW] Spec section 1's invariant is not delivered for relay legs, D3's new reads widen the gap, and section 9 misses a thrown-exception twin of its one-to-one crash residual

What is wrong. Section 1 promises "never a plain failure that later turns into
'will retry'" and names three exceptions. For a relay leg the failure is
written, and is visible, BEFORE the claim decides: the root slot's terminal
write (`twilio.ts:2947-2953`) precedes `claimRelayRetry` (`:3003`), and a leg
with no rung yet projects as the plain failure
(`relayRetryJoin.ts:343-344`, `if (rungs.length === 0) return { ...slot }`;
the relay 30003 copy "Phone unreachable (error 30003)"). Any refetch in that
window shows the plain failure, then `Retrying` once the claim's append and SSE
land - the exact pattern ruled out. `claim_failed`, the only relay exception
named, is a different path. D3 inserts three more round trips into this window
(plan Task 4 Step 5 (f): `conversations.getById`, then `isMemberSuppressed` =
`contacts.getById` + a `findByParticipantPhone` GSI query,
`app/src/services/relayAnnouncements.ts:64-100`).

Related gap in section 9. "A promise with nothing behind it" names a process
that DIED between the stamped status write and the enqueue. A THROW on the same
path does the same: `setMessageActualTransport` (`twilio.ts:3252-3259`) is
awaited after the stamped `updateDeliveryStatus` and before the 30003 arm; a
DynamoDB throttle there 5xxs the callback, Twilio's redelivery transitions
nothing, the arm never runs, the retry is lost and the stamp stands until it
expires.

What it implies. The ruled invariant holds for one-to-one only. Either record
the relay slot-then-claim window (and the throw path) as named exceptions, or
accept them explicitly; a downstream reviewer reading section 1 will otherwise
assume relay is covered.

## 3. [LOW] D3 turns a momentary human-action state at claim time into a permanent refusal

What is wrong. Today the claim enqueues and the job re-checks every gate 60-240
seconds later (`app/src/jobs/relayRetryLeg.ts:491-555`), so a member who texts
STOP and then START, a member removed and re-added, or a group closed and
reopened inside the backoff still gets the retry. Under D3 the claim closes the
rung with the gate's code at once and enqueues nothing, so nothing re-evaluates:
the retry is gone, and the leg reads "Not retried - opted out" (or its sibling)
even after the state reversed.

Evidence. Spec D3 step 1 and the closing sentence of D3 ("the job still runs
every gate at send time, because a group can close during the wait" - the
reverse direction is not discussed); spec section 9 has no entry for it.

What it implies. A rare lost retry and copy that contradicts current state.
Cameron's Q1 ruling treats these gates as deliberate human actions, so this may
well be acceptable - but it is a trade-off D3 makes silently. Accept it in
section 9 or say so in D3.

## 4. [LOW] Task 1 Step 0 says slices 1-2 need no DynamoDB Local because globalSetup is fail-soft; globalSetup fails every vitest run without it

What is wrong. Plan line 114 (Task 1 Step 0): "Every app suite this slice
touches (Tasks 1, 3, 4, 5, 6) runs on the in-memory createFakeWorld ... and
needs no DynamoDB Local - app/test/globalSetup.ts is fail-soft when Docker is
down." That is false: `app/test/globalSetup.ts:14-17` ("FAIL-LOUD (changed
2026-08-21)") and `:69-88` throw unless `ALLOW_SKIP_DYNAMO_TESTS=1`. It also
contradicts the plan's own Global Constraints (plan line 26) and Task 2 Step 3
(plan line 718).

What it implies. A builder following Task 1 literally skips `npm run db:start`;
Task 1 Step 2's "expected FAIL" then fails for the wrong reason (the globalSetup
throw, not module-not-found) and can be misread as the intended red, and Step 4
fails. Delete the Step 0 sentence; keep the Global Constraints line.

## 5. [LOW] Shipped comments contradict the code on `conversation_missing`, and two 30003 carve-out comments outside D12's list stay stale

What is wrong.
- The decision module header the plan writes (plan line 5181, Task 10 Step 3)
  says "the conversation row - missing: decline, ERROR (a real anomaly)", and
  the new twilio.ts severity-taxonomy comment (Task 10 Step 7 (B), plan lines
  5847-5849) lists "the conversation row missing" among the ERROR dead ends. The
  code returns `level: 'warn'` (plan line 5247), as the Global Constraints (plan
  line 25), spec D9 and the arm's own comment (plan lines 5935-5939) say.
- Not in any task: the `isTerminalDeliveryFailure` doc (`twilio.ts:345-350`,
  "False for a transient code we auto-retry (30003)") and the one-to-one marker
  comment (`twilio.ts:3272-3278`, "a transient-retrying ... callback stays
  WARN"). After D3a a 30003 is often NOT retried; the marker stays WARN for a
  different reason (D9, which the new comment at (B) states).

What it implies. The branch's own D12 exists to remove comments that lie; this
adds two and leaves two. Fix the two new comments to WARN, and add the two
existing ones to Task 10 (B).

## 6. [LOW] The decision/send-path drift guard is weaker than the spec's "cannot drift" and "one table drives both tests"

What is wrong. Spec D3a says the decision and the send path "share one set of
predicates, so they cannot drift"; test intention 4 says "one table drives both
tests". The plan keeps `sendMessage`'s inline gate sequence
(`app/src/services/sendMessage.ts:298-391`) and re-implements the order and the
combination logic in `previewSendRefusal` (Task 7 Step 5). Parity is proven only
for the 24 table rows. Task 7's parity comment claims "A gate added to,
reordered in or removed from sendMessage without the same change to the preview
turns this red" - a NEW gate that no row triggers stays green. And Task 7's
Interfaces say the table exists "so Task 10's decision test can run the same
rows", but Task 10's decision test never imports it (its own 8-row `REFUSALS`,
plan lines 4925-4985), so the decision itself (the `automated ?? true` default,
the recipient-by-id fallback) is not table-driven.

What it implies. The first gate Work Package 2 (or anyone) adds to `sendMessage`
silently makes the webhook promise retries the send path refuses (bounded by the
promise's expiry) or decline retries it would send. Either have `sendMessage`
take its refusal from the same ordered predicate list the preview uses, or at
least correct the comment and the Interfaces text so no one relies on a guard
that is not there.

## 7. [LOW] D3's new relay-job order (the pool-number throw after the four gates) has no test, and Task 3's commit calls the refactor behavior-unchanged

What is wrong. Spec D3 step 1 changes the job: "the job's own 'open group with
no pool number' check now follows the four gates". Task 3 Step 4 moves the throw
(plan lines 1578-1585) - now also after the suppression read - but no test pins
either half: a pool-less open group whose member fails a gate closes with that
gate's code; a pool-less open group whose member passes still throws.
`app/test/relayRetryLeg.test.ts` has no pool-less case at all (no match for "no
pool number"). Task 3's commit message says "Behavior unchanged".

What it implies. A regression of the order, or of the throw, is invisible to
every gate. Add one table row for each half in Task 3 and drop "Behavior
unchanged" from the commit.

## 8. [LOW] The plan's mid-build-state list is inaccurate and incomplete

What is wrong.
- Plan line 83: "Between Task 10 and Task 17, a live promise is written but the
  one-to-one chip does not read it yet, so the bubble shows the plain failure -
  under-promising only." True only from Task 15. For Tasks 10-14 the chip still
  renders the code-keyed em-dash promise on EVERY 30003
  (`dashboard/src/routes/contact/deliveryStatus.ts:778`), declined retries
  included - over-promising.
- Not listed: for Tasks 12-16 the server refuses a manual Retry with 409
  `retry_pending` while the dashboard still renders the Retry button during the
  wait and maps the 409 to the generic "Couldn't send - please try again."
  (`dashboard/src/routes/contact/Timeline.tsx:130`), which invites pressing
  again.
- Cosmetic: Tasks 10-11 give line numbers "at HEAD fd38ba73", the header says
  `f49a2fe9` (code-identical).

What it implies. Only matters if someone stops, demos or bisects mid-branch, but
the section exists to say exactly this. Correct it.

## 9. [LOW] Spec section 4's "readers of retry lineage" are not recorded as tasks or watch items

What is wrong. Spec section 4 opens: "The plan enumerates each as a task or a
watch item." Several listed readers appear nowhere in the plan: the
relay-escalation gate on `relay_retry_of` (`twilio.ts:3129`), the media-pointer
guard (`messagesRepo.ts:2335`), `relayRetryJoin.ts:135-164` and `:453`,
`dashboard/src/routes/conversation/useRelayThread.ts:101-142` (a fixed field
list shared with `useGroupThread` via `buildRelayItems`, which drops
`retry_due_at` and `relay_retry_window_start`), and `Timeline.tsx:1077`,
`:1975-1984`, `:2004-2019`.

What it implies. I checked each: none needs a code change (D6 moves `retry_of`
earlier by milliseconds, so the supersession collapse is unchanged; the
fixed-list mappers drop the new fields harmlessly, which also keeps a fail-open
group-text stamp off the group view). But the plan records none of that, so
every plan-anchored reviewer downstream inherits no evidence these were
examined. Add a short watch-item list.

## 10. [LOW] Spec D3a's parenthetical misdescribes `evaluateScheduledSendSuppression`

What is wrong. D3a: "(the existing evaluateScheduledSendSuppression ... covers
the first three only)". The first three in D3a's list are the kill switch,
opt-out and soft-deleted. The function covers the kill switch, opt-out and
MANUAL MODE (`app/src/services/scheduledSendSuppression.ts:66-68`) and omits
soft-deleted by design (`:48-51`) - which the same D3a sentence says two lines
earlier. It also takes a single contact's flag, never the recipient's.

What it implies. Harmless to this plan (Task 7 builds its own preview), but a
reader reusing that function for the soft-deleted gate on the strength of this
sentence would miss it. Fix the parenthetical.

---

## Checked and found sound (no finding)

- Quoted "old" text matches the files for every edit checked: messagesRepo.ts
  (`:725-733`, `:737-740`, `:758`, `:999-1000`, `:1016`, `:1173-1177`, `:1261`,
  `:1405`, `:2262-2284`, `:2541-2580`, `:2912-2938`); the harness
  (`:1130-1152`, `:1213-1220`); relayRetryLeg.ts (`:1-7`, `:34-53`, `:80-97`,
  `:256-292`, `:371`, `:482-555`, `:643-646`); relayFanOut.ts (`:35`,
  `:1219-1231`, `:1250-1252`, `:1298-1316`, `:1360`); twilio.ts (`:139-145`,
  `:315-341`, `:387-445`, `:618-658`, `:2665-2669`, `:2780-2906`, `:3077-3079`,
  `:3251`, `:3350-3370`, `:3422-3429`, `:3477-3479`); retrySend.ts (whole file);
  sendMessage.ts (`:210-212`, `:235-252`, `:287`, `:450-451`); api.ts
  (`:1592-1595`, `:1650-1652`); contactTimeline.ts (`:173-174`, `:442`);
  types.ts (`:2494-2495`); client.ts (`:118`); deliveryStatus.ts (`:778`,
  `:818`, `:863-876`, `:934`, `:990-1004`); relayRetryJoin.ts (`:89-94`,
  `:405-415`); Timeline.tsx (all 13 Task 17 anchors); e2e-session.mjs
  (`:272-273`); the five issue files' frontmatter.
- Helper and fixture availability for every new test: `seedSource`/`slotOf`
  signatures, `world.contacts`/`emitted`/`relaySidPointers`/`events`,
  `makeWebhookHarness({ env })`, `statusParams`/`TENANT_PHONE`/`ORIGIN_SECRET`,
  `makeFakes({ conversation, contact, env })` (merges overrides; `appended`,
  `sent`), `startFakeClock`/`spyOnIntervals`/`A_LONG_WHILE_MS`,
  `OutboundQueueAdapter` (one method), `EventBus.on`, `deliverDelayed` (shifts),
  the mirror-test import precedent, `MAX_PAGE_LIMIT` 100, the `{ messages }`
  route body, and no `exactOptionalPropertyTypes`.
- Semantics: `sentAt` survives the failure write (child-field SET,
  `messagesRepo.ts:3616-3645`); `ALLOWED_PRIOR` makes a message fail once
  (`:133-142`); the bounded acquire throws `TokenBucketBusyError` without
  sleeping when the deficit exceeds the bound (`tokenBucket.ts:173-196`), so
  Task 6's throwing-`sleep` test is sound; the fan-out is the only other
  `sendOneRelayLeg` caller and reads only `transient`/`sent`; the legacy close
  writes through `setRecipientDelivery` (`relayFanOut.ts:1599-1633`); the relay
  job is registered with the shared bucket (`registerHandlers.ts:60`); both e2e
  topologies boot through `scripts/e2e-session.mjs`; no other e2e spec arms a
  30003; fake-twilio's `date_created` is real time; the missing-conversation
  WARN matches today (`ConversationNotFoundError` is a `SendRefusedError`); the
  one-to-one default `ai_mode` is `auto` in repo and harness; no seed or dev
  seam writes delivery status or retry rows; the only `delivery_status` writers
  are the ones Task 2 lists; `closeRetryLegEnqueueFailed` has no other
  reference; the TDD red states in Tasks 2-18 fail (or pin) as each step says.
- UNVERIFIED (not runnable here): the gate-5 expectation of exactly one
  pre-existing lint error (`Timeline.tsx` `react-hooks/set-state-in-effect`);
  Task 21's baseline-attribution procedure protects the verdict either way.
