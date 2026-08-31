# SLICE A report - Tasks 1, 2, 3

Status: COMPLETE. All three tasks implemented under strict TDD (red observed
before every implementation), verified, and committed. Working tree clean.

## Commits

| # | Hash | Message |
|---|---|---|
| 1 | `512953fb` | feat(observability): name the failing job in the job failed message |
| 2 | `122aec68` | feat(observability): name method and route template in handler errors |
| 3 | `35eeaa86` | feat(observability): carry pollRunId through the job envelope |

Base was `6d517552`. Each commit carries the
`Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` trailer.
`git status` was read bare before each commit; explicit paths only.

## Task 1 - dispatcher message

- RED: `expected 'job failed' to be 'job failed: test.explodes'`.
- `app/src/jobs/jobs.ts` - ONLY the message arg changed; all four structured
  fields (`err`, `jobName`, `jobId`, `durationMs`) untouched.
- Verify: `npx vitest run test/jobs.test.ts` -> **19 passed** (1 file).
- `npm run typecheck` (root, 5 workspaces): PASS.

## Task 2 - express handler messages + PII refusal

- RED: all 3 new tests failed (no template, no `(unrouted)`, two branches shared
  one literal).
- `app/src/lib/errors.ts` - added private `routeLabel()` (line 144, NOT
  exported) with the plan's docblock; all three branches now append
  `${req.method} ${routeLabel(req)}`. Per worklist A4 the structured field set
  `{ err: toError(err), method: req.method, path: req.path }` is BYTE-IDENTICAL
  in all three branches - only `msg` changed.
- ASCII-ised ALL FIVE em-dashes per worklist A3: `:116`
  (`uncaughtException - exiting`), the two in the handler docblock, the URIError
  comment, and the URIError message. Confirmed first that nothing asserts them:
  `logger.test.ts:121-146` only registers/removes the `uncaughtException`
  listener and never reads its message.
- Created `app/test/expressErrorHandler.test.ts` (82 lines) with the pinned
  bodies verbatim, incl. the typed-first `fakeRes` (TS7022 avoidance).
- Verify: `npx vitest run test/expressErrorHandler.test.ts test/errorSummary.test.ts test/app.test.ts`
  -> **25 passed** (3 files: 3 + 9 + 13).
- ASCII check `tr -d '\11\12\15\40-\176' < src/lib/errors.ts | wc -c` -> **0**.
  Same check on the new test file -> **0**.
- `npm run typecheck`: PASS.

## Task 3 - pollRunId propagation

- RED: first test failed (`expected {} to deeply equal { pollRunId: 'poll-abc' }`);
  second PASSED already, exactly as the plan predicted for the regression guard.
- `app/src/jobs/jobs.ts:174` - `pollRunId` spread + the pinned comment inserted
  between `requestId` and `conversationId`. `CorrelationContext.pollRunId`
  confirmed pre-declared at `app/src/lib/context.ts:33`.
- Verify: `npx vitest run test/jobs.test.ts test/scheduler.test.ts test/sqsJobConsumer.test.ts test/twilioStatusWebhook.test.ts`
  -> **84 passed** (4 files: 21 + 15 + 12 + 36). Nothing pins the context key set.
- `npm run typecheck`: PASS.

## Divergences from plan / worklist

1. **Worklist A1 applied (plan Step 1's "confirm the existing afterEach" is
   wrong).** There is no file-level reset in `jobs.test.ts`. Both new blocks are
   wrapped in their OWN `describe` with `beforeEach`/`afterEach` calling
   `_resetForTests()`.
2. **Worklist A2 applied**, with one shape change: `type Logger` was folded into
   the file's EXISTING `../src/lib/logger.js` import and `type OutboundQueueAdapter`
   into the existing `../src/adapters/scheduler.js` import, rather than adding
   duplicate import statements. `type JobEnvelope` is a new line
   (`../src/jobs/types.js`). Same symbols, no duplicate specifiers.
3. **Added (not in the plan): a log capture in the Task 3 describe's
   `beforeEach`.** After `_resetForTests()` the jobs logger falls back to the
   real process logger, so `enqueue()`'s `'job enqueued (SQS)'` info line would
   print to stdout on every run. Wired
   `configureJobsLogger(createLogger({ level: 'info', destination: createLogCapture().stream }))`
   matching the file's existing idiom. Assertion-neutral.
4. **Task 2 docblock extended** by two sentences noting the three messages are
   distinct and name method + route template - the old docblock described only
   the 500 behavior.
5. Task 2's verify added `test/app.test.ts` (per the dispatch instruction, beyond
   the plan's two files). It passes.

## What the next slices should know

- **Line shifts in `app/src/jobs/jobs.ts`** (now **352** lines, was 345):
  the dispatch failure message is at **:338** (plan cited `:332`); the
  `correlationContext` builder still opens at **:174** but now spans **:174-186**
  (was `:174-179`) because of the 5-line comment + 1-line spread.
- **`app/src/lib/errors.ts` is now 191 lines** (was 169). `routeLabel` at
  **:144**, `createExpressErrorHandler` at **:162**. The whole file is pure
  ASCII now - keep it that way; the plan's Task 2 Step 4 check is whole-file.
- **`app/test/jobs.test.ts` is now 436 lines** (was 353), with two new trailing
  describes: `jobs: the dispatcher log line names what failed` and
  `jobs: the envelope carries the poll tick that enqueued it`. Note the file
  still has pre-existing non-ASCII (em-dashes, arrows, a section mark) in older
  lines - do NOT run a whole-file ASCII check on it.
- **For Slice G (T15 truth-up):** the new job-failure literal is
  `job failed: <jobName>` (template-literal, so CloudWatch sees e.g.
  `job failed: relay.warm`). Worklist G4 already lists the two doc sites that
  quote the old bare `job failed`:
  `app/src/adapters/messaging.ts:700` and
  `docs/issues/fake-twilio-messaging-attach-404.md:45`. Slice A did NOT touch
  either - they are still stale by design.
- **For Slice B (T4 projection):** `pollRunId` now genuinely appears on
  poll-enqueued job log lines, so `projectErrorEvent`'s `pollRunId` field has a
  real producer. Nothing in Slice A touches `cloudwatch.ts`.
- No pre-existing red tests were encountered. No unexpected importers. The
  DynamoDB container was never started/stopped; `npm test`, `npm run smoke`,
  `npm run e2e` were not run, per instructions.
