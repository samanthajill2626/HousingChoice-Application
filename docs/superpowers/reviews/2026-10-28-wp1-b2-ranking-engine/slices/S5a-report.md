# S5a slice report - The ranking job, tasks S5.1-S5.5 (WP1 B2a)

- Implementer: S5a child (Claude Opus 5.5), 2026-10-29.
- Branch `feat/wp1-b2-ranking-engine`, worktree `W:/tmp/wp1-b2-ranking-engine`.
  Range: 67b2b7d9 (the S4 report, the commit before S5.1) .. 679850c9, plus
  this report's commit.
- Scope: plan section 9 - the slice head (9.0 Scope, 9.1 Contradictions,
  9.2 Cross-slice notes; plan 21586-21897) and tasks S5.1-S5.5 (plan
  21898-24836): `ranking.updated` on the bus, the SSE stream and the bridge;
  `flags.ts` and the job test fixtures; `job.ts` part 1 (claim, join, 409,
  job view, slots) and the job-store fake; `runLog.ts`; `runBatch.ts`.
  S5.6-S5.10 (rankAnchor, runDueRankings, the DynamoDB Local race tests,
  jobWiring / worker / dev tick / e2e-session env, the close) are S5b's; the
  S5 slice report (S5.10) is S5b's and links this file.
- Spec: D7 (claim, join, 409, slots; the generation check before the call
  and every write), D8 writes, D10, D11, D12 (the event). Rulings in force:
  PR13, PR14, PR15, PR19, PR36, PR37, PR42 (and PR7 through `capOf`).
  Watch items: WI1, WI13, WI16 (S5 halves), WI12 / WI14 where these files
  touch them. WORKLIST: section G (G3, G5 named), WL-S5-1 (S5.5 half),
  WL-S5-2, WL-S5-4, WL-S5-9.
- Verdict: five tasks, one commit each, each RED for its stated reason and
  then GREEN. Every shipped file is byte-identical to its plan block (checked
  with `cmp` against `sed -n` of the plan ranges) except the sanctioned
  WORKLIST edits listed in section 6. One added test case (WL-S5-2), RED on
  the plan's verbatim `runBatch.ts` for its own reason, GREEN after the fix.
  No one-value test fix. No QUESTION. Close evidence: the eight S5a /
  event test files 82 passed; the scoped app run (`ranking`, `jobQueueWiring`,
  `eventBridge`, `internalRoute`, `sse`) 43 files / 690 passed, exit 0, no
  `[dynamoAdmin]` line; root `npm run typecheck` exit 0; eslint on all 15
  touched files exit 0; ASCII 0 on every new file and every added line.

## 1. Tasks and commits

All paths under `app/`.

| Task | Commit | Files |
|---|---|---|
| S5.1 `ranking.updated` on the bus, the SSE stream and the bridge | 6c8d8979 | `src/lib/events.ts`, `src/routes/api.ts` (SSE block only), `test/rankingUpdatedEvent.test.ts` (new), `test/sse.test.ts`, `test/eventBridge.test.ts` |
| S5.2 `flags.ts` and the job test fixtures | 46098e53 | `src/services/ranking/flags.ts`, `test/helpers/rankingJobFixtures.ts`, `test/rankingFlags.test.ts` (all new) |
| S5.3 `job.ts` part 1 and the job-store fake | 55aa9ef7 | `src/services/ranking/job.ts`, `test/helpers/rankingRunsFake.ts`, `test/rankingClaim.test.ts` (all new) |
| S5.4 `runLog.ts` - the ranking run input | 5659612b | `src/services/ranking/runLog.ts`, `test/rankingRunLog.test.ts` (new) |
| S5.5 `runBatch.ts` - one batch's call and writes | 679850c9 | `src/services/ranking/runBatch.ts`, `test/rankingRunBatch.test.ts` (new) |
| report | this commit | `docs/.../slices/S5a-report.md` |

File ownership: `flags.ts`, `job.ts`, `runLog.ts`, `runBatch.ts`,
`lib/events.ts` and the SSE handler entries are PR2's S5 list; the SSE block
of `routes/api.ts`, the `eventBridge.test.ts` count and the two helpers are
PR27's S5 allowance; `test/sse.test.ts` is WL-S5-9. No other file was
touched. Diff over the range: 15 files, 2606 insertions, 3 deletions.

## 2. Test commands and counts (every run, in order)

Command form: `cd W:/tmp/wp1-b2-ranking-engine/app && npx vitest run test/<file>`.
DynamoDB Local was up (G1); `env | grep -c '^AWS_'` printed 0, so no
`env -u` prefix. No `npm ci`, `npm install` or `npm run db:start` was run.

1. S5.1 RED (`rankingUpdatedEvent`, `sse`, `eventBridge`): 3 files failed;
   5 failed, 15 passed (20). The stated symptoms, all present:
   `APP_EVENT_NAMES` lacks `'ranking.updated'`; the internal route answered
   400 (expected 204); the SSE forward case "timed out waiting for
   "event: ranking.updated""; the bridge pin "to have a length of 11 but got
   10". Fifth failure, not in the plan's RED list (G4): the SSE cleanup case's
   new connect assertion, "expected +0 to be 1" - the same missing listener
   registration. The type half of the RED (`npm run typecheck`) was not run
   at RED; the runtime half already showed every stated reason.
2. S5.1 GREEN: 3 files, 20 passed.
3. Grep for other pins of the event list (`APP_EVENT_NAMES`, a second
   `Record<AppEventName, ...>`) in app/src, app/test, dashboard/src: only
   `eventBridge.ts:45`, `internal.ts:34` (both iterate the list) and the
   tests; `internalRoute.test.ts` has no count. ASCII: 0 on the new file and
   on the added lines of the four edited files.
4. S5.2 RED (`rankingFlags`): 1 file failed, no tests - "Error: Cannot find
   module '../src/services/ranking/flags.js'", caused by "Failed to load
   url ... Does the file exist?" (G4 wording). The fixtures helper already
   existed at this RED (extracted with the test); the missing `flags.js` is
   the stated reason.
5. S5.2 GREEN: 13 passed.
6. `tsc -p tsconfig.json --noEmit` exit 0; `tsc -p tsconfig.test.json` exit
   0 (the fixtures compile against S3's shapes with no `as` on assembled
   values, IR36); eslint (3 files) exit 0; ASCII 0.
7. S5.3 RED (`rankingClaim`): "Cannot find module
   '../src/services/ranking/job.js'" (the fake helper was written with the
   test, as Step 1 says).
8. S5.3 GREEN: 16 passed.
9. tsc src exit 0, tsc test exit 0; eslint (3 files) exit 0; ASCII 0; no
   `rankjobs#` literal in any S5 file (G5).
10. S5.4 RED (`rankingRunLog`): "Cannot find module
    '../src/services/ranking/runLog.js'".
11. S5.4 GREEN: 7 passed.
12. tsc src / test exit 0; eslint (2 files) exit 0; ASCII 0.
13. S5.5 RED (`rankingRunBatch`, with the WL-S5-1 harness and the added
    WL-S5-2 case): "Cannot find module '../src/services/ranking/runBatch.js'".
14. S5.5 on the plan's VERBATIM `runBatch.ts` (before WL-S5-2 / WL-S5-4):
    20 passed, 1 failed - the WL-S5-2 case, "expected 1 to be +0" at
    `expect(h.ctx.raised.size).toBe(0)`: the failed batch's raise stays
    stranded in the job's merge map, the defect D5-2 names.
15. S5.5 GREEN after WL-S5-2 and WL-S5-4: 21 passed.
16. tsc src / test exit 0; eslint (2 files) exit 0; ASCII 0.
17. The eight files together (`rankingUpdatedEvent`, `sse`, `eventBridge`,
    `internalRoute`, `rankingFlags`, `rankingClaim`, `rankingRunLog`,
    `rankingRunBatch`): 8 files, 82 passed.
18. `npx eslint` on all 15 touched files (from the worktree root): exit 0.
19. Root `npm run typecheck` (bare): exit 0 (app src + scripts + test,
    dashboard, e2e, fake-twilio, fake-twilio-web).
20. Source-scanning guards that read the new files
    (`tenantMatchingInputsReaders`, `logCallSiteGuard`, `devGating`,
    `messageCatalogAscii`): 4 files, 101 passed.
21. Scoped app run `npx vitest run ranking jobQueueWiring eventBridge
    internalRoute sse` (every ranking-named file, S2's DynamoDB Local
    integration suites included): 43 files, 690 passed, exit 0; run twice,
    the second with output captured: 0 `[dynamoAdmin]` lines.

New cases in this range: 60 (event 2, SSE forward 1, flags 13, claim 16,
run log 7, batch 21) plus the new assertions in the SSE cleanup case and
the bridge pin.

## 3. Watch items

- WI1 (S5 half: only the ranking job writes `matches`). `git grep -n -e
  "putMatches(" -e "tableName('matches')" -e "TABLES.matches" -- app/src`:
  the repo's own declaration and method (`matchesRepo.ts:111`, `:180`) and
  ONE caller, `services/ranking/runBatch.ts:285`
  (`deps.matches.putMatches(rows)`). Holds for this range; the S5.10 grep
  (plan 26607) expects exactly that line.
- WI12 (one card definition). `git grep -n -e "tenantCard(" -e
  "propertyCard(" -- app/src/services/ranking/job.ts
  app/src/services/ranking/runBatch.ts app/src/services/ranking/runLog.ts
  app/src/services/ranking/flags.ts`: no output - the job builds no card;
  cards reach it only through `assembleRanking`'s result. WL-S5-3's report
  line is S5.10's; it must re-run this grep with `jobWiring.ts` added.
- WI13 (one cap function). `git grep -n "capOf(" -- app/src`: the
  definition (`cap.ts:84`) and ONE call, `runLog.ts:74` (`cappedAtRun`).
  The batch's `openByUnit` feeds it the flags open at run finish
  (`openFlagFields` over the stored records plus this job's raises).
- WI14 (log lines carry the press's requestId). Not built in this range:
  the fresh `runWithContext` is S5.7's `runDueRankings`. What this range
  guarantees: every `runBatch` / `emitRankingEvent` line goes through
  `deps.logger` (so the caller's context applies) and carries ids, counts,
  model, usage, cost and `err` only - never `rawText`, a card, a reason, a
  score or a name. `RankingPromptError`'s two messages (`prompt.ts:226`,
  `:347`) carry no PII.
- WI16 (the event's exact key set). `RankingUpdatedEvent`
  (`events.ts`) has exactly `anchorKind, anchorId, generation, status,
  batchesDone, batchCount`; `toRankingEvent` builds exactly those
  (`runBatch.ts:76`). Tests: `rankingRunBatch.test.ts` "the event carries
  exactly the six keys (WI16)" asserts `Object.keys(event).sort()`, and the
  first batch case asserts the emitted payload with `toEqual` (no extra
  key); the SSE case forwards the six-key payload. `batchesDone` is a COUNT
  of distinct finished indexes (scored or failed; 9.1 items 5 and 22),
  pinned by "counts distinct finished batch indexes".
- The generation check before the model call and every write (spec D7):
  `runBatch.ts` guards at :160 (before the prompt and call), :230 (before
  `putRun`), :283 (before `putMatches`), :301 (before `markMatchesWritten`,
  BA6), :312 (before each flag write), and :100 inside `progress()` (before
  every progress write, the failed paths included). Tests: "stops before the
  model call when the job is superseded", "a job superseded while the call
  is in flight writes nothing after it", "BA6: a job superseded after its
  match write does not stamp matchesWritten or write progress". The one
  non-guarded call is `getOpenCandidateFlags`, a read.
- WI15 (overlapping ticks, two pollers): S5.7 / S5.8, S5b's. This range
  ships the slots (`createRankingSlots`, reserve-before-claim, idempotent
  release), unit-tested in `rankingClaim.test.ts`.

## 4. WORKLIST items

- G1: nothing installed or restarted; DynamoDB Local was used as found.
- G2: every plan block was copied with `sed -n` (byte-exact). The two
  blocks with escapes survived: `flags.ts` keeps the regex whitespace escape
  in `folded()` (grep count 1), and `rankingRunBatch.test.ts` keeps the
  backslash-escaped apostrophe in the R2B7 case title (grep count 1). The
  WORKLIST edits were made with the Edit tool and contain no backslash.
- G3 / WL-S5-4: `runBatch.ts`'s header now says the PR37 / PR42 meaning:
  "rows that land stay, PR37; candidates whose rows are not confirmed
  written fail as 'repo'" and "failedBatches for a batch that left
  candidates unmatched through a failure - the call, the run write or the
  match write - listing exactly those candidates, PR42" (the plan's text
  said an unprocessed write throws and failedBatches holds failed calls).
  The same correction in the test file's header ("a match write keeps the
  rows that landed and fails only the candidates not confirmed written
  (PR37, PR42)" in place of "a failed match write is the batch's failure").
  9.1 item 6 ("failedBatches holds failed CALLS only") is superseded by item
  22; the code follows 22.
- G4: every RED message was vitest 3.2.6's "Cannot find module ... / Failed
  to load url ..."; each was red for the stated reason (section 2). The
  S5.1 extra failing assertion is recorded in section 2 item 1.
- G5: the helpers import `RANKING_JOBS_QUEUED_ENTITY` /
  `RANKING_JOBS_RUNNING_ENTITY` from `rankingRunsRepo.js` instead of the
  literals - `rankingJobFixtures.ts` (`queuedJob`, `runningJob`) and
  `rankingRunsFake.ts` (`putJobClaim`, `listQueued`, `listExpiredLeases`,
  `claimQueued`); `rankingClaim.test.ts`'s stored-record assertion uses the
  constant too ("never re-spelled"). `git grep "rankjobs#" -- app/src
  app/test` lists only S2's definitions (`rankingRunsRepo.ts:62-63`), its
  `tables.ts` comment and S2's own tests that pin the values.
- G6: no `ANTHROPIC_*` value was read or printed; every S5a test uses the
  stub driver from `rankingJobFixtures.ts` (no client, no network).
- G7: no command was left running; the longest run was 7 s.
- WL-S5-1 (S5.5 half): `rankingRunBatch.test.ts`'s harness seeds the fake
  with `runs.jobs.set(job.itemId, structuredClone(job));` and a comment. The
  S5.6 half (plan ~24903, `rankingRankAnchor.test.ts`) is S5b's and is a
  BLOCKER there (section 8).
- WL-S5-2: in the `putRun` catch, before the progress write, `runBatch`
  deletes each newly raised flag's `${unitId}#${field}` key from
  `ctx.raised` (the key `mergeRaisedFlags` uses), with a comment; the
  flag-write catch says a thrown `putFlagIfAbsentOrClosed` keeps its entry
  and is only logged. Test "WL-S5-2: a putRun failure drops the flags its
  batch newly raised, so a later batch raising the same flag writes it":
  batch 0's `putRun` rejects once (`vi.spyOn(...).mockRejectedValueOnce`),
  the outcome is `failed` / `repo`, no flag record, `ctx.raised` empty; batch
  1 raises the same property and field and writes it with `run-2`. RED on
  the plan's code (section 2 item 14), GREEN after.
- WL-S5-9: `app/test/sse.test.ts` carries the forward case and the cleanup
  case's two new assertions (baseline 0: the harness recorder does not
  record `ranking.updated`).
- Not in this range (S5b): WL-S5-1's S5.6 half, WL-S5-3 (S5.10 report
  line), WL-S5-5 (worker.ts / pollLoop.ts comments), WL-S5-6
  (`RATE_LIMIT_RANK_PER_MIN` in e2e-session.mjs), WL-S5-7 (`hc-test-rankjob-`
  prefix), WL-S5-8 (the shutdown residual in the S5 report).

## 5. Head contradictions in this range, as built

- Item 5 / 22: `finishedBatchCount` de-dups indexes over `batchesDone` and
  `failedBatches`, so a partial write (index in both lists) counts once.
- Item 8 / PR15: `markMatchesWritten(runId, { count: written, at })` after
  the match write, only when `written > 0`, behind its own guard (item 18,
  BA6); a `false` answer or a throw is a WARN, never a batch failure.
- Item 12: the progress write carries no `message`.
- Item 13 / IR34: a `RankingPromptError` fails the batch `driver` with no
  call and no run; any other prompt error is rethrown (S5.6's rankAnchor
  turns an exception into `error`).
- Item 14 / IR35: `costUsd` is called in `buildRankingRun` (0 for `fake`).
- Item 17, the `putRun` half (PR36, R2B7): a `putRun` throw after the call
  is caught; the batch fails with the call's own kind, `repo` only when the
  call succeeded; the ERROR line carries `runId`, `model`, `usage`,
  `costUsd` and (failed call) `callFailure`; the progress write lists the
  whole batch and no `runIds` (the run was not written). The guard-retry
  half (R2B5) is S5.6's.
- Item 19 / PR37: landed rows stay; the failed entry lists only the
  not-confirmed candidates (`'repo'`); a `putMatches` THROW fails the whole
  scored set `repo` and stamps nothing.
- Item 22 / PR42: outcomes carry `unscored`, `omitted`, `written`; a
  partially written batch is in `batchesDone` AND `failedBatches`; one with
  no row written is in `failedBatches` only. Omitted candidates go to
  `notScored` (PR13) in the same progress write.
- PR19: `buildRankingPrompt` gets `batchIndex` and `landlordCard:
  deps.config.rankingLandlordCard` (test "builds the prompt with the batch
  index and the landlord card switch").

## 6. Deviations from the plan text

All sanctioned by the WORKLIST; no behavior change beyond WL-S5-2.

- `test/helpers/rankingJobFixtures.ts`: two imports added and the two
  `entityKey` literals replaced by the constants (G5).
- `test/helpers/rankingRunsFake.ts`: two imports added and four literals
  replaced (G5).
- `test/rankingClaim.test.ts`: the import gains `RANKING_JOBS_QUEUED_ENTITY`
  and the stored-record assertion uses it (G5, "never re-spelled"; the value
  is identical, so the assertion's meaning is unchanged).
- `test/rankingRunBatch.test.ts`: the header reworded (G3), the harness seed
  cloned (WL-S5-1), one case added (WL-S5-2).
- `src/services/ranking/runBatch.ts`: the header reworded (WL-S5-4 / G3),
  the WL-S5-2 delete loop and its comment in the `putRun` catch, a two-line
  comment in the flag-write catch.
- Every other file (`events.ts` / `api.ts` / `sse.test.ts` /
  `eventBridge.test.ts` edits, `rankingUpdatedEvent.test.ts`,
  `rankingFlags.test.ts`, `flags.ts`, `job.ts`, `runLog.ts`,
  `rankingRunLog.test.ts`) is byte-identical to the plan.
- Commit bodies add the WORKLIST lines; every subject is the plan's.
- The MERGE_HEAD check used the brief's `test -e "$(git -C ... rev-parse
  --git-path MERGE_HEAD)"` form (it resolves to
  `.git/worktrees/wp1-b2-ranking-engine/MERGE_HEAD`; printed `ok` before
  every commit).
- No one-value test fix: every hand-worked value held (claim expiry and TTL,
  cost 0.054 / 0.108 / 0, the merged missing lists, the progress JSON, the
  event counts).

## 7. QUESTIONS

None.

## 8. For S5b (S5.6-S5.10) - what S5a shipped

- WL-S5-1 BLOCKER for S5.6: in `rankingRankAnchor.test.ts`'s harness (plan
  ~24903) write `runs.jobs.set(job.itemId, structuredClone(job));` - the
  fake must never hold the object passed to `rankAnchor`, or the two
  "superseded" cases cannot go GREEN. The other seeds in S5.7 / S5.9 (plan
  25635, 26200) hand the code only `getJob` / `list*` clones.
- `job.ts` is byte-identical to the plan's S5.3 block, so S5.6's import
  anchor (plan 25262-25266) and S5.7's (plan 25810-25813) match as written;
  both append at the END. `MSG_TENANT_UNREADABLE`,
  `MSG_PROPERTY_UNREADABLE`, `GUARD_RETRY_MS`, `rankAnchor`,
  `runDueRankings` and `RankingPollSummary` are S5b's (plan 25283-25871).
- `runBatch.ts` exports what S5.6 imports: `runBatch(batch, index, ctx,
  deps)`, `emitRankingEvent(deps, record)`, `BatchContext` (`job`,
  `anchor`, `direction`, `homes`, `raised`, `storedFlags`, `guard()`),
  `BatchOutcome` (`scored { omitted, written }` | `failed { failure,
  unscored, omitted, written }` | `stopped`), plus `finishedBatchCount`
  and `toRankingEvent`. `runBatch` imports `RankingJobDeps` from `job.js`
  TYPE-only, so S5.6's runtime import of `runBatch.js` from `job.ts` makes
  no cycle.
- WL-S5-2 behavior S5.6 relies on: `ctx.raised` is the job ATTEMPT's one
  map, shared by its parallel batches; a batch whose `putRun` throws
  deletes its own new entries from it. `ctx.storedFlags` caches one
  `getOpenCandidateFlags` promise per property per job (a failed read reads
  as none).
- `runBatch` does not catch an exception outside its documented paths (for
  example a non-prompt error from `buildPrompt`, a throwing driver - the
  stub's `throwFor` - or a throwing progress write): S5.6's `rankAnchor`
  turns such a throw into the batch's `failure: 'error'` entry as the plan
  writes it (plan 25340-25353; S2's doc of `RankingFailedBatch`).
- Helpers: `rankingJobFixtures.ts` (`T0`, `isoAt`, `queuedJob`,
  `runningJob`, `unitAnchor`, `tenantAnchor`, `tenantCandidate`,
  `unverifiedTenant`, `propertyCandidate`, `unverifiedProperty`,
  `assembled`, `parsed`, `stubBuildPrompt`, `throwingBuildPrompt`,
  `stubDriver` with `failFor` / `omit` / `resultFor` / `gate` / `throwFor`,
  `deferred`, `flush`, `matchRow`, `flagRecord`, `rankingRun`) and
  `rankingRunsFake.ts` (`createRankingRunsFake` with `jobs` / `runs` /
  `flags` / `writes` / `onGetJob`, `createMatchesFake` with `failPuts` /
  `failPairs` / `failGets` / `puts`). Both already import the S2 partition
  constants; the S5.6-S5.10 plan text spells no `rankjobs#` literal (awk
  over plan 24836-26727: none), so keep it that way (G5).
- S5.10's greps (plan 26607, 26613, 26635-26637) will each match exactly
  one line today: `putMatches(` at `runBatch.ts:285`, `capOf({` at
  `runLog.ts:74`. WL-S5-3's WI12 line must add `jobWiring.ts` to the grep
  above (section 3).
- S5.10's eslint list (plan 26587) includes every S5a file; all are clean
  now (section 2 item 18).

## 9. Untrimmed input

None new. `textHashOf` and `isFlagOpen` trim the card text before hashing
or comparing (spec D10); `flagReason` lowercases the field key (underscores
as spaces, a `landlord:` prefix dropped) and folds the model text's case
and spacing before the match.
No typed user input enters an S5a code path (the claim takes ids and a
boolean from S6's route).
