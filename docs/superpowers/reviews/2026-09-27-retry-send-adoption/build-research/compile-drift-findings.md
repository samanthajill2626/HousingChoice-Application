# Reader D - "still compiles" + anchor drift for plan Tasks 1-8 (findings)

Read-only check of the plan's code sketches (revision 4,
`docs/superpowers/plans/2026-09-27-retry-send-adoption.md`) against the live
tree at `feat/retry-send-adoption` (code = `main@3dbb5740`). Nothing was run.
Only discrepancies, corrections and additions are listed; what matched is
summarized in one line per checklist item at the end. Byte-exact quotes for
every citation are in the gitignored companion
`.superpowers/sdd/research/delta-compile-reference.md` (section ids `R-...`).
Severity: BLOCKING = a gate goes red as written; TRAP = runs but proves
nothing or costs a debug loop; ANCHOR = a cited line or recipe is elsewhere.

## T1

F1.1 (TRAP) Parity ordering of `listRetryChildrenConsistent`.
- Plan (T1 Step 4): the fake returns "a copy of the map entry" (insertion
  order); only `messagesAgree` sorts by tsMsgId.
- Live: the parity runner compares EVERY step's raw answer with
  `toStrictEqual` (twilioWebhookHarnessRepoAdditions.integration.test.ts:836),
  and the real Query returns the partition in sort-key (child tsMsgId) order.
  A `listRetryChildrenConsistent` step on the parent (automatic + manual
  child) diverges whenever append order differs from tsMsgId order (R-T1-1).
- Correction: have the fake return the entries sorted by tsMsgId in UTF-8
  byte order - the attempts fake already has `utf8Order`
  (twilioWebhookHarness.ts:4412) - or sort inside the step's `run`.

F1.2 (ANCHOR, small) Imports the Step 2 sketches need in
`messagesRepoRetryLineage.integration.test.ts` (imports at :9-17 are
`randomUUID`, vitest `afterAll/beforeAll/describe/expect/it`,
`createMessagesRepo`, `type NewMessage` only): add `type MessageItem`,
`retryChildPk`, `RETRY_PROMISE_WITHDRAWN_AT`, `vi` (the doc-client spy) and
`QueryCommand` (or match `constructor.name`) for the single-Query case (R-T1-2).

F1.3 (ANCHOR) `NewMessage.retryWindowStart` is at messagesRepo.ts:747, not
:754 (R-T1-3). `retrySend.ts` has no `MessageItem` import today;
`planRetryMedia`'s signature needs `type MessageItem` added to the
messagesRepo import (retrySend.ts:15-20). `retryChain.ts` needs
`type MessageItem` and `type ConversationItem` imports beside the
`MAX_SEND_RETRY_ATTEMPTS` one the sketch shows.

## T2

F2.1 (BLOCKING as written) Step 2's "`npm run typecheck` -> 0" cannot hold.
- Plan (T2 Step 2, line 455): after Step 2 (union, keys, ref, parser, logs,
  narrowings) "every switch now has its arm or its `never`"; the arms
  (`resolve`, `currentPhone`, `adopt`, `closeSlot`, `afterClose`,
  `enqueueRedrive`) are Step 4.
- Live: `adopt` (sendReconcile.ts:614) returns `Promise<Found | {kind:'other'}>`
  with no default, so a fourth kind without an arm is TS2366 even with no
  `never` default; and with the plan's `never` default (idiom as built at
  relayFanOut.ts:1432-1435) every switch lacking a `retry_send` arm is TS2322
  by design (R-T2-1).
- Correction: either stub the six arms in Step 2 (`case 'retry_send': throw
  new Error('retry_send: not yet')`, replaced in Step 4), or move the
  typecheck expectation from Step 2 to the end of Step 4. Step 1's parser /
  toOwnerRef tests still pass under vitest in between.

F2.2 (BLOCKING at gate 5) Test 10 sketch declares an unused binding.
- Plan (T2 Step 3, test 10): `const { conversation } = await seedOneToOne();`
  - `conversation` is never read in the test.
- Live: `@typescript-eslint/no-unused-vars` is an ERROR, exempting only
  `^_` names (eslint.config.mjs:32-40); `sendReconcile.test.ts` is a touched
  file, so gate 5 reports it as new (R-T2-2).
- Correction: `await seedOneToOne();` (as test 10c already does).

F2.3 (ANCHOR) New imports `sendReconcile.ts` needs are more than the two the
Interfaces line names (plan line 429: only `TRANSPORT_SCHEMA_VERSION` and
`toConversationUpdatedEvent`). Live imports (sendReconcile.ts:48-110) also
lack: `contactHoldsPhone`, `isDeleted` (the contactsRepo import at :73 has
only `createContactsRepo`, `ContactItem`, `ContactsRepo`); `mediaAttachmentsOf`
(messagesRepo import :81-87); `oneToOneRetryWindowOrigin`,
`parseRetryWindowOrigin`, `retryFitsSendWindow`, `RETRY_JOB_GRACE_MS`,
`RETRY_PROMISE_GRACE_MS`, `RETRY_WINDOW_CLOSED_CODE`, `MAX_SEND_RETRY_ATTEMPTS`
(none from lib/retrySendWindow today - import MAX from the leaf, not from
retrySend.js); `enqueueSendRetry` (./retrySend.js); `retryRecipientKey`,
`automaticAncestry` (services/retryChain.js); `refreshRetryPromise`,
`withdrawRetryPromise` (services/retryPromiseWrites.js) (R-T2-3).

F2.4 (ANCHOR) Line drift in T2/T3 Files: `Resolved` is sendReconcile.ts:260-278
(plan :298-315 is `Found`/`Verdict`/`Held`); `lookup` starts at :765 (plan
:751); `isDeleted` is contactsRepo.ts:324 (plan :319); sendReconcile.test.ts
imports `isBroadcastRowFor` at :29 (plan :19); `recordJobs` is
sendReconcile.test.ts:116-122 (T4 cites :199-205) (R-T2-4, R-T2-6b).

F2.5 (ANCHOR) Test 12c's "the file's case 20 recipe" is not "a fresh claim +
handToReconcile": case 20 (sendReconcile.test.ts:1464-1475) is
`reconciling(owner, facts, {at: now-120s})` + `markRedriven` + `claim` (answers
attemptNo 2, redriveCount 1) + `takeOver(owner, claimed.record)`. Either reaches
reconciling with redriveCount 1; copy the file's form (R-T2-5).

F2.6 (ANCHOR, small) Names the T2 sketches use that `sendReconcile.test.ts`
does not import today (imports :12-68): `RETRY_SEND_JOB` (test 11, 13),
`RETRY_JOB_GRACE_MS`, `RETRY_PROMISE_GRACE_MS`, `RETRY_PROMISE_WITHDRAWN_AT`
(tests 11, 12), `type NewMessage` (the `seedRow` helper; the messagesRepo
import has `buildTsMsgId`, `MessageItem`, `RelayRecipientDelivery` only). The
file-local `TENANT_PHONE` shadows nothing (the harness's TENANT_PHONE is not
imported here) (R-T2-6).

## T3

No drift beyond F2.4's `lookup` line. The sibling filter (:787-796) and the
`same_fingerprint_sibling` test (:903) are where the plan says; `lookup` is
already `async`, so the awaited `predecessorMatchers` fits before the filter.

## T4

F4.1 (TRAP) Test 4c's "never a thread scan" spy is half a spy.
- Plan (T4 test 4c): `vi.spyOn(world.messagesRepo, 'listByConversationConsistent')`
  and `expect(thread).not.toHaveBeenCalled()`.
- Live: the name exists (messagesRepo.ts:1474 / :3385), but the FAKE's
  consistent twin delegates THROUGH the eventual `listByConversation`
  (twilioWebhookHarness.ts:1450-1452), so a job that scanned with the EVENTUAL
  read would not trip this spy (R-T4-2).
- Correction: spy `listByConversation` (it observes both reads) or spy both.

F4.2 (TRAP) `providerCalls()` mints a NEW spy per call.
- Plan (helper) `const providerCalls = () => vi.spyOn(world.adapter,
  'sendPreparedMessage')`; the 4d/6a/6b/6e/6f/11 sketches read "run(row) ->
  providerCalls() 0" (6a: 1).
- Read literally (spy created after `run`), the count is 0 by construction.
- Correction: `const calls = providerCalls();` BEFORE `run` (as 4-cap does),
  and after any override assignment (the spy wraps the current property).

F4.3 (TRAP) `defineJobHandler` refuses a second registration for a name
(jobs.ts:199-204). Within ONE `it`: call `wire()` once, and use either
`recordJobs(SEND_RECONCILE_JOB)` or `registerReconcile()`, never both (4d's
two sub-cases and 11's two halves each share an `it`) (R-T4-3).

F4.4 (ANCHOR) twilioStatusWebhook.test.ts has exactly ONE
`expect(calls).toEqual(` (:1706-1716); T4 Step 1 says "Two exact toEqual
pins" - the second does not exist (the other exact pins are on `world.sent`,
which stay). `wireJobs` is at :1542 (plan :1544); the two marker cases are
:1437-1476 and :1478-1505 (plan :1435-1474 / :1476-1503); the must-not-annotate
case's annotateMessage override is at :1874-1876. `retryDeps` needs
`type RetrySendJobDeps` added to the retrySend import (:19-26); `vi` is absent
from the vitest import at :6 as the plan says (R-T4-4).

F4.5 (ANCHOR) 4-redriven's recipe citation: sendReconcile.test.ts case 15b
(:2382) does not seed a redriven record - it runs a chain to one. The
"claim + handToReconcile + markRedriven" helper exists verbatim as
`seedRedriven` in relayRetryLeg.test.ts:1411-1416 and relayFanOut.test.ts:1496-1501
(R-T4-1).

F4.6 (ANCHOR, small) retrySendAttempt.test.ts helpers use `TENANT_PHONE`
without defining it: import it (and `OUR_NUMBER`, `ORIGIN_SECRET`) from
`./helpers/twilioWebhookHarness.js` (exported at :218-222; TENANT_PHONE =
'+15550100001').

## T5

F5.1 (BLOCKING at typecheck) Unannotated params inside a cast-through-unknown
stub.
- Plan (T5 Step 1): the makeRetryApp messagesRepo stub gains
  `getByTsMsgIdConsistent: async (_c, id) => (...)`.
- Live: the stub is `{ ... } as unknown as MessagesRepo`
  (apiRoutes.test.ts:453-457); the inner literal's contextual type is
  `unknown`, so `_c` and `id` are implicit `any` - TS7006 under `strict`
  (tsconfig.test.json includes test/). The file's one stub that takes a
  parameter annotates it (`async append(input: {...})`, :366) (R-T5-1).
- Correction: `getByTsMsgIdConsistent: async (_c: string, id: string) => ...`.
  The zero-arg `listRetryChildrenConsistent` and conversations `getById`
  stubs are fine.

F5.2 (ANCHOR, small) apiRoutes.test.ts imports today (:1-26) lack what the
new factory/cases name: `type FakeWorld`, `type RetryChildPointer`,
`type MessageItem`, `type ConversationItem`, `RETRY_SEND_WINDOW_MS` (the
retrySendWindow import has only the two promise constants). `createFakeWorld`
is already imported. The 13 call sites and the two `expect(calls).toEqual(`
pins (:485, :614) are exactly as the plan says.

## T6

F6.1 (TRAP) `dashboard/src/api/types.ts` is also compiled by the APP
typecheck. `app/test/contactTimeline.test.ts:39` imports
`../../dashboard/src/api/types.js` under app/tsconfig.test.json (NodeNext).
types.ts has NO imports today. If T6 adds one (the plan's `RetryOutcome`
from `routes/contact/retryPromise`), write it `.js`-suffixed
(`'../routes/contact/retryPromise.js'`, the dashboard's own convention): an
extensionless specifier is legal under the dashboard's `bundler` resolution
but fails the app's NodeNext typecheck (TS2835). retryPromise.ts is
import-free, so pulling it into the app graph is safe; `import type` of the
const plus `typeof` is enough (R-T6-1).

## T7

F7.1 (ANCHOR) There is no "broadcast rollup describe" in
twilioStatusWebhook.test.ts. The rollup cases are `it('broadcast rollup: ...')`
inside `describe('POST /webhooks/twilio/status - transitions')` (:89), at
:244-360; the reload neighbour at :244 already passes
`statusUnknownSidRetryDelayMs: 5` and `makeWebhookHarness` returns `capture`
(used at :374). No test in the repo matches the give-up string today, so the
new case goes there (R-T7-1).

## T8

F8.1 (TRAP) Response shapes the new helpers must parse.
- `GET /api/conversations/:id/messages` answers `{ messages: MessageItem[] }`
  (field `messages`, not `items`), newest first (api.ts:2184-2210;
  ScanIndexForward false at messagesRepo.ts:2249) - `pollRow` must read
  `messages`, as `storedRows` does.
- `POST /api/contacts/:id/conversation` answers 200 `{ conversation }`
  (contacts.ts:1943-1961), not 201.
- `POST /api/conversations/:id/messages` with `{ body }` answers 201 with the
  SendMessageOutcome `{ conversationId, providerSid, tsMsgId, status }`
  (api.ts:1431-1467); it passes NO `recipient`, so the row has no
  `recipient_contact_id` and every T8 attempt is PHONE-keyed (the reconcile
  envelope carries `phonehash#...`).
(R-T8-1, R-T8-2, R-T8-3)

F8.2 (ANCHOR) `StoredMessage` is one-to-one-30003-retry.spec.ts:87-99 (plan
:42-56). `storedRows` hard-codes TASHA's conversation - reuse its parse, not the
helper. The sketches use `stamp` and `BODY_19` without defining them: copy
SOR's per-test `const stamp = \`${Date.now()}\`.slice(-6);`
(send-outcome-reconcile.spec.ts:368) and define `BODY_19` beside `BODY_17`
(R-T8-4, R-T8-5).

## Checked, no drift (one line per checklist item)

1. Full uncast `MessagesRepo` literals: exactly the three the plan names -
   sendMessage.test.ts:256, scheduledSendSuppression.test.ts:273, the harness
   fake :1172 (plus the real repo, messagesRepo.ts:2459). app/scripts is
   typechecked (tsconfig.scripts.json) but uses `Pick<>` only; e2e,
   fake-twilio and dashboard never name MessagesRepo. Cast stubs a new path
   calls: only makeRetryApp (apiRoutes.test.ts:457); rateLimit.test.ts:350
   404s before the new guards.
2. Owner-kind branches: every site is in reader-b's table or the T2 Files
   list; the only others (broadcastFanOut.test.ts:2689, relayFanOut.test.ts:1451,
   sendReconcile.ts:483/489/496/674/951) narrow with `===` and need nothing.
3. Importers: registerHandlers.ts:16, twilio.ts:120 (enqueueSendRetry),
   oneToOneRetryDecision.ts:43 and its test :6 (MAX + backoff),
   retrySendBackoff.test.ts, twilioStatusWebhook.test.ts - all resolve through
   `export { MAX_SEND_RETRY_ATTEMPTS };`; the dashboard mirrors import only
   import-free leaves; the e2e/scripts mentions are comments.
4. Every other name/signature the sketches call exists as used (gateFor's
   union and its own takeOver; guardWrite; claim/rearm/finishAttempt/
   handToReconcile/takeOver/markRedriven/closeRedriven/closeFromReconcile/get/
   listByRecipient; append's `{deduped, tsMsgId, conversationId}`;
   touchLastActivityPreservingStatus -> ConversationItem; loadConfig(env);
   classifySendFailure; the four send-error classes and fields; the codes).
5. Harness: every FakeWorld field named exists; OUR_NUMBER '+15550009999';
   `atLevel(n)` is an EXACT level match (its doc comment says at-or-above,
   logCapture.ts:10 vs :36) - the plan's usage is exact, so it holds.
6. sendReconcile.test.ts helpers match (plant returns the message with
   `createdAt`; reconciling returns attemptedAt; the case-17 seam is
   `configureOutboundQueue` with a jobName check); see F2.5/F2.6.
7. The 18 registration sites are exactly :1271 ... :1877 as listed; three
   `jobExecutionMarkers` assertions (:1464, :1602, :1777).
8. makeRetryApp signature and 13 call sites as stated; api.ts locals are
   `messages`, `conversations` (:565), `contacts`, `sendMessage`, `mediaStore`.
9. e2e fixture parameter shapes (setDeliveryOutcome, failNextSend, failList,
   getOutboundTo, readLogTail) match the sketches; see F8.1/F8.2.
