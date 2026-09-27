# SOR Stage 1 build - merged worklist (orchestrator, 2026-09-26)

The ONE worklist every implementer reads beside its plan task. It merges the
live-tree drift check of plan revision 4 (four read-only readers and one spike,
all committed in this directory at faaa9af4) into per-dispatch instructions,
and records the orchestrator's rulings where a finding offered options.

Inputs (read the ones your dispatch names; cite IDs in your report):

- Plan rev 4: `docs/superpowers/plans/2026-09-26-send-outcome-reconcile.md`
  (Global Constraints and the Shared interfaces block bind every task).
- Spec rev 11: `docs/superpowers/specs/2026-09-24-send-outcome-reconcile-design.md`.
- Findings (tracked, this directory): `foundations-drift-findings.md` (IDs T1-*,
  T4-*, T5-*, T6-*, INV-1), `send-sites-drift-findings.md` (T3-*, T7-*, T8-*,
  T9-*), `reconcile-e2e-drift-findings.md` (T10-*, T11-*, T12-*, T16-*),
  `dashboard-issues-drift-findings.md` (T13-*, T14-*, T15-*),
  `spike-twilio-node-fake-routes.md` ("Instructions for the build").
- Byte-exact references (gitignored run state, same IDs):
  `.superpowers/sdd/build-foundations-reference.md`,
  `build-send-sites-reference.md`, `build-reconcile-e2e-reference.md`,
  `build-dashboard-issues-reference.md`.

Precedence: where a finding below is ACCEPTED it OVERRIDES the plan's text for
that point; everything else in the plan stands. An implementer who meets a
conflict not covered here STOPS and reports it (never forces it).

No code under app/, dashboard/, fake-twilio/, e2e/ or scripts/ changed between
a9f411f3 (the plan's anchors) and the build start (1280058f), so every plan
line anchor the readers did not correct is exact.

## 0. Global instructions (every dispatch)

G1. Every finding in the four findings files is ACCEPTED unless section 1 below
    rules otherwise. Apply the FIX and NOTE items for your tasks as written in
    the findings file (the "Corrected instruction" / "Instruction" text).
G2. Capture-based tests pass `level: 'info'` to `createLogger` (T1-2);
    `capture.atLevel(n)` is an EXACT level match.
G3. Log a provider/typed error ONLY under the key `err` (or `error` / `cause` /
    `reason`); never spread it, never `JSON.stringify` it, never persist the raw
    cause: a network AxiosError carries the live Basic credential in `config`
    (spike, "Cross-cutting").
G4. Tests that observe a reconcile hand-off must not rely on
    `outbound.delayed` for a delay-0 enqueue (a takeover, or any attemptedAt
    older than 5 s): register a recording stub with
    `defineJobHandler(SEND_RECONCILE_JOB, ...)` before the pass and assert on it
    after `outbound.settle()` (T7-1, T8-1). Use a FRESH `new Date().toISOString()`
    for any attemptRef or seeded record whose hand-off enqueue a test observes
    (T9-1). There is no fake clock in the fan-out test files (T7-2).
G5. `guardWrite` returning `true` means the write RESOLVED, not that its fence
    won: for `handToReconcile` capture the boolean inside the guarded closure
    and hand off only when `wrote && handed`; `wrote && !handed` is INFO
    ("hand-off fence lost - the takeover owns the record"), no hand-off, not
    carried; `!wrote` is the stranded path (T7-8; Tasks 8 and 9 inherit it).
G6. `gateFor` takes the repo as a parameter - `gateFor(attempts, owner, nowMs)`
    - and inside closures use a pinned `const attempts` (and the file's existing
    `repo` pin), never a lazily assigned `let` (T7-4).
G7. Both cap-closes keep their `code` PARAMETER (`transient_cap` AND
    `enqueue_failed` callers exist): the slot close writes `code`; a redriven
    record closes `enqueue_failed` when `code === ENQUEUE_FAILED_CODE`, else
    `refused`, with `cause: code` (T7-3, T8-2). Each key's gate + close is
    wrapped in its own try/catch -> ERROR `{ err, <owner ids>, recipientKey:
    safeRecipientKey(key), label: 'capClose' }`, continue (T7-9, T8-6).
G8. Dead helpers left by the classifier (`errorCodeOf`, `TRANSIENT_CODES` in
    broadcastFanOut.ts and relayFanOut.ts) are DELETED - gate 5 lints touched
    files and an unused symbol is a NEW error (T7-10, T8-7).
G9. A key STRING is logged through `safeRecipientKey(key)`; `logSafeMemberKey`
    takes a roster MEMBER object only (T8-8, T10-4).
G10. Commit discipline (AGENTS.md, verbatim in every brief): bare `git status`
    first, `.git/MERGE_HEAD` absent (this worktree's git dir is
    `W:/AI Projects/Housing Choice/HC Application/.git/worktrees/send-outcome-reconcile`),
    EXPLICIT paths only, never `git add -A`, never `git checkout --` /
    `git restore` / `git stash`, every commit ends with
    `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
    ASCII-only on every added line; check new files with
    `tr -d '\11\12\15\40-\176' < FILE | wc -c` (0) and the staged ADDED lines
    with `git diff --cached -U0 | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c`
    (0; `grep -P` does not work in this Git Bash).

## 1. Orchestrator rulings (where a finding offered options or widened scope)

A1 (T10-1, T12-4, T16-3 - BLOCKING, accepted). Spec D15 lists "the SSE emits"
    among the adoption writes; the plan dropped the relay one. Task 10 emits
    `message.persisted` after EVERY relay slot move the job makes, in the
    status webhook's shape (`routes/webhooks/twilio.ts:3290-3295`):
    - relay_leg: after `adoptRelayRecipientIfUnsent` returns `adopted`, and
      after its `closeUnresolved`, `redrive_refused` and `enqueue_failed`
      closes when the slot close returned `closed` - `{ conversationId,
      tsMsgId: <source tsMsgId>, direction: <source row direction>,
      deliveryStatus: <the status just written> }`;
    - relay_rung: `afterClose` rebuilds the root emit from the retry row read
      consistently (T10-2): `tsMsgId: row.relay_retry_of`,
      `direction: row.direction`, `deliveryStatus` = the adopted status on a
      `found` adoption, `'failed'` on a close.
    Unit tests assert the emits over the fake world's event capture. T12 spec 1
    stays UN-reloaded.
A2 (T16-1 - BLOCKING, accepted, option b). No change to `routes/dev.ts`. The
    D20a live check (self-QA scenario 4, the orchestrator's own) plants an
    open relay group's source row and sets the slot's `attemptedAt` with one
    scratch `UpdateCommand` against the lane table using the lane's access key
    (`hclane<L>` from `e2e/.artifacts/lane.json`). The unit tests carry D20a.
A3 (T8-5 - FIX, accepted, narrowed). The relay unit's PRE-CLAIM deferral
    (`phase === 'prepare' && ref === undefined`) writes NO slot on either row
    kind: it returns `{ kind: 'transient', errorCode: SEND_RETRYABLE_CODE }`
    and the loop carries the member. Reason: the record's state is unknown at
    that point and a legacy row's only slot writer is the wholesale
    `markRecipient`, which would erase a known send's sid/sentAt; the code
    renders as queued anyway (`deliveryReason('send_retryable')` is
    undefined), so nothing visible is lost. The broadcast twin keeps its
    conditional `recordRecipientOutcome(..., {}, ['queued'])` write (safe: a
    broadcast slot has no sid and a sent slot is not `queued`). The POST-claim
    pre-send deferral keeps the plan's own-attempt slot write (a claim implies
    no known sid on the slot).
A4 (T9-4 - FIX, accepted). The rung's three transient-arm closes
    (`closeTerminally` at relayRetryLeg.ts:706 cap, :730 window reschedule,
    :749 enqueue failed) are closes by a writer other than the owning attempt
    when the transient was `deferredByClaim`; route all three through
    `gateFor(attempts, rungOwner, now)` exactly as `refuseGate` (proceed -> the
    write, plus `closeRedriven` for a `redriven` record; defer -> WARN, no
    write, return; skip -> INFO, return; taken_over -> `handOff`, WARN,
    return). Today's tests stay green (the unit's own retryable leaves the
    record `done/retryable` -> proceed).
A5 (T11-5 - FIX, accepted, option drop). No `getMessageBySid` e2e helper and
    no control route for it (no spec uses it; a REST-fetch-backed helper would
    consume a `fail-list` arming). Task 11's `e2e/fixtures/fakeTwilio.ts`
    additions are `failNextSend` and `failList` only.
A6 (T13-3 - FIX, accepted). Task 13 also amends the two falsified comments in
    `dashboard/src/routes/contact/Timeline.tsx` (:810-812 ticker clause 2,
    :820-821 clause 5; both ASCII lines) and adds that path to its commit;
    the other listed doc lines in `deliveryStatus.ts` are amended too.
A7 (T10-9 - NOTE, accepted). On the "reconcile superseded" exit, when the
    record is `done` AND `record.attemptedAt === payload.attemptedAt`, still
    run `afterClose` (finalize is conditional; the emits are idempotent), so a
    throw between a record close and `afterClose` cannot leave a broadcast
    `sending` for ever.
A8 (new, from A1's sweep). `relayFanOut.ts` has no event bus: none of its own
    terminal closes emits (pre-existing for 30007 / refused / `transient_cap`;
    this branch adds the second-unknown close and the hand-off enqueue-failure
    close to the same class). NOT fixed here (no new dependency in the fan-out);
    Task 15 FILES it as `docs/issues/relay-fanout-closes-emit-nothing.md`
    (low), citing the close sites and `useRelayThread.ts:464-501`.
A9 (T15-1, T15-2, T15-3 - accepted). Task 15 edits TEN issue files (the plan's
    nine plus `relay-staleness-alarm-assumed-not-built.md`) and CREATES one
    (A8's), and narrows the sentences T15-2/T15-3 name.
A10 (T10-12, T10-13, T10-7 - NOTE, accepted as recorded residue). The
    read-then-write inbox-touch guard, the receipt window between the relay
    pointer claim and the adoption write, and the eventually consistent
    roster read behind the digest check are ACCEPTED and named in the handback
    (none can double-send; each is presentation or ordering).
A11 (T4-4 + spike Q5 - FIX, accepted). The pinned timeout must reach the
    lane: `createRedirectingHttpClient` gains `timeout?: number` and builds
    `new RequestClient({ timeout: opts.timeout })`; the driver passes
    `TWILIO_REQUEST_TIMEOUT_MS` to BOTH `twilio(...)` and the redirecting
    client; the test reads `client.httpClient.defaultTimeout` with and without
    `apiBaseUrl` (spike "Task 4" items 1-5). `app/src/adapters/twilioHttpClient.ts`
    joins Task 4's files and commit. Never `autoRetry: true`.

## 2. Per-dispatch worklist

Each dispatch = one implementer child, sequential, in this order. The ID list
is what the child applies ON TOP of the plan task; the reference section names
the byte-exact quotes.

### S1a - Tasks 1, 2, 4 (Slice A, part 1)

- T1: T1-1 (move the JSDoc with the class; import only the leaf), T1-2, T1-3.
  Spike "Task 1" items 1-4 (test fixtures mirror the real shapes; a fake
  timeout uses `code: 'ECONNABORTED'`; never key on `err.name`).
- T2: no findings; plan as written.
- T4: T4-1 (no call signature on `TwilioClientLike`; local interface asserted
  at the call site), T4-2 (declare `sentDetails`, `providerMessages`,
  `listPageSize` on `FakeWorld`; `listPageSize` via get/set accessor), T4-3
  (push `sentDetails` from BOTH harness send methods; `world.sent`
  byte-identical), A11 (timeout plumbing, `twilioHttpClient.ts`), spike "Task
  4" items 6-8.
- Reference: build-foundations-reference.md sections 1-4.
- Fast gates: `cd app; npx vitest run test/sendOutcome.test.ts test/sendFingerprint.test.ts test/messaging.test.ts test/twilioHttpClient.test.ts test/twilioStatusWebhook.test.ts`; `npm run typecheck` (root).

### S1b - Tasks 5, 6 (Slice A, part 2)

- T5: T5-1 (anchor `RegisterJobHandlersDeps` :26-29; registrations :48/:60/:61),
  T5-2 (parity test on the `unreadIndexFakeMirror.integration.test.ts` idiom,
  named `app/test/twilioWebhookHarnessSendAttempts.integration.test.ts`), T5-3
  (declare the three fields on `FakeWorld`), T5-4 (`writeClaim` returns false
  only on `CancellationReasons[0].Code === 'ConditionalCheckFailed'`, rethrows
  anything else; `claim()` never returns an undefined record), T5-5 (dedupe
  `listByRecipient` by `attemptKey` - repo AND fake - plus the re-claim case),
  T5-6 (TTL comment: list both families beside `syssid#` as TTL-only reapers),
  T5-7 (the 15 files / 25 call sites to wire; leave `registerHandlers.test.ts:17`
  and `relayRetryLeg.test.ts:1396` alone).
- T6: T6-1 (host the relay-side cases in `app/test/broadcastsRepo.integration.test.ts`
  with inline legacy/versioned sources and per-case ids; the deduped-append case
  in `app/test/messaging.integration.test.ts`), T6-2 (no seeded `b-1`: create
  per case; REMOVE `stats.unconfirmed` for the legacy-map case; `markSending`
  before `finalizeStatus`), T6-3 (three `append` return sites incl. :2598), T6-4
  (`app/test/groupSend.test.ts:257` gains `conversationId`; add to the commit),
  T6-5 (harness dedupe returns the STORED row's conversationId), T6-6
  (`updateRecipientDeliveryStatus(conv, ts, key, 'delivered')`), T6-7 and
  T14-7 (add `(s.unconfirmed ?? 0)` to `bucketsSumToAudience`
  `app/test/broadcastFanOut.test.ts:1117-1129` and the S4 sum
  `app/test/broadcastApi.test.ts:386-397`). T8-3's harness half: implement the
  harness `listByConversationConsistent` as a delegate THROUGH the object
  property (`(...a) => messagesRepo.listByConversation(...a)` on the same
  object) so the existing spy pin at `relayFanOut.test.ts:278-297` stays
  meaningful.
- Reference: build-foundations-reference.md sections 5-11.
- Fast gates: the T5/T6 test files (DynamoDB Local is running), `npm run typecheck`.

### S2a - Tasks 3, 7 (Slice B, part 1)

- T3: T3-1 (the fixture has no business number - pass
  `env: { BUSINESS_PHONE_NUMBER: '+15550009999' }`; SID `SMfake-1`; the opted-out
  literal at :777), T3-2 (add the three type imports).
- T7: T7-1 (G4 stub), T7-2 (split 5c; the stale half is 7b with a backdated
  claim), T7-3 (G7), T7-4 (G6), T7-5 (existing milestone/listing-send catches
  stay ERROR; only the NEW acquire wrap is WARN), T7-6 (scaffolding: reset
  `sends` per test; nest inside `describe('broadcast.send (M1.8a)')`;
  `capturingLogger()` + positional `wireHandler(world, logger, undefined, env)`),
  T7-7 (3c's setup), T7-8 (G5), T7-9 (G7), T7-10 (G8), T7-11 (run 7a as a
  continuation), T7-12 (terminal skip BEFORE the brake check), T7-13 (digest
  over `conversation.participant_phone ?? contact.phone`), T7-14 (names: `AdoptDeps`
  defined and exported here; stub imports; header :1-43; the retryable arm does
  not emit).
- Reference: build-send-sites-reference.md sections 1-4, 9.
- Fast gates: `cd app; npx vitest run test/sendMessage.test.ts test/broadcastFanOut.test.ts`, `npm run typecheck`.

### S2b - Task 8 (Slice B, part 2)

- T8-1 (G4 stub for test 4), T8-2 (G7), T8-3 (re-point or rely on S1b's
  delegating harness twin; the versioned re-read `readVersionedSource` switches
  to `getByTsMsgIdConsistent` on the same passes), T8-4 (fixtures: five
  participants or `seedTeamSource`; the versioned slot carries
  `transportAggregationState: 'attempted'`; tests 12/13 in the media describe
  with `vi.spyOn(world.mediaStore, 'presign').mockRejectedValueOnce(...)`; test
  5 throws the ADAPTER `SmsSendingDisabledError` from `messagingErrors.js`; all
  FOUR registrations in the file pass `sendAttemptsRepo`), A3 (pre-claim
  deferral writes no slot) replacing T8-5's options, T8-6 (G7), T8-7 (G8), T8-8
  (G9), T8-9 (re-drive early returns: `closeRedriven` FIRST, slot
  `REDRIVE_REFUSED_CODE` only when it returned true; the four handler early
  returns need a `sendAttempts` pin; the preflight throws go to Task 15's
  residue list).
- Reference: build-send-sites-reference.md sections 5-7, 9.
- Fast gates: `cd app; npx vitest run test/relayFanOut.test.ts`, `npm run typecheck`.

### S2c - Task 9 (Slice B, part 3)

- T9-1 (fresh timestamps; G4 stub for the stale-takeover test), T9-2 (every
  test calls `seedRelay(world)` and `register()`; the deadline test
  `register({ tokenBucket: await drainedBucket() })`), T9-3 (drive the REAL unit
  for the enqueue-failure test, or seed the record with the same fresh `at`),
  A4 (gate the three transient-arm closes), T9-5 (the mirror test is
  `dashboard/src/routes/contact/relayWindowCloseMirror.test.ts`, run from
  `dashboard/`), T9-6 (stage `app/test/relayFanOut.test.ts` if Step 2 changes
  it), T9-7 (gate-read throw points -> Task 15 residue).
- Reference: build-send-sites-reference.md sections 8-9.
- Fast gates: `cd app; npx vitest run test/relayRetryLeg.test.ts test/relayFanOut.test.ts`; `cd dashboard; npx vitest run src/routes/contact/relayWindowCloseMirror.test.ts`; `npm run typecheck`.

### S3 - Task 10 (Slice C)

- A1 (emits), T10-2 (rebuild the root-close emit from the retry row), T10-3
  (export `resolveContact` from broadcastFanOut.ts, reading the contact
  CONSISTENTLY when a consistent option exists - `contacts.getById(key,
  { consistentRead: true })`), T10-4 (G9), T10-5 (the job-set pin is
  `app/test/registerHandlers.test.ts:19-35`; add the name to the
  `registerAllJobHandlers` docblock), T10-6 (no marker = never call
  `putJobExecutionMarker`; say why in the docblock), T10-7 (use
  `getByTsMsgIdConsistent` for source/retry rows), T10-8 (queue machinery:
  delays in `delaySeconds`, `deliverDelayed` drains transitively and rethrows,
  immediate enqueues need `settle()`), A7 (T10-9), T10-10 (no top-level use of
  imported values - cycle safety; `npm run smoke` proves the compiled
  imports), T10-11 (on the lane a throw is not a retry - no test or spec may
  depend on redelivery), T10-14 (`closeRedriven` FIRST, slot only when true),
  T16-2's app-side half (give the `found` INFO `event: 'send_reconcile'` too).
  INV-1 residual: a non-reseeding caller can see older index items for the
  same sender+digest - the sibling rules must tolerate them.
- Reference: build-reconcile-e2e-reference.md (Task 10 sections).
- Fast gates: `cd app; npx vitest run test/sendReconcile.test.ts test/sendReconcile.integration.test.ts test/broadcastFanOut.test.ts test/relayFanOut.test.ts test/relayRetryLeg.test.ts test/registerHandlers.test.ts`, `npm run typecheck`, `npm run smoke`.

### S4 - Tasks 13, 14 (Slice E)

- T13: T13-1 (D20a cases INSIDE the S3 describe; inline expectation literal),
  T13-2 (K first-line exclusion, R excludes the code, J first-line inclusion),
  T13-3 + A6 (doc lines incl. Timeline.tsx), T13-4 (mirror non-vacuity floor),
  T13-5 (the retry-aware K/J case), T13-6 (ASCII neighbours untouched).
- T14: T14-1 (matrix.ts anchors :1219-1228 / :1251; do not touch :1218 /
  :1250), T14-2 (StatChips test helpers as they really are), T14-3 (import
  `skippedTotal`), T14-4 (BroadcastResults test traps), T14-5 (no sort edit;
  only the hint condition; import `SEND_UNCONFIRMED_CODE` from
  `../contact/deliveryStatus.js`), T14-6 (doc lines), T14-8 (the app run needs
  DynamoDB Local - it is running), T14-9 and T14-10 (awareness).
- Reference: build-dashboard-issues-reference.md.
- Fast gates: `npm run test -w @housingchoice/dashboard -- src/routes/contact src/routes/conversation src/routes/broadcasts`; `cd app; npx vitest run test/performanceSeed.test.ts test/deriveBroadcastStats.test.ts`; `npm run typecheck`.

### S5a - Task 11 (Slice D, part 1)

- T11-1 (per-test `makeApp()`), T11-2 (newest first = REVERSE STORE ORDER,
  never a createdAt sort), T11-3 (resource fields: `date_sent` explicit null
  while queued; `messaging_service_sid`; `error_code` number or null; the
  CREATE response's `date_created` from the stored createdAt), T11-4
  (`next_page_uri` repeats To/From/PageSize/PageToken via URLSearchParams;
  list answers 200 exactly), A5 (no `getMessageBySid`), T11-6 (document that
  `reject` / `drop_before_create` leave an armed delivery profile), T11-7
  (`reset()` clears both maps). Spike "Task 11" items 1-10.
- Reference: build-reconcile-e2e-reference.md (Task 11 sections).
- Fast gates: `npm run test -w @housingchoice/fake-twilio`, `npm run typecheck`.

### S5b - Task 12 (Slice D, part 2)

- T12-1 (`verbal_in_person` + `consent_at`), T12-2 (the share-skip-fix helper
  anchors; copy or extract), T12-3 (the relay list is
  `getByRole('list', { name: 'Delivery by recipient' })` scoped to the bubble,
  revealed by a click), T12-4 (UN-reloaded; A1 makes it live), T12-5 (parties,
  intros, `includes(token)`, relay-30003 number minting), T12-6
  (`test.slow()` on specs 1, 2 and 4), T12-7, T12-8 (prove the lane FRESH:
  `npm run e2e:stop`, ports free, before the first run of the new spec), T12-9
  (fix the E2E_SEND_RETRY_BACKOFF_MS comment's sentence), T12-10, T12-11 (stage
  only what changed), T14-10 (a row read of "Not confirmed" scoped to the
  Recipients list). Spike "Task 12" items 1-4.
- Reference: build-reconcile-e2e-reference.md (Task 12 sections).
- Gates: the new spec on a fresh lane via the e2e workspace ONLY
  (`npm run e2e -w @housingchoice/e2e -- --grep "<title>"` - the root form eats
  `--grep`); the FULL suite is the orchestrator's (Phase 3), not the child's.

### S6 - Task 15 (Slice F; Tasks 16 and 17 are the orchestrator's)

- The plan's nine files plus A9 (the tenth, `relay-staleness-alarm-assumed-not-built.md`)
  and A8 (CREATE `relay-fanout-closes-emit-nothing.md` from `_TEMPLATE.md`);
  T15-2, T15-3 (narrow the falsified sentences), T15-4 (`npm run issues`
  always exits 0 - read its warning count; baseline 508 files, 0 warnings;
  one scalar per frontmatter line; set `updated:`), T15-5 (grep the TODO marker
  and state what it returns), T15-6 (optional dated lines). The residue lists
  gathered by the build (T8-9 preflight throws, T9-7 gate-read throws, the
  relay strand, the record shapes AS BUILT) are handed to this dispatch
  from the slice reports.
- Gates: `npm run issues` (read the warnings), ASCII check on every touched file.

## 3. Residues carried to the handback (not fixed on this branch)

R1 (A10) the read-then-write inbox touch; R2 (A10) the relay receipt window
between the pointer claim and the adoption write; R3 (A10) the eventually
consistent roster read behind the digest check; R4 (A8) relay fan-out closes
emit nothing (filed); R5 (T10-11) on the lane a reconcile throw is never
redelivered; R6 (T11-6) an armed delivery profile survives a reject/drop;
R7 (INV-1) older index items visible to a non-reseeding caller; plus the
spec's own Sec 1 / D14 residues and the declared deviations.
