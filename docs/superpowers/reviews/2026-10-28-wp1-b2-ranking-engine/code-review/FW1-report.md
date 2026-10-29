# B2a code review round 1 - fix wave FW1 report

- Implementer: FW1 child (Claude Opus 5.5), 2026-10-29.
- Branch feat/wp1-b2-ranking-engine, worktree W:/tmp/wp1-b2-ranking-engine.
  Start: ebc618dd (the R1 records commit; code as at a1077128). End: this
  report's commit, on top of fe33fdeb.
- Scope: every FIX row (FW1-1 .. FW1-12) and every FILE row of
  `R1-adjudications.md`. No NOTE or REJECT row was acted on.
- Method: test first for every code row - the regression test written and
  run RED against the unfixed code (red for the finding's reason, quoted
  below), then the fix, then GREEN. One commit per row or tight group;
  explicit paths; `git status` and the MERGE_HEAD check before each commit.
- Before any edit: the leftover `e2e/.artifacts/session.pid` (launcher 30836,
  lane 7) was checked - the process was gone and no lane-7 port (9701 / 9711
  / 9721 / 9731) was listening, so no e2e run was in flight while source was
  edited.

## Rows

### FW1-1 - a thrown takeOver leaks its job slot (A1-1) - commit e8b74304

- Change: `app/src/services/ranking/job.ts:635-658` - the stale-lease loop
  declares `let release` outside the `try` (635), assigns it at 644, and
  calls `release?.()` in the catch (658): the queued loop's shape. A
  release is idempotent, so a release after a started job is impossible
  (nothing after `started.push` can throw).
- Test: `app/test/rankingPoll.test.ts:128` "a takeOver that THROWS frees its
  slot, so a later pass still claims new work" - one slot, a stale running
  record, `takeOver` throws; asserts the error line, `slots.inUse() === 0`,
  then a fresh queued press on another anchor is claimed (`claimed: 1`),
  runs to `done`, and the slot is free again.
- RED: `expected 1 to be +0` at the `slots.inUse()` assertion (the slot was
  still held). GREEN: 13/13 in the file.

### FW1-2 - a paid call whose job stopped leaves no trace (A1-2) - commit 9267683c

- Change: `app/src/services/ranking/runBatch.ts:230-247` - when the guard
  before `putRun` says stopped (superseded, a refused or thrown renewal, a
  twice-failed guard read), the batch still writes nothing (spec D7) but
  logs WARN `ranking run not written - the job stopped after the call; usage
  and cost logged here` with the putRun-failure line's fields (`where`,
  `runId`, `model`, `usage`, `costUsd`, and `callFailure` for a failed
  call; no `err`).
- Tests: the two pinned rankAnchor tests keep "no run" and gain the log
  assertion, with a priced model so the cost is not trivially 0 -
  `app/test/rankingRankAnchor.test.ts:370` (superseded mid-call: level 40,
  anchor, batchIndex 0, candidates 5, runId `id-1`, model
  `claude-sonnet-5-5`, usage 1000/500, costUsd 0.007) and `:415` (refused
  renewal: same fields); plus `app/test/rankingRunBatch.test.ts:283` (a
  FAILED call superseded mid-call: `callFailure: 'timeout'`, no `err`).
- RED: all three `expected undefined to match object { level: 40, ... }`
  (no such line). GREEN: rankAnchor 24/24, runBatch 22/22.
- RUNBOOK's "spend is never invisible" sentence is made exact in FW1-12.

### FW1-3 - a thrown final finish write fails a scored job (A1-4 a) - commit 9aca282a

- Change: `app/src/services/ranking/job.ts:301-331` - the `finishJob`
  helper retries the write ONCE after `GUARD_RETRY_MS` (500 ms, the guard's
  pause, through the `sleep` seam) on a thrown error, logging WARN `ranking
  job finish write failed - retrying once`; a second throw reaches the
  caller as before. `GUARD_RETRY_MS`'s docblock names both uses.
- Deviation (scope, noted): the retry lives in the helper, so it covers
  every finish write (the final done, the pool-failure and PR38 / PR43
  finishes, the guard's and the catch-all's failed finishes), not only the
  final one. Safe for all: S2 conditions the write on status running AND the
  generation, and a lost condition answers undefined, never throws.
- Test: `app/test/rankingRankAnchor.test.ts:300` - `finishJob` throws once
  then delegates; the job ends `done` with batchCount 3, no `message`, 5
  matches, last event done 3/3, the retry line logged, `sleeps ==
  [GUARD_RETRY_MS]`.
- RED: `status: "failed"` received where `"done"` expected (the catch-all
  wrote MSG_ERROR). GREEN: 25/25.

### FW1-4, FW1-5, FW1-6 - the Rank panel hook's ordering (A2-1, A2-2, A2-8) - commit 21fe22b3

- Change: `dashboard/src/routes/settings/rankings/useAnchorRanking.ts`
  - Header (14-23) states the order rule.
  - Per-anchor state moved onto `Current` (69-86): `latestRead`,
    `jobIssued`, `jobGeneration`, `seenBatches`, `wasLive`, `jobRead`,
    `jobReadAgain` (the hook-level seen/wasLive refs are gone). One issue
    counter for every request (`issue()`).
  - FW1-4: a full read's ROWS apply only if it is the latest issued for the
    key (`loadRead`, 171-192, checks at 182 and 187 - errors too); a job
    view applies only if issued after the one on screen (`applyJob`,
    152-169); job reads never overlap - a call while one is out sets
    `jobReadAgain` and ONE trailing read follows (`refreshJob`, 237-259; the
    flight is cleared in the same step as the last loop check, so no call can
    slip between). A grown or ended job view now issues the full read
    without awaiting it (`readJobOnce`, 221-235); the read order rule makes
    that safe.
  - FW1-5: a read adopts its job by the same job-view rule, so a read issued
    before a press never replaces the press's job. The press's answer
    (`rank`, 290-298) is applied unless a job view of the same generation is
    already on screen (a read made after the claim - as new or newer), and it
    takes a fresh issue number, so every read issued before the answer is
    older and its job view is dropped when it lands.
  - FW1-6: when an applied job view shows the followed job ended, the press
    error and the joined mark are cleared (in `applyJob`, 165). A 409
    `ranking_running` sets `cur.wasLive = true` before following the job
    (306): the server just said a live job exists, so its end is seen even
    when the follow-up read already finds it done - which then also reads the
    ranking again (the table may predate that job).
- Tests (`useAnchorRanking.test.tsx`, new block "useAnchorRanking - ordering",
  347-505), each RED against the old hook:
  1. 348 the A2-1 reproduction inverted (two events in one act; the final
     read answers first, the earlier one last) - RED `expected 'stale after
     batch 0' to be 'final'`.
  2. 381 a job read issued before a press, answering after it, is dropped
     and the poll runs - RED `expected { status: 'done', ... } to match
     object { status: 'queued', ... }`.
  3. 408 three events while a job read is out: one read, then exactly one
     more - RED `expected "spy" to be called 1 times, but got 3 times`.
  4. 431 the A2-2 reproduction inverted (press answered before the first
     read; the read's job null) - RED `expected undefined to be 'queued'` at
     the after-read assertion (line 449).
  5. 454 the joined mark clears when the joined job ends - RED `expected
     true to be false`.
  6. 470 a 409's error clears when the followed job ends - RED `expected
     'A ranking is running for this record....' to be null`.
  7. 488 a 409 whose job is already done at the follow-up read clears the
     error and reads the ranking again - RED, same message.
  GREEN: 22/22 in the file; the 15 earlier cases unchanged and green.

### FW1-7 - a notes_stale refusal never tells the page (A2-5) - commit 2ed3db1e

- Change: `dashboard/src/routes/contact/ContactEditForm.tsx:714-719` - the
  notes_stale branch calls `onStale?.()` (ContactDetail's existing consistent
  re-read). The `onStale` docblock (154-158) names both 409s; ContactDetail's
  comments on `rereadRetypedContact` and at the form's `onStale` prop say the
  notes_stale case too; the form test's FW3-1 block comment no longer says
  "only that 409".
- Test: `ContactEditForm.test.tsx:2353` - a notes_stale refusal calls
  `onStale` once; Cancel then calls `onClose` once, never `onSaved`, no second
  PATCH.
- RED: `expected "spy" to be called 1 times, but got 0 times`. GREEN: 143/143
  (form) and 298/298 with ContactDetail.test.tsx.

### FW1-8 - the run detail does not link a re-scored pair (SF1) - commit 9281a00f

- Change: `RankingRunDetail.tsx` - new optional prop `onOpenRun` (31, 37);
  for a pair whose `currentRunId` is another run (116) the Current match cell
  is a button (128-139) whose visible text stays "Since re-scored" and whose
  accessible name is "Since re-scored: open the current run for <candidate>";
  "This run" and "No current match" stay text, and with no `onOpenRun` the
  cell is text as before. `RankingsSection.tsx:94-100` wires it to the
  existing `run` URL parameter (no server change). The header comment says
  so.
- Tests: `RankingRunViews.test.tsx:314` (clicking Bo Capped's mark calls
  `onOpenRun('run-9')`; exactly one button in the table) and
  `RankingsSection.test.tsx:120` (the click puts `run=run-2` in the URL and
  `useRankingRun` is called with `run-2`).
- RED: both `Unable to find an accessible element with the role "button" and
  name "Since re-scored: open the current run for ..."`. GREEN: rankings
  directory 106/106.

### FW1-9 - the cost totals' `truncated` is never shown (N2) - commit e2af73b5

- Change: `RankingCostTotals.tsx:47-51` - when `cost.truncated` the panel
  says "Too many runs in this range to total them all; totals are low.
  Choose a shorter range." beside the `incomplete` note.
  `dashboard/src/api/types.ts:700-703`: the type comment no longer says the
  page ignores `truncated`.
- Test: `RankingRunViews.test.tsx:261` (no note when false, the note when
  true); the PR34 incomplete case also asserts the note is absent.
- RED: `expect(element).toHaveTextContent()` failed (no note). GREEN.

### FW1-10 - the done-with-losses line states the loss twice; "1 candidates" (N3, N5) - commit 1c2a3249

- Change: `rankingFormat.ts:84-87` new exported `candidateCountText(n)`
  ("1 candidate", "40 candidates"), reused by the not-scored text;
  `jobStatusText` done branch (127-140): with batches and a server message
  the line is "Done: N batch(es). <message>" - the page's own count is left
  out, since S5's message counts the loss itself; with no message the old
  "; N candidates not scored. Press Rank again." stays. `RankingRunList.tsx:104`
  and `RankingRunDetail.tsx:74` use `candidateCountText`.
- Interpretation (noted, not a question): the no-batch PR38 / PR43 line keeps
  its count ("Done: 3 candidates not scored. Could not read this tenant's
  record. ...") - that message says why, not how many, so nothing is stated
  twice; the count there is the base, not an appended count.
- e2e follows: `e2e/tests/dashboard-next/rankings.spec.ts:191-194` now
  expects "Done: 1 batch. 2 tenants could not be scored. Press Rank again."
- Tests: `rankingFormat.test.ts` - the PR42 case's message expectation is now
  "Done: 3 batches. <message>" and N3's own example is pinned (152); the
  helper (209); `RankingRunViews.test.tsx:151` (list row) and `:287` (detail
  fields).
- RED: `expected 'Done: 3 batches; 4 candidates not sco...' to be 'Done: 3
  batches. 2 tenants could not ...'`; `candidateCountText is not a
  function`; the list row still held "1 candidates"; the detail fields lacked
  "1 candidate - 1200 input tokens". GREEN: rankings directory 110/110.

### FW1-11 - wrong comments (A2-4 comment half, A2-7) - commit 084ed7fe

- `app/src/services/extraction/apply.ts:968-972` and `:988-994`: the
  extraction Notes write REPLACES the box with the run's snapshot plus the
  new lines, so a staff save made during the model call is overwritten - the
  accepted residual (extraction-text-field-write-races-staff-fill), unguarded
  by spec section 4. (The old text said extraction "appends to whatever the
  box holds".)
- `dashboard/src/routes/contact/ContactEditForm.tsx:440-444`: the trim only
  decides whether the box changed; the PATCH sends `notes` as typed and the
  server stores it as sent (routes/contacts.ts:655-659).
- Comment-only: no test.

### FW1-12 - docs (SF2, N12, N14, A1-7; FW1-2) - commit fbb591e4

- GLOSSARY.md:181 - the notes_stale panel shows the current notes "in a panel
  above the box" (was "below").
- GLOSSARY.md:913-921 - the Fingerprint entry now sets itself apart from the
  prompt fingerprint (the hash of the rubric, worked examples and output
  schema that every run and match records and the gate sheet prints; never
  makes a match out of date).
- RUNBOOK.md:1694-1699 and 1707-1708 - extraction's owed-ops text no longer
  says nothing breaks: since B2a every production app and worker refuses to
  start without `ANTHROPIC_API_KEY`, so on a new env the key is pushed before
  the first deploy.
- RUNBOOK.md:1801-1808 - "One key, one rate limit": ranking and extraction
  share the key's limits; size `RANKING_MAX_CONCURRENT_JOBS` and
  `RANKING_BATCH_CONCURRENCY` against the tier (2 x 4 = 8 calls per worker by
  default); an extraction 429 spends an attempt and a row parks after five.
- RUNBOOK.md:1839-1846 - the spend sentence is exact: every paid call is a run
  record or one of two log lines (the run-write ERROR, the new
  stopped-after-call WARN); the weekly cost counts runs only and reads low by
  the calls those lines name.
- RUNBOOK.md:1859-1862 (beyond the row, for FW1-3's accuracy): the "could not
  finish" entry names the finish write's one retry and its log line.

## FILE rows - commit fe33fdeb

New issues (from docs/issues/_TEMPLATE.md; `npm run issues` indexes all four):
- `docs/issues/ranking-job-lifecycle-robustness.md` (bug, low, open): A1-3
  thrown renewal stops the job (a change is a ruling on spec D7), A1-4 b
  ambiguous progress write (list_append: idempotent progress first), A1-6 hung
  step keeps renewing (no ceiling, no DynamoDB requestTimeout), A1-10
  shutdown keeps leases - each with its interleaving and a suggested test.
- `docs/issues/ranking-unlawful-flag-stale-overwrite.md` (bug, low, open):
  A1-5 with the four-step interleaving and both fix options (read the current
  text first; or key the record by the hash - a ruling on spec D10).
- `docs/issues/notes-box-line-readers-split-differently.md` (bug, low, open):
  A2-6, the three readers with file:line, VT / FF / NEL.
- `docs/issues/ranking-card-custom-fields-unclassified.md` (decision, med,
  open): A1-8, the three options for Cameron (exclude, allowlist labels, keep
  and add a counterfactual swap).
Appended: `docs/issues/extraction-text-field-write-races-staff-fill.md` gains
an "Update (2026-10-29)" section for A2-4 (the Notes box is the same race; the
`notes_updated_at` stamp makes the guard one `expect` plus a bounded consistent
re-read and re-filter) and `updated: 2026-10-29` plus the apply.ts:995 ref.

## Suites and gates (after the last code commit, 1c2a3249 / docs after)

- `npm run typecheck` (root, bare): exit 0.
- App workspace `cd app && npx vitest run` (foreground): exit 0 - 602 test
  files passed, 12739 tests passed, 1 skipped, 160 s. No `[dynamoAdmin]` line
  in the output (the logged ProvisionedThroughputExceededException lines are
  test stubs in groupConvert / importConvertGroups tests).
- Dashboard workspace `cd dashboard && npx vitest run`: exit 0 - 282 files,
  5790 tests passed, 61 s.
- ESLint on every .ts / .tsx file the fix wave touched (21 files,
  `git diff --name-only --diff-filter=d ebc618dd..HEAD`): exit 0, no output.
- ASCII: 0 non-ASCII bytes in the added lines of `git diff -U0
  ebc618dd..HEAD` and in the commit messages.
- e2e: `npm run e2e:stop` first (the old session.pid was stale: "no running
  session found"); `npm run e2e -w @housingchoice/e2e --
  tests/dashboard-next/rankings.spec.ts` (foreground): exit 0, 5 passed
  (13.8 s) - the property ranking with the capped pair and the run detail, the
  failed batch (the new FW1-10 line), the card edit out of date, the tenant
  anchor, the VA role check. `npm run e2e:stop` again (stale state cleared);
  no listener on 9701 / 9711 / 9721 / 9731 and launcher 38796 gone. The full
  e2e suite, `npm test` and `npm run smoke` were not run (orchestrator gates).

## Deviations and interpretations

- FW1-3: the retry sits in the finish helper, so every finish write gets it
  (safe; see the row).
- FW1-4: a grown or ended job view no longer awaits its full read inside the
  job-read flight; the full-read order rule keeps the latest table.
- FW1-6: a 409 `ranking_running` marks the followed job live, so a
  follow-up read that already finds it done clears the error and reads the
  ranking again (one extra full read in that case).
- FW1-8: `onOpenRun` is optional; without it the mark stays text.
- FW1-10: the no-batch PR38 / PR43 line keeps its candidate count (its message
  gives no count).
- FW1-12: one sentence beyond the row - the RUNBOOK "could not finish" entry
  names FW1-3's retry line.
- e2e spec edited (FW1-10): `rankings.spec.ts:191-194`.

## Questions

None. Every FIX row applied as adjudicated; no reviewer claim failed to
reproduce (each fix's test was RED for the finding's reason first).

## Commits

- e8b74304 fix(ranking): a takeOver that throws returns its job slot (FW1-1)
- 9267683c fix(ranking): a paid call whose job stopped is logged at WARN with usage and cost (FW1-2)
- 9aca282a fix(ranking): retry a thrown finish write once before the catch-all (FW1-3)
- 21fe22b3 fix(rankings page): order the hook's reads; a press survives the first read; clear a followed job's press marks (FW1-4, FW1-5, FW1-6)
- 2ed3db1e fix(contact edit): a notes_stale refusal tells the page, which re-reads the contact (FW1-7)
- 9281a00f feat(rankings page): a re-scored pair links to the run holding its current match (FW1-8)
- e2af73b5 fix(rankings page): say when the cost totals stopped at the server's page cap (FW1-9)
- 1c2a3249 fix(rankings page): state a done job's loss once; say 1 candidate (FW1-10)
- 084ed7fe docs(comments): extraction's Notes write replaces the box with its snapshot; the form's trim only detects a change (FW1-11)
- fbb591e4 docs: B2a code review R1 doc fixes (FW1-12)
- fe33fdeb docs(issues): file the B2a code review R1 out-of-scope findings (FILE rows)
- this report (docs(records))
