# FW2-A report - code review round 2, backend fix wave (A6-A10)

- Implementer: FW2-A (Claude Opus 5.5), 2026-10-07. Worktree `W:/tmp/clean-org-names`,
  branch `feat/clean-org-names`.
- Range: after c15ae9a7 (R2 records) through f9d0fa29 - 5 commits, one per item. Tree
  clean after the last commit (this report is the only untracked file). Nothing left
  running. `dashboard/` and `e2e/` untouched.
- Every item test-first: the new test ran RED on the pre-fix code and failed for the
  reason the finding states, then GREEN. Logs: `.superpowers/sdd/fw2a-*.log`.
- Commit checks every time: bare `git status` as its own command, no MERGE_HEAD, explicit
  paths only, ASCII message with the `Co-Authored-By: Claude Opus 5.5` trailer; added diff
  lines 0 non-ASCII. (A9's first `git commit -m` failed - PowerShell 5.1 split the message on
  its embedded double quotes - nothing was committed; A9 and A10 were committed with
  `git commit -F <file>`.) DynamoDB Local up throughout (never started, stopped or
  restarted).
- Baseline before any edit: orgRewriteJob, orgRewriteService, organizationsApi, orgRecords,
  cleanOrgNames - 109/109 (exit 0).

## Per item

| item | commit | RED (one line) | GREEN | fast gates (exit) |
|---|---|---|---|---|
| A6 | bb4f724a fix(org-names): an org.rewrite job claims its rewrite, re-validating a lapsed lock as Run again does | interleaving: `expected undefined to be 'Metro HA'` (t-new lost the name - the reviewer's assertion); late Use, target deleted: `expected 'Step Up' to be 'Steps'`; first write under the lapsed beat: `[12:00 x3]` not `[12:16 x3]`; stale heartbeat: `expected true to be false`; 3 claim unit tests `svc.claim is not a function` (new API). 7 failed / 36 passed; both PINs green | orgRewriteJob + orgRewriteService 43/43 | fallout 7 files 253/253 (0); typecheck 0; eslint 0 |
| A7 | 6a2e4c46 fix(org-names): the cleanup's audit and blank-value counters reach the abort path and the lock | PARTIAL line lacked `auditFailed: 1` and `recordsWithBlankValues: 1` (recordsWritten 4 matched); done line `level: 30` with auditFailed 1. 2 failed / 31 passed | cleanOrgNames 33/33 | + orgListsRetired + stageClient 65/65 (0); typecheck 0; eslint 0 |
| A8 | 35631d70 fix(org-names): the cleanup counts a blank value only when its plan leaves it as it is | dry run `recordsWithBlankValues: 2`, expected 1 (the agency the move fills was counted). 1 failed / 33 passed | 66/66 (3 files) | typecheck 0; eslint 0 |
| A9 | c6e84ee4 fix(org-names): a blank member no longer counts as what remains when the cleanup drops an agency | `expected { expected: [ 'Step Up', '' ], next: [ '' ] } to be undefined` (the reviewer's evidence). 1 failed / 34 passed | 67/67 (3 files) | eslint 0 |
| A10 | f9d0fa29 docs(org-names): run the cleanup on a synced clock; the single-message issue names the job's claim | n/a (docs) | `npm run issues` exit 0 (370 open / 197 closed / 567) | ASCII 0 |

## Final gates (after the last commit)

- `cd app; npx vitest run` on 23 files - every file touched or importing a changed module
  (orgRewriteJob, orgRewriteService, organizationsApi, orgRecords, cleanOrgNames,
  registerHandlers, relayRetryLeg) plus every org suite (orgListsRetired, stageClient,
  contactOrgNames, devOrgFixture, extractionOrgListBlock, importOrgNames, orgListFake,
  orgListRepo.integration, orgNames, orgNamesService, orgRecordWriters.integration,
  orgStartingList, seedOrgNames, suggestionAcceptOrgList, suggestionResolutionRecovery,
  unitsApiOrgNames): 520/520, exit 0, no skips, no `[dynamoAdmin]` line.
- `npm run typecheck`: exit 0.
- Lint preview: `npx eslint` on the 7 touched `.ts` files - exit 0, no findings.

## A6 - what changed

- `app/src/services/orgRewrite.ts`: `revalidationProblem(entries, def)` (:202) - Run
  again's two checks, extracted verbatim, returning a reason or null; `runAgain` throws its
  unchanged 409 `org_rewrite_target_gone` on any reason. New `claim(jobId)` (:254), ONE
  `list.mutate`: (a) `not_current` (nothing written) unless lastRewrite is this id,
  `running`, and not the cleanup lock; (b) when `!isOrgRewriteRunning` (stale), the
  helper - a refusal writes `{...last, status: 'failed', heartbeatAt: now, finishedAt: now,
  error: 'org_rewrite_target_gone: <reason>'}` in the same write (`refused`); (c) otherwise
  a fresh heartbeat (`claimed`, the stored definition). `heartbeat()` (:239) answers false
  and writes nothing when `!isOrgRewriteRunning(last, now)` - status or staleness.
- `app/src/jobs/orgRewrite.ts`: the job claims instead of reading the list (:89); a
  `refused` claim logs WARN and returns `{ outcome: 'failed', counts: {} }`.
- Reasons stored: `a name it writes left the list or changed kind` (check 1),
  `a value it rewrites became a name on the list` (check 2).

### orgRewriteJob.test.ts - every existing case, decided

`runningRewrite`'s default heartbeat (ORG_T0) is a lapsed lock on the real clock. New helper
`fresh(def)` stamps the heartbeat at the services' "now".
1. 'does nothing unless lastRewrite names this id and is running' - UNCHANGED (never ran a
   lapsed lock; the claim answers not_current, writes nothing, version stays 1).
2. 'runs the definition and records done...' - FRESH (on-time intent; it would also pass
   stale, via the re-validation path). This is the "fresh job runs as before" case too.
3. 'a rename runs one pass per STORED field...' - FRESH.
4. 'a rewrite that names no fields records failed...' - FRESH, REQUIRED: stale, the claim
   now refuses first (toName 'Gone' is on no list) with the target-gone error instead of
   'the rewrite names no record fields'. Comment added.
5. 'a pass that stops records failed with the counts so far...' - FRESH.
6. 'a finish that fails too is logged...' - FRESH, and its orgRewrite override gains
   `claim` (the job's deps now Pick `claim`; without it the TypeError would be caught and
   the case would pass vacuously).
7. 'two concurrent runs of ONE definition...' - FRESH.
8. 'a run whose lock a newer rewrite took over...' - FRESH at the fake 12:00; comment
   reworded ("a newer rewrite has taken the lock over", no longer "gone stale").
9. registerOrgRewriteJobHandler 'registers org.rewrite; dispatch...' - FRESH.
- `jobWorld` no longer passes `orgListRepo` in the job deps.

New tests: job - RED interleaving (Clear queued, lock lapses, "Metro HA" added through the
real OrgNamesService and accepted by D5, tenant set, Run again refused 409, late delivery ->
both holders keep the name, no audit, `failed` with the reason, a re-delivery is
not_current); RED late Use whose target was deleted; PIN late job whose re-validation passes
-> done; RED no record before a fresh beat (every write sees heartbeat = the claim's time);
PIN on-time job runs as before (stored state equals the definition + done fields). Service -
RED stale heartbeat -> false, item unchanged; claim: not_current set (other id, done,
failed, cleanup) writes nothing; fresh -> claimed, one write; lapsed -> claimed when it
fits, refused + failed when the target was deleted, then not_current.

## Divergences and decisions

1. A6: `RunOrgRewriteDeps` drops `orgListRepo` (the job no longer reads the list;
   `OrgRewriteJobDeps` keeps it to build the service). The refusal is written inline in the
   claim's one mutate, not through `finish()` (one write, as ruled); it stores no counts.
2. A6 fallout beyond the letter: the cleanup shares `heartbeat()`, so an apply whose OWN
   lock lapsed (a slept machine, 15 minutes of failed beats) now stops with
   CleanupLockLostError instead of reviving it. Its message/class doc now say "it lapsed
   (15 minutes without a heartbeat) or another rewrite took it over ... Re-run the apply
   once no other rewrite is running"; the RUNBOOK lock paragraph says the same. Comments in
   `orgRecords.ts` (PRECONDITION, OrgRewriteLockLostError, beat) name the lapse / the claim.
   Text only; drop if unwanted.
3. A6 tests beyond the ruling's four: the late-Use target-gone case (check 1 through the
   claim), the fresh-beat-before-first-record case (property (c)) and three claim unit
   tests.
4. A7: `reportCleanupRun`'s `fields` drops its two explicit keys (flatCounts now carries
   them, same values). WARN done msg: `clean-org-names - done: N audit event(s) could not be
   written (...)`, exit still 0. Beyond the letter: RUNBOOK step 4's parenthetical now says
   where `auditFailed` shows (done line at WARN, summary, an aborted run's PARTIAL line) and
   that a re-run cannot write the event. Side effect: the cleanup lock's `counts` now carry
   both keys, so Settings' status line shows "Audit failed: N" / "Records with blank values:
   N" through orgCopy's humanizeKey fallback when > 0 (no dashboard change made - FW2-B's
   area if labels are wanted).
5. A8: counted after planning by `contactKeepsBlank` / `unitKeepsBlank`; a record that
   cannot be planned still counts its blanks (no write leaves every blank), as before. For
   units nothing changes in practice (planUnit never drops a blank; de-dup keeps one) - same
   rule applied for uniformity. By the ruling ("from the plan"), an apply write skipped on
   condition does not re-count a blank the plan would have filled.
6. A9: the blank test is `s.raw.trim() !== ''`, the one planUnit already uses per step.
7. A10: RUNBOOK - one sentence at the end of the lock paragraph naming both R2-BE-7 effects
   (a rename starting mid-apply; the apply taking over a running rewrite). Issue - the "safe
   by design" sentence separates a redelivery while the first run heartbeats from a delivery
   after the lapse (the claim), refs updated (`jobs/orgRewrite.ts:108-115`,
   `services/orgRewrite.ts:254`).

## Out of scope, noticed (no change made)

1. R2-BE-1 shape (a) residual: a pass keeps writing on a THROWN heartbeat
   (`app/src/services/orgRecords.ts:510`; the cleanup's beat, `app/scripts/clean-org-names.ts:670`,
   likewise), so 15+ minutes of failed beat writes still means records written under a
   lapsed lock until the next successful beat (which now answers false and stops it).
   Possible follow-up: stop once the last SUCCESSFUL beat is older than
   ORG_REWRITE_STALE_MS. Not ruled - file if wanted.
2. `finish()` (`app/src/services/orgRewrite.ts:284`) does not check staleness: such a run can
   still finish `done` on a lapsed lock (records already written; cosmetic).
3. `lastRewrite.error` (now the claim's reason) is never shown on Settings
   (`dashboard/src/routes/orgs/orgCopy.ts:432` prints "The last update failed: <what>.");
   Run again's refusal copy explains it. FW2-B's area if wanted.
