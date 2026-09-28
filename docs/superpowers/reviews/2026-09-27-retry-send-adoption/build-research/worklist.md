# Build worklist - retry-send adoption (the orchestrator's merge of the delta research)

Orchestrator: the build-orchestrator for `feat/retry-send-adoption`
(worktree `W:\tmp\retry-send-adoption`), 2026-09-28. Inputs: plan revision 4
(`docs/superpowers/plans/2026-09-27-retry-send-adoption.md`), spec revision 5,
the planner's research maps (`../research/reader-{a,b,c}-*.md`), and this
phase's two delta readers:

- `compile-drift-findings.md` (reader D: every name, signature and anchor the
  plan's sketches call, against the live tree)
- `invariant-sweep-findings.md` (reader E: who else reads or writes the state
  this branch moves - the whole app, not the plan's files)

Drift check: the branch's code is byte-identical to `main@3dbb5740` (the tree
the planner's readers mapped); `main` has not moved. Every correction below is
ADJUDICATED - ACCEPT unless marked otherwise - and BINDS the implementer of the
task it names. Where this sheet and the plan disagree, this sheet wins; where
it is silent, the plan stands. File:line citations are at 3dbb5740; re-derive
by reading before editing.

## T1 (slice S1)

1. (D F1.1, ACCEPT) The fake `listRetryChildrenConsistent` returns its entries
   SORTED by `tsMsgId` in UTF-8 byte order (reuse the harness's `utf8Order`,
   `twilioWebhookHarness.ts:4412`) - the real Query returns sort-key order and
   the parity runner compares every step's answer with `toStrictEqual`
   (`twilioWebhookHarnessRepoAdditions.integration.test.ts:836`).
2. (D F1.2, F1.3, ACCEPT) Imports the sketches need:
   `messagesRepoRetryLineage.integration.test.ts` gains `type MessageItem`,
   `retryChildPk`, `RETRY_PROMISE_WITHDRAWN_AT`, `vi` and `QueryCommand` (or a
   `constructor.name` match) for the single-Query case; `retrySend.ts` gains
   `type MessageItem` in its messagesRepo import (`planRetryMedia`);
   `retryChain.ts` imports `type MessageItem` and `type ConversationItem`.
   `NewMessage.retryWindowStart` is at `messagesRepo.ts:747` (plan :754).
3. (E F2, ACCEPT) Three doc comments now contradict the data (share-retry rows
   are one-to-one rows that carry `broadcast_id`): reword in ASCII
   `sendMessage.ts:329-334` (the block carries U+2014 and arrows - every
   touched line ASCII), `messagesRepo.ts:722-725` and `:1127-1130`. The fenced
   `twilio.ts:3520-3528` comment is NOT edited (fence) - the handback names it.

## T2 + T3 (slice S2)

4. (D F2.1, ACCEPT) The typecheck expectation after T2 Step 2 cannot hold (a
   `never` default, or `adopt`'s TS2366, is red until the arm exists). Implement
   Steps 2 and 4 together (or stub each new arm with a throw in between); the
   gate is `npm run typecheck` -> 0 at the END of Step 4, before the commit.
5. (D F2.2, ACCEPT) Test 10: `await seedOneToOne();` - the destructured
   `conversation` is unused, and `no-unused-vars` is an ERROR outside `^_`
   names (`eslint.config.mjs:32-40`): gate 5 would report it.
6. (D F2.3, ACCEPT) `sendReconcile.ts` needs these imports beyond the two the
   plan names: `contactHoldsPhone`, `isDeleted` (contactsRepo);
   `mediaAttachmentsOf` (messagesRepo); `oneToOneRetryWindowOrigin`,
   `parseRetryWindowOrigin`, `retryFitsSendWindow`, `RETRY_JOB_GRACE_MS`,
   `RETRY_PROMISE_GRACE_MS`, `RETRY_WINDOW_CLOSED_CODE`,
   `MAX_SEND_RETRY_ATTEMPTS` (ALL from `../lib/retrySendWindow.js` - the leaf,
   never `./retrySend.js`, for the constant); `enqueueSendRetry`
   (`./retrySend.js`, used ONLY inside functions - the import-cycle rule,
   `sendReconcile.ts:43-47`); `retryRecipientKey`, `automaticAncestry`
   (`../services/retryChain.js`); `refreshRetryPromise`,
   `withdrawRetryPromise` (`../services/retryPromiseWrites.js`).
7. (D F2.4, anchors) `Resolved` is `sendReconcile.ts:260-278`; `lookup` starts
   at :765; `isDeleted` is `contactsRepo.ts:324`; `sendReconcile.test.ts`
   imports `isBroadcastRowFor` at :29; `recordJobs` is
   `sendReconcile.test.ts:116-122`.
8. (D F2.5, ACCEPT) Test 12c's redriveCount-1 record: copy case 20's form
   (`sendReconcile.test.ts:1464-1475`: `reconciling(..., {at: now-120s})` +
   `markRedriven` + `claim` (attemptNo 2, redriveCount 1) + `takeOver`).
9. (D F2.6, ACCEPT) `sendReconcile.test.ts` must import `RETRY_SEND_JOB`,
   `RETRY_JOB_GRACE_MS`, `RETRY_PROMISE_GRACE_MS`, `RETRY_PROMISE_WITHDRAWN_AT`
   and `type NewMessage`.
10. (E F3, ACCEPT - small, log-only) `heldBy`'s `other` holder label
    (`sendReconcile.ts:604-610`) must not name a share-RETRY row as the share's
    own row: label `broadcast#...` only when the row has `broadcast_id` AND no
    `retry_of`; a row with `retry_of` gets the `message#<conversationId>#<tsMsgId>`
    label. Pin it in the `isBroadcastRowFor` / heldBy test block.
11. (E F5, test note) The harness's `getByProviderSid*` / `getByTsMsgId*`
    return the LIVE stored object (`twilioWebhookHarness.ts:1311-1320`,
    `:1453-1460`): a case that claims a LOST conditional write must use a stale
    copy or a spy, never the live row.

## T4 (slice S3)

12. (D F4.1, ACCEPT) Test 4c's "never a thread scan": spy BOTH
    `listByConversation` and `listByConversationConsistent` (the fake's
    consistent read delegates through the eventual one,
    `twilioWebhookHarness.ts:1450-1452`); both not called.
13. (D F4.2, ACCEPT) `providerCalls()` creates a NEW spy per call: bind
    `const calls = providerCalls();` BEFORE `run` and AFTER any
    `sendPreparedMessage` override; never read a fresh spy after the run.
14. (D F4.3, ACCEPT) `defineJobHandler` throws on a second registration for a
    name (`jobs.ts:199-204`): within ONE `it`, register the job once and use
    EITHER `recordJobs(SEND_RECONCILE_JOB)` OR `registerReconcile()`, never
    both; reset the registry between `it`s as `sendReconcile.test.ts` does.
15. (D F4.4, ACCEPT) `twilioStatusWebhook.test.ts` has ONE `expect(calls).toEqual(`
    (:1706-1716), not two; `wireJobs` is :1542; the marker cases are
    :1437-1476 and :1478-1505; `retryDeps` needs `type RetrySendJobDeps` in the
    retrySend import (:19-26); `vi` joins the vitest import (:6).
16. (D F4.5, ACCEPT) Test 4-redriven's seed: the `seedRedriven` recipe
    (`relayRetryLeg.test.ts:1411-1416`, claim + handToReconcile +
    markRedriven), not sendReconcile.test.ts case 15b.
17. (D F4.6, ACCEPT) `retrySendAttempt.test.ts` imports `TENANT_PHONE`
    ('+15550100001'), `OUR_NUMBER`, `ORIGIN_SECRET` from
    `./helpers/twilioWebhookHarness.js` (:218-222).

## T5 (slice S4)

18. (D F5.1, ACCEPT) The `makeRetryApp` stub sits in `{...} as unknown as
    MessagesRepo` (`apiRoutes.test.ts:453-457`): annotate every new parameter,
    `getByTsMsgIdConsistent: async (_c: string, id: string) => ...` (TS7006
    otherwise).
19. (D F5.2, ACCEPT) `apiRoutes.test.ts` imports `type FakeWorld`,
    `type RetryChildPointer`, `type MessageItem`, `type ConversationItem`,
    `RETRY_SEND_WINDOW_MS` as the new factory and cases need them.

## T6 (slice S4)

20. (D F6.1, ACCEPT) `dashboard/src/api/types.ts` is ALSO compiled by the APP
    typecheck (`app/test/contactTimeline.test.ts:39`, NodeNext). It has no
    imports today; if T6 adds one, write it `import type { ... } from
    '../routes/contact/retryPromise.js'` (the dashboard's `.js` convention) -
    an extensionless specifier fails the app typecheck (TS2835). Both
    `npm run typecheck` workspaces must be green.

## T7 (slice S4)

21. (D F7.1, ACCEPT) The new rollup case goes beside the existing
    `it('broadcast rollup: ...')` cases (`twilioStatusWebhook.test.ts:244-360`,
    inside the transitions describe at :89), passing
    `statusUnknownSidRetryDelayMs` small as the neighbour at :244 does; no
    existing test matches the give-up string.

## T8 (slice S5)

22. (D F8.1, ACCEPT) `GET /api/conversations/:id/messages` answers
    `{ messages }` (not `items`), newest first; `POST /api/contacts/:id/conversation`
    answers 200 `{ conversation }`; `POST /api/conversations/:id/messages`
    with `{ body }` answers 201 with `{ conversationId, providerSid, tsMsgId,
    status }` and passes NO recipient - every e2e attempt is PHONE-keyed (the
    reconcile envelope carries `phonehash#...`).
23. (D F8.2, ACCEPT) `StoredMessage` is `one-to-one-30003-retry.spec.ts:87-99`;
    `storedRows` hard-codes Tasha's thread - reuse its parse, not the helper;
    define `stamp` (SOR's `send-outcome-reconcile.spec.ts:368` idiom) and
    `BODY_18` / `BODY_19` beside `BODY_17`.

## T9 and the handback (orchestrator-owned lines; no code)

24. (E F1) Deploy boundary: a `messaging.retrySend` job that threw within
    ~10 minutes BEFORE the deploy (SQS 120 s visibility x 5 receives) is
    redelivered to the new code, which no longer reads the run-once marker and
    finds no attempt record - it claims and sends. For an unknown or
    accepted-not-recorded first attempt that is a possible (resp. certain)
    second text. The orchestrator first ruled "deploy note, no code belt";
    the PLANNER OVERRULED (2026-09-28, relayed mid-build): **ACCEPT WITH THE
    BELT, and keep the deploy note** - small and contained is Cameron's test
    for keeping a double-text fix, and a deploy precondition is what a Friday
    deploy forgets. BINDING for T4:
    - ONLY on the path where step 4's `gateFor` returns `{ kind: 'proceed' }`
      with NO record (absent - never on done/retryable, never on redriven),
      read `messagesRepo.getJobExecutionMarker(jobId)` with
      `jobId = getContext()?.jobId` (the `getContext` import therefore STAYS;
      skip the read when there is no jobId). A marker present means this exact
      jobId already ran under the pre-adoption code: INFO
      `retrySend: pre-adoption delivery already ran this job - not re-sent`
      with `jobId` and the owner context, return - nothing claimed, nothing
      sent. No marker (every post-deploy job; every re-drive and deferral,
      which carry fresh jobIds) -> proceed to 4a exactly as planned.
    - The job NEVER writes a marker (test 6d's `putJobExecutionMarker`
      never-called pin stands). Reading the helper is not an edit of the
      fenced helper. `getJobExecutionMarker` (`messagesRepo.ts:3481-3486`) is
      an EVENTUALLY consistent Get - sufficient here (the marker was written
      at least one 120 s visibility timeout before any redelivery); the
      helper is NOT changed (inboundEmail relies on it).
    - Tests in `retrySendAttempt.test.ts`: (a) seed
      `world.jobExecutionMarkers.set(<the envelope's jobId>, conversationId)`
      and dispatch that envelope directly (build it so its jobId is known - the
      old EXECUTION GUARD case's recipe in `twilioStatusWebhook.test.ts`) ->
      provider calls 0, no record, ONE INFO with that msg and the jobId;
      (b) a done/retryable record AND a marker for the envelope's jobId -> the
      belt is NOT consulted (a `getJobExecutionMarker` spy is not called), the
      job runs and sends.
    - Handback: declared as DEVIATION 10 ("a read-only marker belt for
      pre-deploy redeliveries; the marker is never written by this job"). T9
      keeps the dated deploy note in `retry-send-lost-under-job-marker` as
      belt-and-braces.
25. (E F4, deploy note) Rollback hazard: pre-branch code cannot read a
    `retry_send` owner (`recipientKeyOf` -> undefined -> `hashRecipientKey`
    throws; `parseOwnerRef` throws), so a rollback while fresh `retry_send`
    index items exist breaks OTHER owners' reconciles to that recipient for
    ~5 minutes and strands open retry records. Handback: drain
    `send.reconcile` before a rollback.
26. (E F5, handback text) R3's "the only competing writer is this owner's own
    earlier refresh" is imprecise: also the reconcile's re-drive REFRESH vs the
    immediately dispatched re-driven job, and a takeover hand-off vs the job's
    own REFRESH. Every interleaving resolves (WITHDRAW retried once wins; a
    losing REFRESH is dropped). Staff-visible residues inside the accepted
    wontfix class: a late re-drive REFRESH can re-promise "will retry" for up
    to ~5 min on an ended chain; after a `redrive_refused` / re-drive
    `enqueue_failed` close Retry stays hidden until the promise expires (the
    route allows it at once); a stale-tab press after a success answers
    `retry_pending` (RSW's time guard) before `superseded`.
27. (E, handback wording) A share ROOT row (a one-to-one text with
    `broadcast_id`) CAN carry `retry_outcome` (attempt 1 unresolved) - do not
    repeat R5's "never on broadcast rows". A retry row appended before the
    deploy carries no `broadcast_id`: a chain straddling the deploy loses
    share attribution from that row on (note in
    `broadcast-30003-retry-never-updates-slot`).

## Settled by the sweep (no action)

- No wholesale writer of an existing message row exists; `retry_outcome` /
  `retry_root` cannot be dropped (E item 3).
- The `retrychild#` family is invisible to every existing reader; resets and
  wipes delete it; no central pointer-prefix list exists (E item 2).
- The only behavior-changing readers of a message row's `broadcast_id` are
  the rollup gate (`twilio.ts:3529`, R7's stated cost) and `isBroadcastRowFor`
  (deviation 7) (E item 1).
- The three full `MessagesRepo` literals are exactly the plan's; every owner-
  kind branch is in reader B's table or T2's Files; every importer of the
  moved constant resolves through the re-export (D items 1-3).
