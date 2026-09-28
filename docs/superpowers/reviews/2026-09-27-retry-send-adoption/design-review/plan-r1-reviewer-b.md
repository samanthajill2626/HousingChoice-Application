# Plan review R1 - reviewer B (adversarial, plan-blind to the brainstorm)

Plan: `docs/superpowers/plans/2026-09-27-retry-send-adoption.md` (revision 1).
Spec: `docs/superpowers/specs/2026-09-27-retry-send-adoption-design.md` (revision 5) on SOR rev 12.
Repo read at main@3dbb5740 (worktree HEAD 38526a44, code identical). Read-only; no test run.

## Verdict in one paragraph

The design the plan builds is behaviorally sound: I walked every spec decision
(section 0, Q1/Q2, Branch B's requirement, the wontfix, R1-R12, section 4 items
1-19, section 5) to a task and found no spec decision that is undelivered or
delivered wrong in the PRODUCTION code the plan writes. What is wrong is plan
fidelity: a builder executing it literally hits red gates at T1 (typecheck), T4
and T5 (existing exact-match assertions the plan says stay unchanged), and
writes three test sketches that contradict the plan's own implementation - one
of which (T2 12a) invites the builder to bend correct code into a stranding
behavior. The concurrent-duplicate guard, the one guarantee that justifies
removing the run-once marker, has no test at all. No finding is BLOCKING; five
are MEDIUM.

## The seven declared deviations, judged

1. R6 reads one record (`(retry_attempt ?? 0) + 1`), not three - LEGITIMATE. The
   webhook schedules exactly that attempt number against a row
   (`oneToOneRetryDecision.ts:125-129`); deferral and re-drive reuse it. Same
   answer.
2. Adapter kill switch -> `done/refused` WARN - LEGITIMATE clarification. The
   adapter class (`messagingErrors.ts:19`) is not a SendRefusedError and
   classifies `rejected` (`sendOutcome.ts:95`); the wrapper's twin
   (`sendMessage.ts:107`, thrown at `:460-463`) is the refusal the spec names.
   The adapter path is a backstop that is unreachable unless the two configs
   disagree.
3. Consistent read of the retried row - LEGITIMATE tightening (the R3 condition's
   `expect` comes from it; `getByProviderSidConsistent` exists, `messagesRepo.ts:1327`).
4. ASCII re-word of the fenced line - NOT ACTUALLY A DEVIATION: the spec already
   quotes the ASCII string (spec R7, line 525); source has U+2014 (`twilio.ts:3904`).
5. WITHDRAW keyed in `closeSlot` on the code - LEGITIMATE, observably identical
   (`slotCloseOf` takes no owner, `sendReconcile.ts:922`; `closeUnresolved`
   and the superseded exit both route through `closeSlot`, `:417`, `:1022`).
6. "Every fenced write captures the fence answer" - LEGITIMATE intent, but the
   plan's own code does not do it (finding 9).
7. `isBroadcastRowFor` ignores `retry_of` rows - CHANGES WHAT GETS BUILT (a
   `broadcastFanOut.ts` edit the spec's section 2 "In" list does not name; the
   spec asked only that the handback STATE the behavior). Judged legitimate:
   it enforces the spec's "1b writes nothing to the share slot" (section 0) at
   both callers (`sendReconcile.ts:597`, `broadcastFanOut.ts:1387`). As far as
   I can trace it is unreachable today (a share-retry row exists only after the
   root row was recorded, by which point that recipient's broadcast record is
   terminal and never reconciles again), so it is defensive, not corrective.
   Keep it; the handback must say it is a code change, not just a description.

Undeclared deviations found: finding 10 (spec item 15's "31 s" stale case) and
the adoption's media rule (attachments only when the record's `mediaCount > 0`,
plan T2 `adoptRetry`) which narrows spec R4's "its `media_attachments`" - the
narrowing is correct (it mirrors what the job would have sent) but should be
listed.

## Findings

### 1. [MEDIUM] T1 breaks `npm run typecheck`: two uncast `MessagesRepo` literals are not in T1's file list

What: T1 adds two REQUIRED members (`listRetryChildrenConsistent`,
`annotateRetryPromise`) to the `MessagesRepo` interface. Two test files declare
full, uncast object literals of that type:
`app/test/sendMessage.test.ts:256` (`const messagesRepo: MessagesRepo = {`,
closes `:350`) and `app/test/scheduledSendSuppression.test.ts:273` (closes
`:365`). The app's typecheck includes tests
(`app/package.json:13` runs `tsc -p tsconfig.test.json`, whose `include` is
`["test", "src", ...]`).

Implies: T1 Step 9's "`npm run typecheck` -> 0" is false as written; the
checkpoint commit's explicit `git add` list omits the two files a builder must
touch to go green. This is exactly the "unenumerated surface" class.

Fix: add both files to T1's Files and `git add`, each gaining the two methods
as throwing or trivial stubs.

### 2. [MEDIUM] "Unchanged assertions" is false in two suites: exact `toEqual` pins on the send input go red

What:
- T4 Step 1 says "Every other site: unchanged assertions." But
  `app/test/twilioStatusWebhook.test.ts:1706-1716` asserts
  `expect(calls).toEqual([{ conversationId, body, automated: true, author,
  retryOf, retryAttempt: 1, retryWindowStart }])` on the spy's captured
  `SendMessageInput`. After T4 the job passes `retryRoot` AND a
  `beforeProviderSend` function (plan T4 handler, step 7), so the exact match
  fails on two extra defined keys.
- T5 Step 2 says only "The existing `re-sends ... retry_of` case (`:475`) gains
  `retryRoot`". `app/test/apiRoutes.test.ts:614-623` (the D14 recorded-recipient
  case) is a second exact `toEqual` on `calls` and gains `retryRoot` too.

Implies: two red suites at checkpoints the plan says are green; a literal
builder either weakens the pins or stalls.

Fix: name both sites. For `:1706`, assert with `toMatchObject` plus an explicit
`retryRoot: seeded.tsMsgId` and `typeof calls[0].beforeProviderSend ===
'function'`; for `:614`, add `retryRoot: '2026-06-12T09:00:00.000Z#SMorig'`.

### 3. [MEDIUM] The rewritten DUPLICATE GUARD case asserts a log line the plan's own handler never emits

What: T4 Step 1 rewrites `twilioStatusWebhook.test.ts:1435-1474`: the second
sequential dispatch must produce "a `claim refused` INFO line [carrying]
`fresh: false` (the record is `done/sent` - terminal)". But the plan's handler
runs `gateFor` at step 4 first; for `done` with outcome `sent`, `gateFor`
returns `{ kind: 'skip' }` (`sendAttemptGate.ts:33`) and the handler logs
`'retrySend: this attempt is already resolved'` with `gate: 'skip'` and returns
- the claim (and its `fresh` field) is never reached. The same confusion
appears in the new file's 4a sketch ("then run again ... -> claim refused").

Implies: red against the plan's own code. A literal builder may "fix" it by
dropping the gate's skip branch, which is harmless (the claim also refuses) but
moves the implementation away from the spec's step-4 ordering.

Fix: assert the gate's skip line (`msg === 'retrySend: this attempt is already
resolved'`, `gate: 'skip'`), and keep `world.sent` at 1 and
`jobExecutionMarkers.size` 0.

### 4. [MEDIUM] The concurrent-duplicate guard - the reason the marker can go - is untested

What: Spec section 1 guarantee 1 and R2 ("the claim ... also stops a concurrent
retry with a different `jobId`") and spec item 6(a) ("the second claim is
refused fresh") rest on two branches: `gateFor` -> `defer` for a FRESH
`attempting` record (`sendAttemptGate.ts:38`) and `claim` -> `refused, fresh:
true` for a concurrent winner (`sendAttemptsRepo.ts:432,438,443`). The plan's
Review Focus 1 says "one that arrives AFTER a claim is refused fresh (Task 4,
tests 6a and 9)". Test 6a is sequential (finding 3: the gate skips a terminal
record); test 9 is pre-claim. No case seeds a fresh `attempting` record, and
none dispatches a second delivery while the first is inside its provider call.

Implies: a regression in either branch (e.g. `if (claim.outcome === 'refused'
&& !claim.fresh) return;` letting a fresh refusal fall through to the send)
ships green. That is a double text on the exact path the marker used to guard.

Fix: add two cases to `retrySendAttempt.test.ts`: (a) the gate: seed
`claim(ownerOf(row, 1), facts, now - 5 s)` directly and run -> `world.sent` 0,
INFO "a concurrent delivery owns this attempt", record untouched; (b) the claim
race: the same seed plus `vi.spyOn(world.sendAttemptsRepo,
'get').mockResolvedValueOnce(undefined)` so the run passes the gate as if it
read before the other delivery claimed -> `claim` returns `refused, fresh:
true`, one INFO carrying `fresh: true`, `world.sent` 0.

### 5. [MEDIUM] T2 test 12a contradicts T2's `resolve` - and invites bending correct code into a strand

What: 12a's second half: "participant_phone deleted -> resolve returns
undefined -> INFO 'owner recipient not found', record untouched". The file's
default `seedRow` fixture carries `recipientContactId: 'c-retry'`, and the
plan's `resolve` derives the key with `retryRecipientKey(row, conversation)`,
which returns the row's contact id without consulting the phone (plan T1
`retryChain.ts`). So `resolve` succeeds; `currentPhone` returns undefined; the
lookup returns `unresolved digest_mismatch` (`sendReconcile.ts:769-771`) and
the WITHDRAW runs. The sketch's expected outcome only holds for a PHONE-keyed
row. (The test is also mislabeled "Review Focus 5", which is about redriven
records.)

Implies: red against correct code. The spec is clear that the plan's code is
right (R1: unaddressable only when the re-derived key's hash mismatches; R4: a
changed number is `digest_mismatch`). A builder who "fixes" `resolve` to return
undefined when `participant_phone` is absent would leave the record
`reconciling` for the sweeper and the retried row promising "will retry" until
it expires, instead of closing it `unresolved` and withdrawing.

Fix: split 12a: contact-keyed row with the phone removed -> `unresolved
digest_mismatch` + WITHDRAW; phone-keyed row (no `recipient_contact_id`) with
the phone removed -> `resolve` undefined, INFO, record still `reconciling`.

### 6. [LOW] The MAX_SEND_RETRY_ATTEMPTS move as written leaves retrySend.ts without a local binding

What: T1 Step 1 replaces `export const MAX_SEND_RETRY_ATTEMPTS = 3;`
(`retrySend.ts:51`) with `export { MAX_SEND_RETRY_ATTEMPTS } from
'../lib/retrySendWindow.js';`. An `export ... from` re-export creates no local
binding; `parseRetrySendPayload` still reads the name at `retrySend.ts:80-81`
-> TS2304. The re-export itself is right for `oneToOneRetryDecision.ts:43`
(fenced) and the tests that import it from `jobs/retrySend.js`.

Fix: add `MAX_SEND_RETRY_ATTEMPTS` to the existing
`import { ... } from '../lib/retrySendWindow.js'` (`retrySend.ts:33-37`) and
`export { MAX_SEND_RETRY_ATTEMPTS };`.

### 7. [LOW] T8's `pollRow` reads an authenticated route with the unauthenticated `request` fixture

What: tests 17-19 call `pollRow(request, conversationId, ...)`, defined as
polling `GET /api/conversations/:id/messages?limit=100`. The Playwright
`request` fixture carries no session (no `storageState` in
`e2e/playwright.config.ts`); SOR's spec uses `page.request` after `devLogin`
for every app API call (`send-outcome-reconcile.spec.ts:369-379`), and the
one-to-one spec reads stored rows through `page.request`
(`one-to-one-30003-retry.spec.ts:104-110`).

Fix: `pollRow(page.request, ...)`; keep `request` only for the fake
(`setDeliveryOutcome`, `failNextSend`, `failList`, `getOutboundTo`) and the
logtail.

### 8. [LOW] Test-sketch fixtures that cannot hold

- T2 hard-codes `RETRY_CONV = 'conv-retry-1'` for the pointer query (test 10)
  and the expected re-drive envelope (test 11), but `seedOneToOne` uses
  `createOrGetByParticipantPhone`, which mints `conv-<n>`
  (`twilioWebhookHarness.ts:600-615`). Use `conversation.conversationId`.
- The R9 case ("every captured line with `conversationId` has
  retryRoot/retriedTsMsgId/attempt") cannot pass: the logger mixin injects the
  whole correlation context into every line (`logger.ts:245-250`), and
  `sendMessage` merges `conversationId` into it (`sendMessage.ts:450`,
  `context.ts:67-70`), so jobs.ts's own lines (`'job enqueued (SQS)'`,
  `'job succeeded'`, `jobs.ts:125-127, 323-328`) carry `conversationId` without
  a `retryRoot`. Scope the assertion to `msg` starting `retrySend:` (and to
  `event: 'send_reconcile'` for the reconcile).
- `withdrawRetryPromise`'s "a row already withdrawn -> 'already', no write,
  annotate called once" only holds if the test passes a STALE row: with the
  stored (current) row the first conditional write matches the sentinel and
  returns `'written'` with an emit. Say so in the sketch.

### 9. [LOW] Deviation 6 is not followed by the plan's own arms

What: the header says every fenced write "captures the fence answer inside the
callback and logs the loss itself". The plan's `refuse`, the rejected arm, and
all three `finishAttempt` calls in `deferOrEnd` pass
`() => attempts.finishAttempt(...)` straight to `guardWrite`, which returns
`true` for a resolved write whose fence LOST (`guardWrite.ts:8-10`). A lost
`finishAttempt(retryable)` after the deferral enqueue is silent.

Fix: either capture the boolean in those arms (the `handToReconcile` idiom the
plan already uses) or narrow deviation 6's wording to the arms that do.

### 10. [LOW] Undeclared deviation: spec item 15's "200 on a stale attempting (31 s)"

What: spec R6 defines "stale" as older than `RETRY_SEND_WINDOW_MS` for every
open state; spec section 4 item 15 still says "200 on a stale `attempting`
(31 s)" (a leftover of the claim-TTL bound round 3 replaced). Under R6 a 31 s
`attempting` record is open and fresh -> 409 `retry_pending`. The plan's T5
case silently uses `RETRY_SEND_WINDOW_MS + 1 s`. Right choice, but it is an
eighth deviation from the approved text.

Fix: declare it in the header and the handback.

### 11. [LOW] "Enforced by the record, for good" is false under the record's TTL

What: spec R6 says the Q1 refusal is "enforced by the record, for good", and
item 15 asks for a 45-day-old `done/unresolved` record to still refuse. The
record's `expires_at` is set only at claim and re-arm (`sendAttemptsRepo.ts:258`,
`:290`, `:394-399`) to +30 days (`SEND_ATTEMPT_CLEANUP_MS`, `:48`), and TTL is its
only reaper (`tables.ts:232-236`). After ~30 days only the row's
`retry_outcome` belt remains, and that write is best-effort. The plan's 45-day
test passes only because neither the fake nor DynamoDB Local reaps.

Implies: a retried row whose WITHDRAW was lost becomes manually retryable after
~30 days. Spec-inherited; not a build defect.

Fix: T9 should record it as a residue (in `send-attempt-sweeper` or a new
issue), and the test name should not claim "no time bound".

### 12. [LOW] Pre-gate declines strand a `redriven` record

What: R2 steps 1 and 3 (retried row missing or not outbound; conversation
missing, not one-to-one, or phone-less) return before the step-4 record read,
so a RE-DRIVEN job that declines there leaves its record `redriven` - the
state SOR D8 rev 11 says must be closed "else it strands" - and R6 then answers
`retry_pending` for up to 15 minutes. The spec only names 4a/4b; the plan
follows the spec. Practically unreachable (the reconcile just read the row and
the thread), so LOW.

Fix: none required; name it in `send-attempt-sweeper`'s strand cases (T9).

### 13. [LOW] E2E run commands depart from the sanctioned forms

What: T8 Step 2 drives the new spec with `cd e2e; npx playwright test
tests/...`. The sanctioned single-spec form is `npm run e2e -- <spec path>`
(e2e README "Helpers" and the maintenance-page example); AGENTS.md: "Run
Playwright only through the e2e workspace (`npm run e2e`)". Separately, the
gate is `timeout 1500 npm run e2e` in Git Bash on Windows with no recovery
step: if `timeout` fires it signals `npm`, not the Playwright/stack tree, and
AGENTS.md warns an orphaned same-commit stack is adopted by the next run.

Fix: use `npm run e2e -- tests/dashboard-next/retry-send-adoption.spec.ts`;
after any timeout, `npm run e2e:stop` and prove the lane's ports free before
re-running.

### 14. [LOW] Placeholders and cross-references despite the "self-contained" claim

- `adoptRetry`'s touch block is `... copy adoptBroadcastRecipient's touch block
  ...` and the emit that follows reads an undeclared `touched`.
- Sketches name `appendOutbound`, `T0`/`T1`, `DUE_1`/`DUE_2`, `outboundRow`,
  `iso` that exist in no cited file (`messagesRepoRetryLineage.integration.test.ts`
  has only the RELAY `retryRow` builder, which stamps `relayRetry*` fields -
  unusable for a one-to-one row); `vi` is not imported in
  `twilioStatusWebhook.test.ts:6` though the rewritten case uses `vi.spyOn`;
  `toConversationUpdatedEvent` is not imported in `sendReconcile.ts`.
- Test labels drift from the spec's: the plan's T4 4d/4e/4f/4g are the spec's
  4b/4c/4d/4e, while Review Focus 4 and 5 cite "test 4b" and "tests 4c and 4d".

### 15. [LOW] `conversationRetryDecline` does not reuse the decision's vocabulary

What: spec R2 step 3 says the decline "reuses [the webhook decision's]
vocabulary" (`'conversation_missing' | 'group_text' | 'not_one_to_one'`,
`oneToOneRetryDecision.ts:54-60`). The plan invents `no_participant_phone` and
folds `group_text` into `not_one_to_one`.

Fix: return the decision's three reasons (a phone-less one-to-one is
`not_one_to_one` there, `oneToOneRetryDecision.ts:95-97`).

### 16. [LOW] T9 misstates the pre-deploy pointer gap for the route

What: T9's residue note says pre-deploy children escape "step 4a and the route
... for the 15 minutes a chain can straddle the deploy". For step 4a that is
right (the window bounds it). For the route's `superseded` check it is
permanent: a pre-deploy parent with a pre-deploy child has no `retrychild#`
item ever. Harmless (the route then behaves as it does today), but the note
should say so.

## Verified and holding (no finding)

- Test 1 is red before T4: the pre-T4 job ignores the new deps, rethrows the
  unknown (`retrySend.ts:329-340`), the in-process immediate dispatch swallows
  it, and `sendAttemptsRepo.get(...)` is undefined.
- Test 4's `delaySeconds` pin holds: `enqueue` computes
  `ceil((runAt - now())/1000)` (`jobs.ts:112-114`) with `now` reset to
  `Date.now` by `_resetForTests`; runAt is job-now + 60000 on the wall clock.
- Hop budget: the plan adds no self-enqueue beyond the spec's count
  (`jobs.ts:166-171`; the re-drive at hop 11 is impossible because a second
  never_sent closes `second_unknown`, `sendReconcile.ts:1182-1186`).
- Import cycle: nothing in `sendReconcile.ts` or the fan-out modules reads a
  `retrySend.ts` binding at evaluation time, and none of them imports
  `twilio.ts` or `oneToOneRetryDecision.ts`; the moved constant resolves
  through the import-free leaf.
- Every writer of `retry_due_at` enumerated: `updateDeliveryStatus` (only on a
  status transition; the retried row is terminal, `messagesRepo.ts:133-142`),
  the webhook's enqueue-failure `annotateMessage` (before the job can run), the
  job's REFRESH/WITHDRAW and the reconcile's REFRESH/WITHDRAW (all
  conditional). No wholesale Put rewrites an existing message row
  (`messagesRepo.ts` Puts are pointer families; `dev.ts:1049` plants fixtures).
- `retrychild#` writers: only `append` callers with `retryOf` (sendMessage for
  the job and the route, the new adoption); seeds, the importer and dev seams
  write no `retry_of` (grep of `app/src/lib/seed`, `app/src/lib/import`,
  `scripts`, `e2e/fixtures`). No DynamoDB stream consumer exists to misread the
  new partition.
- Owner-kind dispatch outside `sendReconcile.ts`: only
  `sendAttemptsRepo.ts:153,164`, the harness `:4409`, and the three test
  ternaries - all in T2's list.
- The only Retry button renderer is `Timeline.tsx:1426` (via
  `ContactCommsPane.tsx:304-338`); the relay/tour/placement views pass no
  `onRetry`, so the hidden-Retry rule has no second reader.
