# Fix wave FW2 - report (retry-send adoption, planner review A1 + A8a)

Implementer: Claude Opus 5.5 (1M context), 2026-09-28. Worktree
`W:\tmp\retry-send-adoption`, branch `feat/retry-send-adoption`, on top of
`0927149f` (the planner's independent review and adjudications). Scope:
exactly the planner's "Fix wave 2" list in
`planner-review/adjudications.md` (items 1-4; rows A1 and A8), as the
orchestrator's brief spelled it out. Status: DONE. Line numbers are at the
last code commit `56f1d757`.

Method (FW1's): each regression test was written FIRST and run RED on the
unchanged code; the fix made it green; then the fix was reverted (and, where
a narrower claim needed its own proof, a named mutation applied), the test
re-run RED, and the fixed file restored from a scratchpad copy and checked
byte-identical with `cmp`. Logs are in the gitignored
`.superpowers/sdd/fw2-*.log`.

## Commits

| hash | subject |
|---|---|
| `1058d8da` | fix(jobs): a re-driven retry never sends beside its own retry row - step 4a declines when the retried row already has a child of THIS attempt number (a redriven record closes done/refused already_sent; one WARN) (retry-send-adoption FW2, planner review A1) |
| `675a9100` | fix(reconcile): a retry_send check whose retried row already holds THIS attempt's own retry row is found from that row before any other step of the lookup - adopted with the row's SID, adoption skipped, path lookup; never a re-drive beside it (retry-send-adoption FW2, planner review A1) |
| `56f1d757` | test(dashboard): the R6 refusal cases assert the RENDERED alert text is ASCII, not the test's own literal (retry-send-adoption FW2, planner review A8a) |
| (this file) | docs commit, recorded by its own hash in git log |

Files touched (the whole wave): `app/src/jobs/retrySend.ts`,
`app/src/jobs/sendReconcile.ts`, `app/test/retrySendAttempt.test.ts`,
`app/test/sendReconcile.test.ts`,
`dashboard/src/routes/contact/Timeline.test.tsx`. `Timeline.tsx` was
mutated for item 4's proof only and restored byte-identical (equal to HEAD).

## Per item

### 1. A1 (job) - step 4a declines on THIS attempt's own child

- Change: `app/src/jobs/retrySend.ts:279` -
  `const ALREADY_SENT_CAUSE = 'already_sent';` with a one-line doc comment,
  beside `DEFERRAL_CAP_CAUSE` / `MANUAL_RETRY_SUPERSEDED_CAUSE`.
  `:459-467` - the 4a comment now states the narrowed rule (a child of THIS
  attempt number is this attempt's own retry row; only an automatic child of
  ANOTHER attempt number is ignored). `:469-477` - after the
  `listRetryChildrenConsistent` read (`:468`) and BEFORE the manual-child
  check (`:478`): the first child with `retryAttempt === payload.attempt`
  declines through `declineBeforeClaim(owner, redriven, ALREADY_SENT_CAUSE,
  octx)` (a `redriven` record closes `done/refused` cause `already_sent`;
  `done/retryable` and absent write nothing; a throwing close propagates, as
  FW1 C-1 made it), then ONE WARN `retrySend: this attempt already appended
  its retry row - not re-sent` with the owner context, `cause:
  'already_sent'`, `childTsMsgId` and `childProviderSid`.
- Field names: the child's ids ride as `childTsMsgId` / `childProviderSid`,
  not `tsMsgId` / `providerSid`, because the owner context already carries
  `providerSid` (the RETRIED row's SID, the payload's) and must keep it. Ids
  only - no phone, no body.
- Order: the own-child decline precedes the manual-child decline (with both
  children present the cause is `already_sent`) and the 4b window check (an
  own row past the window is the WARN, not the window ERROR). It is a
  pre-claim step: nothing throws after the claim.
- Tests: `app/test/retrySendAttempt.test.ts:653` case 4c keeps its three
  manual-child sub-cases; its title no longer claims the automatic carve-out
  and points to 4c2. `:690` case 4c2 (new; the old 4c sub-case 4 moved here
  and flipped), each sub-case on its own fresh retried row with an automatic
  child appended through the fake's `append` (so the pointer exists), the
  provider spy and an `annotateRetryPromise` spy bound before the runs:
  (1) absent record - zero provider calls, no record, the promise untouched,
  ONE WARN pinned field by field (cause, the owner context, the child's ids);
  (2) a `redriven` seed - the record ends `done/refused` cause `already_sent`,
  `redriveCount` 1, zero provider calls; (3) a `done/retryable` seed and a
  `deferred: true` payload - the record unchanged, zero provider calls; then
  exactly three WARNs, no manual-supersede line, no ERROR, no promise write,
  nothing sent; (4) `:749` an automatic child of attempt 2 under a payload of
  attempt 1 - the job claims and sends once (`done/sent`, attemptNo 1).
- Red before the fix (`fw2-item1-red.log`): 1 failed | 41 passed (42) - 4c2:
  `expected "sendPreparedMessage" to not be called at all, but actually been
  called 1 times`. Green: 42 passed.
- Red with the fix reverted (`retrySend.ts` = `0927149f`,
  `fw2-item1-revert.log`): 1 failed | 41 passed (42), the same message.
  Restored, `cmp` identical.
- Mutation, the redriven close removed (`await declineBeforeClaim(...)` ->
  `void ALREADY_SENT_CAUSE;`, `fw2-item1-mut-close.log`): 1 failed | 41
  passed - sub-case (2)'s record stayed `redriven` (expected `done` /
  `refused` / `already_sent`). Restored, `cmp` identical.
- Mutation, the carve-out removed (`child.retryAttempt === payload.attempt`
  -> `child.retryAttempt !== undefined`, `fw2-item1-mut-carveout.log`): 1
  failed | 41 passed - sub-case (4): `expected "sendPreparedMessage" to be
  called 1 times, but got 0 times`. Restored, `cmp` identical.

### 2. A1 (reconcile) - the lookup's FIRST step reads this attempt's own row

- Change: `app/src/jobs/sendReconcile.ts:1097-1123` - `ownRetryRow(c, r, o,
  checkNo)`: ONE `listRetryChildrenConsistent(o.conversationId,
  o.retriedTsMsgId)`; the FIRST child (tsMsgId order) with `retryAttempt ===
  o.attempt` is read with `getByTsMsgIdConsistent(o.conversationId,
  child.tsMsgId)`; a row answers `{ kind: 'found', sid: row.provider_sid,
  adoption: 'skipped', status: row.delivery_status, path: 'lookup' }` (no
  provider call, no append, no second row); a missing row (an anomaly: the
  pointer rides the row's own transaction) logs ONE WARN - `event`, the
  owner (`ownerLog`), the redacted key, `checkNo`, `childTsMsgId` - and the
  lookup goes on unchanged. `:1140-1150` - the first statement of `lookup`,
  guarded on `r.owner.kind === 'retry_send'` (other owner kinds pay no read;
  the guard is also the type narrowing). Nothing else in `lookup` changed.
  `runCheck`'s `found` arm then closes the record `adopted` with that SID,
  logs the found line and runs `afterClose` (the retried row re-renders), as
  for any found.
- Consequences, as built: the short path makes no adoption emit and no inbox
  touch for the child row (the send that appended it announced it and
  touched the thread); the found line's `deliveryStatus` is the row's stored
  status, not the provider's current one; the missing-row WARN fires once
  per check (per lookup), so a three-check chain logs three.
- Tests: `app/test/sendReconcile.test.ts:3718-3850`, in the `retry_send
  owner` describe, helpers `ownRowWorld` (`:3721`: register, recordJobs
  (RETRY_SEND_JOB), seedOneToOne) and `withChildRow` (`:3737`: the retried
  row, attempt 1 `reconciling` WITHOUT a sid, and a child appended through
  the fake's `append` with retryOf / retryAttempt / retryRoot, created 100 s
  after the attempt started - outside the window; the provider lists
  nothing).
  - `:3756` found: `runChain` -> `done/adopted` with the child's SID, no
    re-drive envelope, nothing scheduled, the message count unchanged (one
    pointer), no audit row, ONE found line `path: 'lookup'`, `adoption:
    'skipped'`, `deliveryStatus: 'sent'`, `checkNo: 0`; the promise neither
    refreshed nor withdrawn; one `message.persisted` for the retried row,
    none for the child; `listMessages` (spied before the run) never called;
    no WARN or ERROR.
  - `:3783` the proof wins over every other verdict: the list throwing on
    every check (was `unresolved/provider_unreachable`), a record with no
    sender (was `unresolved/no_sender`), the thread renumbered (was
    `unresolved/digest_mismatch`) - each `done/adopted` from its own row at
    check 0, the promise never withdrawn, no ERROR or WARN, no list call, no
    re-drive, nothing sent.
  - `:3816` control: a child of attempt 2 under the attempt-1 owner - the
    pointer partition read once per check (3), the list three times,
    `never_sent` at the last check and ONE re-drive (`redriven`), no found
    line, no missing-row WARN.
  - `:3832` anomaly: `getByTsMsgIdConsistent` answers nothing for the
    child's tsMsgId only - one missing-row WARN per check (checkNo 0, 1, 2)
    naming the owner and `childTsMsgId`; the list three times; `never_sent`
    and ONE re-drive.
- Red before the fix (`fw2-item2-red.log`): 4 failed | 153 passed (157) -
  found: `expected "listMessages" to not be called at all, but actually been
  called 3 times`; wins: the first attempt ended `outcome: 'unresolved'`
  (expected `adopted`); control: `expected "listRetryChildrenConsistent" to
  be called 3 times, but got 0 times` (its verdict half - never_sent, one
  re-drive - passes on the old code by design: it pins the unchanged
  lookup); anomaly: `expected [] to deeply equal [ 0, 1, 2 ]`. Green: 157
  passed.
- Red with the fix reverted (`sendReconcile.ts` = `1058d8da`, i.e. before
  this item; `fw2-item2-revert2.log`): 4 failed | 153 passed (157), the same
  four. Restored, `cmp` identical.
- Mutation, the placement (the own-row block moved AFTER the no_sender and
  digest checks, still before the list; `fw2-item2-mut-placement2.log`): 1
  failed | 156 passed - the "wins" case: `SMown-2` (no sender) closed
  `unresolved` (expected `adopted`); the unreachable-list sub-case still
  passed, as expected. Restored, `cmp` identical.
- Mutation, the anomaly WARN removed (`fw2-item2-mut-anomaly2.log`): 1
  failed | 156 passed - `expected [] to deeply equal [ 0, 1, 2 ]`. Restored,
  `cmp` identical.
- The proofs were re-run on the final file after a comment-only edit
  (`fw2-item2-green2.log` and the `*2.log` files); the results above are
  those runs.

### Item 2's placement - the decision and its reason

The orchestrator's call, recorded as instructed: the own-row check is the
FIRST step of `lookup` - before the `no_sender` and digest checks, and so
before the provider list. The pointer is local, strongly consistent proof
that this attempt's text exists, so it must win over every verdict the
lookup could otherwise reach. Placed after the no_sender check, an
unpinned-dev send (no `sender` on the record) would close
`unresolved/no_sender` and WITHDRAW the promise ("retry not confirmed")
beside an existing retry row; after the digest check, a renumbered thread
would do the same. The placement mutation above proves the no_sender half
bites. It is also the cheapest order: one consistent Query on a pointer
partition of a handful of items, ahead of up to RECONCILE_MAX_PAGES provider
pages. It never runs on the known-SID path (`adoptKnown`), which already
adopts by SID.

### 3. A1 (tests)

Covered under items 1 and 2 above (4c / 4c2; the four FW2 reconcile cases).

### 4. A8a - the ASCII assertion reads the rendered alert

- Change: `dashboard/src/routes/contact/Timeline.test.tsx:974-975` -
  `expect(sentence).toMatch(/^[ -~]+$/)` replaced by
  `expect(alert.textContent ?? '').toMatch(/^[ -~]+$/)` with a one-line
  comment; the other assertions kept.
- Proof: `Timeline.tsx`'s `sendFailureMessage` `superseded` sentence
  (`:140`) temporarily made to end in U+2014 (em dash).
  - OLD assertion + mutation (`fw2-item4-old-assertion-mutated.log`, `-t
    "retry-send-adoption R6"`): 2 passed | 156 skipped - vacuous:
    `toHaveTextContent(sentence)` is a substring match and the old check read
    the table literal.
  - NEW assertion + mutation (`fw2-item4-new-assertion-mutated.log`): 1
    failed | 1 passed | 156 skipped - `expected 'A newer attempt already
    exists for th...' to match /^[ -~]+$/`, received the sentence plus the
    em dash.
  - `Timeline.tsx` restored from the scratchpad copy: `cmp` identical and
    `git diff --quiet` equal to HEAD; both Timeline suites green (211).

## Existing tests re-pinned

None. The only existing test edited is 4c, which is the listed flip itself
(its automatic sub-case moved to 4c2 and inverted; its title corrected).
Every other existing case passed unchanged - 41 of 41 in
`retrySendAttempt.test.ts` before 4c2 was added, 153 of 153 in
`sendReconcile.test.ts`. Why no reconcile verdict moved: no existing
`retry_send` case reaches `lookup` with a child of the owner's OWN attempt
number under the retried row. The adoption cases (10, 10a-10h) append the
child during the check that closes the record (a redelivery meets `done` at
the superseded exit); 10e is the known-SID path; the lineage cases
(13-13e) run their attempt against a retried row that has no child at all
(r1, a share root, a manual row, m1); the never_sent / unresolved / C-2
cases have no child either. In `retrySendAttempt.test.ts` the chain cases (11 second
half, A-6) reach the reconcile before any row is appended. The e2e items
17-19 (`accept_then_drop`, `drop_before_create`, plus `fail-list`) append no
row before the reconcile's first check (reasoned, not run - the e2e is the
planner's).

## The residual this wave does NOT close

The original run's provider call still IN FLIGHT - its row not yet
appended, so no retrychild# pointer exists - when the reconcile's last check
(attempt start + 240 s) rules `never_sent` AND the re-driven job passes its
step 4a. Neither belt can see a row that does not exist yet: the re-driven
job claims from `redriven` and sends, then the late call lands and its
append adds a second attempt-N row (a double text). This is the SOR
`send-attempt-rearm-residues` class (a request that trickles past the
window; a re-arm cannot fence a request that already left). What FW2 closes
is the adversarial review's concrete path: once the late row IS appended,
the reconcile finds it (item 2) and a re-driven job declines on it (item 1).
Rows appended before the pointer family existed (no backfill) stay
invisible to both belts, as the route's R6 already states.

## Verification (bare commands; output in `.superpowers/sdd/fw2-verify-*.log`)

Run on the final code commit `56f1d757` (the per-item typecheck, lint and
ASCII checks also ran before each code commit). DynamoDB Local was up; not
started or stopped here.

- Baseline before any edit (`0927149f`): the nine app files 762 passed; the
  two dashboard files 211 passed (`fw2-baseline*.log`).
- `cd app && npx vitest run test/retrySendAttempt.test.ts
  test/sendReconcile.test.ts test/twilioStatusWebhook.test.ts
  test/broadcastFanOut.test.ts test/relayFanOut.test.ts
  test/relayRetryLeg.test.ts test/apiRoutes.test.ts test/retryChain.test.ts
  test/retryPromiseWrites.test.ts` -> exit 0, 9 files, 767 passed:
  retrySendAttempt 42 (41 + 1), sendReconcile 157 (153 + 4),
  twilioStatusWebhook 81, broadcastFanOut 109, relayFanOut 152,
  relayRetryLeg 134, apiRoutes 59, retryChain 22, retryPromiseWrites 11.
- `cd dashboard && npx vitest run src/routes/contact/Timeline.test.tsx
  src/routes/contact/Timeline.delivery.test.tsx` -> exit 0, 211 passed:
  Timeline 158, Timeline.delivery 53.
- `npm run typecheck` -> exit 0 (all workspaces).
- `npm run smoke` -> exit 0, "1511 import specifier(s) across 264 emitted
  file(s) resolve under plain Node."
- `npx eslint app/src/jobs/retrySend.ts app/src/jobs/sendReconcile.ts
  app/test/retrySendAttempt.test.ts app/test/sendReconcile.test.ts
  dashboard/src/routes/contact/Timeline.test.tsx` -> exit 0, no output.
  `Timeline.tsx` (mutated for the proof, restored, equal to HEAD): its ONE
  pre-existing error, `1595:7` (setState synchronously within an effect),
  untouched - not this wave's.
- ASCII: `git diff -U0 0927149f..HEAD` added lines -> 0 non-ASCII bytes
  (this report checked the same way before its commit).
- Fences: no diff since `0927149f` in `routes/webhooks/twilio.ts`,
  `jobs/jobs.ts`, `adapters/sqsJobConsumer.ts`,
  `services/oneToOneRetryDecision.ts` or `repos/messagesRepo.ts` (so
  `putJobExecutionMarker` / `getJobExecutionMarker` untouched). Nothing
  throws after the job's claim (item 1 is a pre-claim decline). No new
  self-enqueue. No promise write added (item 1 writes none; item 2's found
  path writes none - the found arm's afterClose only emits).
- NOT run (per the brief): the full `npm test`, `npm run e2e`, any e2e
  session.

## Noted, not changed

1. The approved spec still says the opposite of item 1 in two places - R2
   step 4a and section 4 item 4c ("an AUTOMATIC child (the attempt's own
   earlier success) does not trigger it") - and R4 has no own-row step in
   the lookup. Errata for the planner; the spec was not edited here.
2. The "wins" case title calls the no_sender and digest closes
   "provider-side" verdicts, following the brief's framing; the code
   comment at `sendReconcile.ts:1140` says "every verdict below".
