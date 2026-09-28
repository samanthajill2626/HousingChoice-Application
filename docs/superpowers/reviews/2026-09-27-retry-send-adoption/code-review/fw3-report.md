# Fix wave FW3 - report (retry-send adoption, planner re-review R2 + R3 + R4)

Implementer: Claude Opus 5.5 (1M context), 2026-09-28. Worktree
`W:\tmp\retry-send-adoption`, branch `feat/retry-send-adoption`, on top of
`61e7879b` (the adversarial re-review of fix wave 2 and its adjudications).
Scope: exactly the planner's "Fix wave 3" list in
`planner-review/adjudications.md` (items 1-3; rows R2, R3, R4), as the
orchestrator's brief spelled it out. Status: DONE. Line numbers are at the
last code commit `aae99caa` (the item 3 commit touches only the issue file).

Method (FW1's and FW2's): each regression test was written FIRST and run RED
on the unchanged code; the fix made it green; then the fix was reverted (and,
where a narrower claim needed its own proof, a named mutation applied), the
test re-run RED, and the fixed file restored from a scratchpad copy and
checked byte-identical with `cmp`. Logs are in the gitignored
`.superpowers/sdd/fw3-*.log`.

## Commits

| hash | subject |
|---|---|
| `d41a18ff` | fix(jobs): step 1 refuses a payload whose attempt is not the one the retried row can schedule - (retry_attempt ?? 0) + 1 - with one WARN naming rowAttempt, before any further read; nothing claimed or sent (retry-send-adoption FW3, planner re-review) |
| `aae99caa` | fix(retry-chain): resolveRetryRoot's legacy walk gets its own bound, RETRY_ROOT_WALK_MAX_HOPS = 12, so a pre-deploy chain a manual Retry extended resolves its TRUE root; automaticAncestry keeps MAX_SEND_RETRY_ATTEMPTS (retry-send-adoption FW3, planner re-review) |
| `73fe60bd` | docs(issues): send-attempt-sweeper - a retry_send record closed done/refused with cause already_sent means the retry text EXISTS (its retrychild# pointer names the SID); a sweeper or report must not count it as a refusal (retry-send-adoption FW3, planner re-review) |
| (this file) | docs commit, recorded by its own hash in git log |

Files touched (the whole wave): `app/src/jobs/retrySend.ts`,
`app/src/services/retryChain.ts`, `app/test/retrySendAttempt.test.ts`,
`app/test/retryChain.test.ts`, `docs/issues/send-attempt-sweeper.md`.

## Per item

### 1. R2 - step 1 refuses an attempt the retried row cannot schedule

- Change: `app/src/jobs/retrySend.ts:369-377`, right after the
  conversation-mismatch decline (`:362-368`) and before `resolveRetryRoot`
  (`:378`). A one-line comment (`:369`: holds by construction - the webhook
  schedules exactly this number and a deferral or re-drive reuses it - so 4a's
  other-attempt carve-out is unreachable); `const rowAttempt =
  (retried.retry_attempt ?? 0) + 1` (`:370`); `if (payload.attempt !==
  rowAttempt)` (`:371`) -> ONE WARN `retrySend: the payload's attempt is not
  the one the retried row can schedule - refusing` with `{ ...base, rowAttempt
  }` (the base context: providerSid, conversationId, attempt), then return.
  Nothing read further, nothing claimed, nothing written: it is a pre-claim,
  pre-read decline (the one read before it is the retried row itself).
- Tests, `app/test/retrySendAttempt.test.ts`:
  - `:690` 4c2 - title updated honestly (the other-attempt child is
    unreachable; the seeded-only sub-case named as such). Sub-cases (1)-(3)
    and every assertion after them unchanged.
  - `:749-762` sub-case (4), FLIPPED: a payload naming attempt 2 against a
    ROOT (whose one attempt is 1), here beside the root's own attempt-1 retry
    row appended through the fake's `append` (so its pointer exists - the
    state R2 names: "sends beside an existing automatic retry of the same
    row"). Asserts zero provider calls (the spy bound before the first
    sub-case), no record at attempt 1 or 2, ONE WARN with that message and
    `providerSid: 'SMown4'`, `attempt: 2`, `rowAttempt: 1`, nothing sent.
  - `:763-771` sub-case (5), labelled "seeded-only (unreachable in
    production)": the old seeded different-attempt child (attempt 2 under a
    root) with a CONSISTENT payload (attempt 1) still claims and sends once -
    step 4a's carve-out stays as written; the refusal WARN count stays 1.
  - `:830-875` 4f (new), the decline's own case, a fresh row per sub-case:
    (1) a MANUAL retried row (retry_of, no retry_attempt; pre-deploy shape, no
    retry_root, so the root walk after step 1 WOULD read) with payload
    attempt 2 - no provider call; none of the later reads ran (the lineage
    point-get, the recipient, the thread, the record, the job marker, the
    children Query), no claim, no promise write; no record at attempt 1 or 2;
    ONE WARN `rowAttempt: 1`, `attempt: 2`, carrying neither `retryRoot` nor
    `retriedTsMsgId` (the base context). (2) payload attempt 1 on a fresh
    manual row proceeds: the root walk runs, the job claims and sends once,
    the record `done/sent` attemptNo 1, the retry row `retry_attempt: 1`
    with the walked `retry_root`; the WARN count stays 1; no ERROR.
- Red before the fix (`fw3-item1-red.log`): 2 failed | 41 passed (43) - 4c2
  at `:756` and 4f at `:851`, both `expected "sendPreparedMessage" to not be
  called at all, but actually been called 1 times` (the old job claimed the
  unschedulable attempt and texted). Green: 43 passed
  (`fw3-item1-green.log`).
- Red with the fix reverted (`retrySend.ts` = `61e7879b`,
  `fw3-item1-revert.log`): 2 failed | 41 passed (43), the same two, the same
  message. Restored, `cmp` identical.
- Mutation, the placement (the whole block moved to right AFTER
  `resolveRetryRoot`, `fw3-item1-mut-placement.log`): 1 failed | 42 passed -
  4f at `:852`: `expected { name: 'lineage', calls: 1 } to deeply equal {
  name: 'lineage', calls: 0 }` (a refused payload paid the root walk's read).
  Restored, `cmp` identical.

### 1c. The audit of every retry-job dispatch in the tests

Grep of `messaging.retrySend` / `RETRY_SEND_JOB` / `enqueueSendRetry` /
`registerRetrySendJobHandler` / `run(` across `app/test` (and `e2e`,
`scripts`), each payload checked against its retried row's
`(retry_attempt ?? 0) + 1`:

- `retrySendAttempt.test.ts` (the real handler): every `run(row)` /
  `envelopeFor(row)` with the default attempt 1 - including every deferral
  re-run (`deferred: true`) and re-drive seed - names a row with no
  `retry_attempt` (a `seedRetried` root, or 4b's manual row `SMmanual1`) ->
  row attempt 1. Test 8 `run(r1, 2)` names `r1`, seeded `retryAttempt: 1` ->
  2. The real reconcile's re-drives (case 11, FW1 A-6 unresolved) carry the
  owner's attempt 1 against a root. The only inconsistent payloads are the two
  new deliberate ones (4c2 (4), 4f (1)).
- `twilioStatusWebhook.test.ts` (the real handler): the webhook-produced
  envelopes (`:1346`, `:1405`, `:1446`, `:1472`, `:1504`, `:1536`/`:1545`,
  `:1576`) come from the real 30003 arm on a root -> attempt 1 by
  construction. The direct enqueues `:1599` (SMnope: no row, declines "not
  found" before the check), `:1683`, `:1713`, `:1749`, `:1768`, `:1813`,
  `:1847`, `:1882`, `:1909` are attempt 1 against `seedOutbound` roots.
  `:1735` (SMchain01) and `:1948` (SMchain02) are attempt 2 against rows
  seeded `retry_attempt: 1` (`seedOutbound`'s `Object.assign`) -> row attempt
  2: consistent, as the brief expected; both still reach the gates they test
  (the window check; the lineage append).
- `retrySendBackoff.test.ts`: `:98` (`attempt: 3`, no row) and `:130` (the
  webhook's envelope) are only RECORDED - the outbound adapter's dispatch is a
  no-op and no handler is registered.
- `sendReconcile.test.ts`: every `RETRY_SEND_JOB` envelope is taken by a
  recording stub (`recordJobs`), never the real handler. The recorded
  re-drives are consistent anyway: attempt 1 against roots, a share root and
  manual rows (`:3262`, `:3405`, `:3469`, `:3826`, `:3850`, `:3895`); attempt
  2 against automatic attempt-1 rows (`:3872`, `:3958`, `:3986`).
- `registerHandlers.test.ts` registers names only; `relayRetryLeg.test.ts:2149`
  registers every handler through the real seam but enqueues relay rungs only;
  `apiRoutes.test.ts` dispatches no retry job. The e2e specs drive the real
  webhook, which schedules `(retry_attempt ?? 0) + 1` by construction
  (reasoned, not run).
- Empirical check: a throwaway probe mutant appended every step-1 refusal to a
  scratch file; the six suites plus `registerHandlers.test.ts` (7 files, 374
  tests, `fw3-item1c-probe.log`) produced exactly TWO refusals - `SMown4` (4c2
  (4)) and `SMf4manual1` (4f (1)). Restored, `cmp` identical.
- Seeds corrected: NONE. No existing test dispatched an inconsistent attempt,
  so no test's intent needed a new seed.

### 2. R4 - the legacy root walk gets its own bound

- Change: `app/src/services/retryChain.ts:22-31` -
  `export const RETRY_ROOT_WALK_MAX_HOPS = 12;` with its doc comment: it
  bounds ONLY `resolveRetryRoot`'s LEGACY walk (`automaticAncestry` keeps
  `MAX_SEND_RETRY_ATTEMPTS`, `:50`, unchanged - it walks automatic rows only);
  three manual retries each carrying a full three-rung automatic ladder are
  3 x (1 + 3) = 12 rows, which a walk up from the deepest of them crosses
  within 12 hops (a root's own ladder above the first manual retry adds up to
  three more rows); every row appended since retry-send-adoption carries
  `retry_root` and returns at hop 0, so only pre-deploy rows pay the reads;
  a wrong root would be written once and inherited by every later row of the
  chain. `:33` - `resolveRetryRoot`'s doc now says "at most
  RETRY_ROOT_WALK_MAX_HOPS hops" and "a broken link or the bound stops at the
  last row read". `:36` - the loop uses the new bound.
- Tests, `app/test/retryChain.test.ts` (import `:13`):
  - `:113` (a) a pre-deploy MIXED chain, none carrying `retry_root`: root <-
    a1 (auto 1) <- a2 (auto 2) <- a3 (auto 3) <- M (manual) <- a1' (auto 1 of
    M). From a1' it answers the TRUE root, and the spied
    `getByTsMsgIdConsistent` calls are exactly `[M, a3, a2, a1, root]` - five
    consistent reads.
  - `:132` (b) the old "stops after MAX_SEND_RETRY_ATTEMPTS (3) hops" is now
    "stops after RETRY_ROOT_WALK_MAX_HOPS (12) hops": a 14-row legacy chain
    (root, a1-a3, M1, b1-b3, M2, c1-c3, M3, d1; none with `retry_root`) walked
    from d1 answers `chain[1]` - the 12th parent, the last row read - after
    exactly 12 reads, in order `chain[12]` .. `chain[1]`; the root is a 13th
    hop away. `:152` pins the constant at 12, LAST, so the walk assertions
    carry the proof on their own.
  - `:100` (c) the old four-hop chain (root, r1, r2, r3, manual) no longer
    fits "stops": restated as "a pre-deploy manual Retry of a full three-rung
    ladder reaches the TRUE root four hops up" - the root, in four reads (the
    old bound answered r1).
- Red before the fix (tests first, `fw3-item2-red.log`): 3 failed | 21 passed
  (24) - (c) `expected '...#SMr1' to be '...#SMroot'` at `:109`; (a)
  `expected '...#SMa2' to be '...#SMroot'` at `:122`; (b) `expected undefined
  to be 12` (the constant did not exist; in that first layout the pin stood
  first). Green: 24 passed.
- Mutation, the bound set back to 3 (`fw3-item2-final-bound3.log`): 3 failed
  | 21 passed (24) - (a) goes red: `expected '...#SMa2' to be '...#SMroot'` at
  `:122`; so do (c) (`...#SMr1`, `:109`) and (b) (`expected '...#SMc10' to be
  '...#SMc1'`, `:144`). Restored, `cmp` identical.
- Mutation, the bound set to 13 (`fw3-item2-final-bound13.log`): 1 failed |
  23 passed - (b) alone: `expected '...#SMc0' to be '...#SMc1'` at `:144` (a
  13th read reached the root), so (b) pins the exact stop. Restored, `cmp`
  identical.
- Red with the fix reverted (`retryChain.ts` = `61e7879b`,
  `fw3-item2-final-revert.log`): 3 failed | 21 passed (24), the same three as
  the bound-3 mutation. Restored, `cmp` identical.
- The three proofs were re-run on the final file after a doc-comment-only
  edit (the "root's own ladder" clause); the results above are those runs
  (`fw3-item2-final-*.log`).

### 3. R3 - the `already_sent` line in `send-attempt-sweeper`

- Change: `docs/issues/send-attempt-sweeper.md:523-531`, a dated paragraph
  inside the "retry-send-adoption (2026-09-28)" section, right after the
  `retrychild#` family paragraph: "(FW2/FW3, 2026-09-28) `already_sent` is not
  a refusal" - a `retry_send` record closed `done` / `refused` with cause
  `already_sent` means the retry text EXISTS; the retried row's `retrychild#`
  pointer for that attempt names its SID; `closeRedriven` has no `sent`
  outcome; nothing reads `cause` today; a sweeper or a report must not count
  it as a refusal. Only a `redriven` record is closed so (`done/retryable`
  and absent write nothing).
- Citations: the job's own-child decline `app/src/jobs/retrySend.ts:478-486`
  at `aae99caa` (the close `declineBeforeClaim(owner, redriven,
  ALREADY_SENT_CAUSE, octx)` at `:480`; the same lines were `:469-477` /
  `:471` at `61e7879b`, shifted +9 by item 1); `closeRedriven`'s outcome union
  `app/src/repos/sendAttemptsRepo.ts:159-162` (`refused | redrive_refused |
  enqueue_failed | unresolved`, no sid).
- "Nothing reads `cause` today" was checked by grep over `app/src`: the only
  read of a record's `cause` is the repo's own unmarshal
  (`sendAttemptsRepo.ts:261`); no decision reads it.
- No code, so no red proof. The frontmatter's `updated:` already reads
  2026-09-28.

## Existing tests re-pinned

Only the two the list names: 4c2's sub-case (4) (flipped; the old case kept
as the labelled seeded-only sub-case (5)) and `retryChain.test.ts`'s "stops
after MAX_SEND_RETRY_ATTEMPTS (3) hops" (split into (b) and the restated (c)).
Every other existing case passed unchanged: 41 of 41 others in
`retrySendAttempt.test.ts`, 21 of 21 others in `retryChain.test.ts`, and all
of `twilioStatusWebhook` (81), `sendReconcile` (157), `apiRoutes` (59) and
`retrySendBackoff` (11).

## Verification (bare commands; output in `.superpowers/sdd/fw3-verify-*.log`)

Per-item typecheck, gate-5 lint and ASCII checks ran before each code commit
(`fw3-item1-*`, `fw3-item2-*`); the full set below ran on the final tree
(HEAD `73fe60bd`, code identical to `aae99caa`). DynamoDB Local was up; not
started or stopped here.

- Baseline before any edit (`61e7879b`, `fw3-baseline.log`): 6 files, 372
  passed - retrySendAttempt 42, sendReconcile 157, twilioStatusWebhook 81,
  apiRoutes 59, retrySendBackoff 11, retryChain 22.
- `cd app && npx vitest run test/retrySendAttempt.test.ts
  test/twilioStatusWebhook.test.ts test/retrySendBackoff.test.ts
  test/retryChain.test.ts test/apiRoutes.test.ts test/sendReconcile.test.ts`
  -> exit 0, 6 files, 375 passed: retrySendAttempt 43 (42 + 4f),
  sendReconcile 157, twilioStatusWebhook 81, apiRoutes 59, retrySendBackoff
  11, retryChain 24 (22 - 1 + 3).
- `npm run typecheck` -> exit 0 (all workspaces, no `error TS`).
- `npm run smoke` -> exit 0, "smoke-dist: OK - 1511 import specifier(s)
  across 264 emitted file(s) resolve under plain Node."
- `npx eslint app/src/jobs/retrySend.ts app/src/services/retryChain.ts
  app/test/retrySendAttempt.test.ts app/test/retryChain.test.ts` -> exit 0,
  no output (no new errors; no baseline comparison needed).
- ASCII: `git diff -U0 61e7879b..HEAD` added lines -> 0 non-ASCII bytes (this
  report checked the same way before its commit).
- Fences: no diff since `61e7879b` in `routes/webhooks/twilio.ts`,
  `jobs/jobs.ts`, `adapters/sqsJobConsumer.ts`,
  `services/oneToOneRetryDecision.ts` or `repos/messagesRepo.ts` (so
  `putJobExecutionMarker` / `getJobExecutionMarker` untouched). Nothing
  throws after the job's claim (item 1 is a pre-claim, pre-read decline with
  a plain return); no new self-enqueue; no promise write added.
- NOT run (per the brief): the full `npm test`, `npm run e2e`, any e2e
  session.

## Noted, not changed

1. Spec errata for the planner: section 0's "up to `MAX_SEND_RETRY_ATTEMPTS`
   hops" now reads `RETRY_ROOT_WALK_MAX_HOPS` (12) (the adjudication's own
   erratum); R2 step 1 gains a fourth designed decline (errata item 5 names
   three), and errata item 18's other-attempt carve-out is now unreachable in
   production. The spec was not edited here.
2. The 12's arithmetic, stated in the doc comment: 12 covers three manual
   retries each with a full ladder when the root ran no ladder of its own, and
   two manual retries after the root's own ladder (11 hops from the deepest
   row). A pre-deploy chain with the root's own ladder AND three manual
   retries each with a full ladder puts the deepest row a job can name (the
   last ladder's attempt-2 row) 14 hops from the root, and the deepest row a
   press can name 15: such a walk stops short and records a non-root. The
   value is the planner's; pre-deploy rows only.
3. The adjudications' "append the FW3 line to the handback (new code final
   `aae99caa`)" is the orchestrator's; not in this brief's list.
4. FW2's reconcile "control" case (`sendReconcile.test.ts:3816`) seeds an
   attempt-2 child under an attempt-1 owner - a state FW3 makes unreachable in
   production. Kept: it pins the reconcile's own-row lookup, which FW3 does
   not change.
5. In the same `send-attempt-sweeper` section, items 10-15 cite
   `retrySend.ts` lines from before FW2 and FW3 (for example `finish` at
   `:651-670`, now `:676-695`). Not touched (not in the list).
