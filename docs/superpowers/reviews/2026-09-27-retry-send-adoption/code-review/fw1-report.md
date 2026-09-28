# Fix wave FW1 - report (retry-send adoption)

Implementer: Claude Opus 5.5 (1M context), 2026-09-28. Worktree
`W:\tmp\retry-send-adoption`, branch `feat/retry-send-adoption`, on top of
`3b05dec3` (the round 1 adjudications). Scope: exactly the FW1 list in
`r1-adjudications.md` - C-1, C-2 (reconcile half), C-3, C-4, C-5, C-10/A-7,
A-1 (comment only), A-6 (test). Status: DONE. Line numbers are at the last
code commit `bb1bbaaa`.

Every behavior fix was test-first: the regression test was run RED on the
code before the fix, the fix made it green, then the fix was reverted (the
mutation named per item), the test re-run RED, and the fixed file restored
from a scratchpad copy and checked byte-identical with `cmp`.

## Commits

| hash | subject |
|---|---|
| `5a87b380` | fix(jobs): a re-driven retry's pre-claim decline close is no longer a swallowed failure-arm write - a thrown closeRedriven fails the delivery and the redelivery re-runs the idempotent decline (C-1) |
| `29e6ef36` | fix(reconcile): a retry_send WITHDRAW that fails or is lost twice fails the check, so its redelivery re-applies it through the superseded exit; the closeSlot comment no longer claims Retry stays available (C-2 reconcile half + A-1 comment) |
| `1b993f00` | test(jobs): pin the retry job's gate DEFER exit before the window (C-3) |
| `dfff2ba4` | fix(jobs): the retry job's close lines say what happened - "retry window closed" on the window-terminal deferral; no "withdrawn" claim on a failed or lost WITHDRAW (C-4 + C-5) |
| `23abb562` | chore(jobs): a dated TODO(retry-send-lost-under-job-marker) at the pre-adoption marker belt (C-10 / A-7) |
| `bb1bbaaa` | test(jobs): the manual Retry route reads the attempt-record KEY the retry job writes (A-6) |
| (this file) | docs commit, recorded by its own hash in git log |

Files touched (the whole wave): `app/src/jobs/retrySend.ts`,
`app/src/jobs/sendReconcile.ts`, `app/test/retrySendAttempt.test.ts`,
`app/test/sendReconcile.test.ts`. No other file.

## Per item

### 1. C-1 - the pre-claim decline close propagates a throw

- Change: `app/src/jobs/retrySend.ts:678-692` - `declineBeforeClaim` calls
  `attemptsRepo.closeRedriven` directly (`:689`), no `guardWrite`. A close
  that resolves `false` still logs the lost-fence INFO (`:690`). The doc
  comment says why (a step before the claim is not a failure-arm write; R2).
  Both callers (4a `:463`, 4b `:475`) are before the claim and outside the
  post-claim try/catch, so the throw leaves the handler.
- Tests: `app/test/retrySendAttempt.test.ts:1093` FW1 C-1 (4a) - a
  `redriven` record plus a manual child; `:1114` FW1 C-1 (4b) - a `redriven`
  record on a row past the window. Each: `closeRedriven` rejects ONCE, the
  envelope dispatched directly REJECTS, the record stays `redriven`; the
  redelivery (the same envelope again) closes it `done/refused` with the
  cause (`manual_retry_superseded` / `retry_window_closed`); zero provider
  calls; ERRORs are only `job failed: messaging.retrySend` (plus, for 4b,
  the one window line from the redelivery) - no guardWrite line.
- Red proof: `retrySend.ts` restored to `3b05dec3` -> 2 failed | 34 passed
  (36), both C-1 cases `promise resolved "undefined" instead of rejecting`.
  Fixed file restored, `cmp` identical.

### 2. C-2 (reconcile half) - a WITHDRAW that does not land fails the check

- Change: `app/src/jobs/sendReconcile.ts:1308-1333` (`closeSlot`, the
  `retry_send` arm). The WITHDRAW's answer is read (`:1328`); `'failed'` or
  `'lost'` THROWS (`:1329-1331`, after the helper's own ERROR);
  `'written'` / `'already'` return normally. Order confirmed in the code:
  `closeUnresolved` (`:1402-1423`) closes the record, logs its ONE verdict
  ERROR, then `closeSlot`, then `afterClose`; the superseded exit
  (`runCheck` `:528-532`) re-applies `slotCloseOf('unresolved')` through
  `closeSlot` and then runs `afterClose`. So the failed delivery has logged
  the verdict once, and the redelivery re-applies the WITHDRAW and the emit
  with no second verdict ERROR. The other callers that can reach it
  (`enqueueOrClose` on a failed check enqueue, `redrive`'s second_unknown)
  go through `closeUnresolved` too, and a throw from either lands in the
  same superseded exit on redelivery. The job's own two unresolved arms are
  unchanged (the filed half).
- Tests: `app/test/sendReconcile.test.ts:3648` the helper
  `unresolvedWithdrawFault`; `:3698` FW1 C-2 (failed) - the WITHDRAW's write
  throws once; `:3708` FW1 C-2 (lost) - both WITHDRAW writes lose their
  condition. Each: a fail-list chain; the LAST check's envelope is taken off
  the queue and dispatched - it rejects (`withdrawal answered '<answer>'`);
  the record is `done/unresolved/provider_unreachable`, the row keeps its
  promise, no `retry_outcome`, no emit yet; the same envelope delivered
  again - the superseded INFO, the row gets the sentinel and
  `retry_outcome: 'unconfirmed'`, two emits (the WITHDRAW's and
  afterClose's); ONE `verdict: 'unresolved'` ERROR in total; the full ERROR
  list is pinned (verdict, the helper's line, `job failed: send.reconcile`).
- Red proof: `sendReconcile.ts` restored to `3b05dec3` -> 2 failed | 151
  passed (153), both `promise resolved "undefined" instead of rejecting`.
  Restored, `cmp` identical.

### 3. C-3 - the gate's defer exit is pinned (test only)

- Change: none in production.
- Test: `app/test/retrySendAttempt.test.ts:1133` FW1 C-3 - a `reconciling`
  record, then a FRESH (5 s) `attempting` record, each on a row whose window
  closed 16 minutes ago: one INFO `gate: 'defer'` per run (the two lines
  pinned by `providerSid`), no ERROR, no `claim refused` line, no
  `listRetryChildrenConsistent` call, no provider call, both records
  unchanged. Green on the unchanged code.
- Red proof: the `return;` after the defer INFO (`retrySend.ts:429`)
  removed -> 1 failed | 36 passed (37): `expected [...] to have a length of
  +0 but got 2` (a spurious `retry window closed` ERROR per row). Restored,
  `cmp` identical.

### 4. C-4 - the window-terminal deferral line says "retry window closed"

- Change: `app/src/jobs/retrySend.ts:726` - `retrySend: retry window closed -
  a deferred re-run would land past the window; chain ended`.
- Test: the existing pin `app/test/retrySendAttempt.test.ts:534` (case
  4-window, `:522`) updated FIRST.
- Red proof: the updated pin run against the old text -> 1 failed (expected
  the new text, received `retrySend: a deferred re-run would land past the
  window - chain ended`). That run IS the fix-reverted state; no restore
  needed. Not pinned anywhere else (grep over app, dashboard, e2e, scripts).

### 5. C-5 - the unresolved close lines branch on the WITHDRAW's answer

- Change: `app/src/jobs/retrySend.ts:773-794` (`handOff`'s enqueue-failure
  close) and `:834-852` (`onUnknown`'s second-unknown close). A lost or
  failed RECORD close keeps its existing line and returns; a won close runs
  the WITHDRAW and logs ONE line: `'written'` / `'already'` -> the existing
  "... attempt closed unresolved; the retry promise is withdrawn";
  `'lost'` / `'failed'` -> "... attempt closed unresolved; the retry
  promise withdrawal failed - the record decides" (`:791`, `:849`). The
  field set is the same object in both branches, as before.
- Tests: `app/test/retrySendAttempt.test.ts:1165` FW1 C-5 (second unknown) -
  failed (the write throws), lost (two lost conditions), already (the row
  already holds the sentinel and the outcome: no write, the "withdrawn"
  line); `:1212` FW1 C-5 (hand-off enqueue failure) - failed and lost. Each
  pins the full ERROR sequence (the helper's own line, then the ONE close
  line) and that the row kept its promise and has no `retry_outcome`. The
  "written" branch stays pinned by cases 1c (`:374`) and 1d (`:399`).
- Red proof: `retrySend.ts` at `3b05dec3` with ONLY the C-4 line re-applied
  (so exactly the C-5 change is reverted) -> 2 failed | 37 passed (39): the
  received line was `... the retry promise is withdrawn` where `... the
  retry promise withdrawal failed - the record decides` was expected.
  Restored, `cmp` identical.

### 6. C-10 / A-7 - the dated TODO at the belt

- Change: `app/src/jobs/retrySend.ts:444-447`, verbatim:
  `TODO(retry-send-lost-under-job-marker): remove this belt after the first
  production deploy of retry-send-adoption plus one SQS redelivery window
  (about 10 minutes); it guards only envelopes the pre-adoption code ran.`
  then `Dated 2026-09-28 (code review r1 C-10 / A-7).` Comment only.
  (`npm run issues` parses registry frontmatter only; the inline form
  follows `docs/issues/README.md`.)

### 7. A-1 - the comment (no behavior change)

- Change: `app/src/jobs/sendReconcile.ts:1309-1326`: the false "the promise
  expires on RSW's clock and Retry stays available" is replaced - after a
  `redrive_refused` or re-drive `enqueue_failed` close the promise expires
  on its own, possibly REFRESHED, clock (the unknown hand-off's, the
  re-drive's), so for up to a few minutes the bubble keeps its promise and
  the route's time guard answers 409 `retry_pending` until it expires: the
  accepted class `one-to-one-retry-promise-outlives-job-decline` (spec
  sections 0 and 7). The same block now also describes the C-2 throw.
- The grep for `Retry stays available` over app, dashboard and e2e found one
  more branch-added occurrence, a test NAME (not a comment):
  `app/test/sendReconcile.test.ts:3473` (case 11c) - corrected to "(nothing
  was sent: Retry returns once the promise expires)". The grep is now
  empty. The spec (approved, revision 5) and the build records carry the
  phrase too; they were not edited.

### 8. A-6 - the route reads the key the job writes (test only)

- Where: `app/test/retrySendAttempt.test.ts` - the cheapest place: the
  world, the real job (`wire`), the real reconcile (`registerReconcile`) and
  the chain driver are already there. The route is `buildApp` over the SAME
  world with the world's `sendAttemptsRepo` and the real send wrapper
  (`routeApp` `:1249`, `pressRetry` `:1272`; the adversarial probe's
  shape). New imports: supertest, `buildApp`, the auth-session helpers,
  `isRetryPromiseLive`.
- Tests: `:1279` FW1 A-6 (pending) - the real job, an unknown outcome ->
  `reconciling`; the promise set 10 min in the past (RSW's guard passes), no
  `retry_outcome`, no child, the fake's send restored -> 409 `retry_pending`,
  nothing sent, the record unchanged. `:1300` FW1 A-6 (unresolved) - the
  real job hands off, the real reconcile (list failing on every check)
  closes `done/unresolved`; the WITHDRAW's `retry_outcome` deleted from the
  row (the sentinel is no live promise), no child -> 409
  `retry_unresolved`, nothing sent.
- Red proof: the route's record key mutated (`app/src/routes/api.ts:1662`
  `attempt,` -> `attempt: attempt + 1,`) -> 2 failed | 39 passed (41),
  both `expected { status: 201, ... } to deeply equal { status: 409, ... }`
  (the press got through and texted). Restored, `cmp` identical, `api.ts`
  equal to HEAD.

## Verification (bare commands; long output in the gitignored `.superpowers/sdd/fw1-*.log`)

- Baseline before any edit, the six files: 6 passed, 347 tests
  (`fw1-baseline.log`).
- `cd /w/tmp/retry-send-adoption/app && npx vitest run
  test/retrySendAttempt.test.ts test/sendReconcile.test.ts
  test/apiRoutes.test.ts test/twilioStatusWebhook.test.ts
  test/retryPromiseWrites.test.ts test/retrySendBackoff.test.ts` -> exit 0,
  6 files, 356 passed: retrySendAttempt 41 (34 + 7 new), sendReconcile 153
  (151 + 2 new), twilioStatusWebhook 81, apiRoutes 59, retryPromiseWrites
  11, retrySendBackoff 11 (`fw1-verify-vitest.log`; DynamoDB Local up, not
  started or stopped here).
- `npm run typecheck` -> exit 0 (all workspaces).
- `npm run smoke` -> exit 0, "1511 import specifier(s) across 264 emitted
  file(s) resolve under plain Node."
- `npx eslint app/src/jobs/retrySend.ts app/src/jobs/sendReconcile.ts
  app/test/retrySendAttempt.test.ts app/test/sendReconcile.test.ts` ->
  exit 0, no output (no new error; no pre-existing error in these files).
- ASCII: `git diff -U0 3b05dec3..HEAD` added lines -> 0 non-ASCII bytes
  (this report included, checked before its commit).
- Fences: no diff since `3b05dec3` in `routes/webhooks/twilio.ts`,
  `jobs/jobs.ts`, `adapters/sqsJobConsumer.ts`,
  `services/oneToOneRetryDecision.ts`, `repos/messagesRepo.ts` or
  `routes/api.ts` (the A-6 mutation was restored). Nothing throws after the
  job's claim: the C-1 throw is in a pre-claim step, the C-2 throw is on
  the reconcile side; the C-5 arms still never throw. No new self-enqueue.
  Promise writes still go only through `refreshRetryPromise` /
  `withdrawRetryPromise`.
- NOT run (per the brief): the full `npm test`, `npm run e2e`, any e2e
  session.

## Found, not in the list (reported, NOT fixed)

1. The C-1 shape in pre-existing SOR code, outside this branch:
   `app/src/jobs/relayRetryLeg.ts:684` (`closeUnlessOwned`, the relay
   rung's pre-claim closes) wraps `closeRedriven` in `guardWrite`, so a
   thrown close of a `redriven` rung record is one ERROR and a strand; and
   `app/src/jobs/relayFanOut.ts:1697` (`closeRedriveRefused`, documented
   "best-effort; never throws") does the same for a re-drive pass that
   cannot run. Both predate this branch (`6bbe77a8` on main); the
   broadcast pass and the relay fan-out's other declines
   (`broadcastFanOut.ts:444`, `:656`; `relayFanOut.ts:1282`, `:1877`) call
   `closeRedriven` directly. Whether SOR's rung should follow R2's rule is
   SOR's question - a candidate note for `send-attempt-sweeper`.
2. Operational consequence of C-1 and C-2 (intended, named for the
   handback): a PERSISTENT fault now fails the job on every receive and
   dead-letters after five, paging `jobs-dlq-depth` - a `closeRedriven`
   that keeps throwing (the retry job; the record stays `redriven` for the
   sweeper, and the 4b window ERROR is never reached - only the five `job
   failed` lines, each with the error), or a WITHDRAW that keeps failing
   (the reconcile check). Before FW1 both were one swallowed ERROR and a
   silent strand. Every other owner's slot close already escalates this
   way (FW1-4).
3. On the hermetic lane a delayed in-process dispatch is never redelivered
   (SOR T10-11): a WITHDRAW that failed there would stay un-applied (as
   before FW1), now with a `job failed: send.reconcile` ERROR. The fake's
   seams cannot make `annotateRetryPromise` fail, so no e2e path reaches
   it.
