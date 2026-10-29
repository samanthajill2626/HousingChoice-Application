# B2a code review round 2 - fix wave FW2 report

- Implementer: FW2 child (Claude Opus 5.5), 2026-10-29.
- Branch feat/wp1-b2-ranking-engine, worktree W:/tmp/wp1-b2-ranking-engine.
  Start: 2729e299 (the R2 records commit). End: this report's commit, on top
  of 14d35cec.
- Scope: every FIX row (FW2-1 .. FW2-7) and every FILE row of
  `R2-adjudications.md`. No NOTE row and not Q1 (filed as a decision issue;
  the flag reason code is unchanged).
- Method: test first for every code row - the regression test written and
  run RED against the FW1 code for the finding's reason (quoted below), then
  the fix, then GREEN. The four hook rows share one file, so each was also
  checked by MUTATION: on the fixed hook, that row's fix alone was reverted
  and its own tests had to go RED with every other test green. Explicit
  paths, `git status` and the MERGE_HEAD check before each commit.
- Before any edit: no `e2e/.artifacts/session.pid`, so no e2e run was in
  flight; no source was edited while either e2e spec ran.

## Rows

### FW2-1, FW2-2, FW2-3, FW2-5 - the Rank panel hook - commit 20e7305f

File: `dashboard/src/routes/settings/rankings/useAnchorRanking.ts`.

- Header (14-38) restates the order rules as they now are (rows, failures,
  job views of one generation and of another, a new generation, stalled job
  reads); every claim was re-read against the code.
- State (`Current`, 97-118): `rowsIssued` and `failedIssued` (FW2-3);
  `jobView`, the view on screen (FW2-1, FW2-5) - it replaces
  `jobGeneration` and `seenBatches`, which are derived from it now;
  `jobFlight` (FW2-2) replaces `jobRead` / `jobReadAgain`.
- FW2-5 (`jobProgress` / `compareProgress`, 125-139; `applyJob`, 202-231):
  a view of the generation on screen is applied only if it is not behind it
  - status queued < running < ended (done / failed / expired), then finished
  batches, then the pool built (batchCount) - and, when level, only if issued
  after every view applied (FW1's issue rule as the tie-break). Across
  generations (or with none on screen) the issue rule stays. `jobIssued` is
  the highest issue number applied (`Math.max`), so a same-generation view
  applied out of issue order never lowers the cross-generation bar.
- FW2-1 (`applyJob` 214-221; the press, 370-372): a view of a generation not
  on screen counts its finished batches from zero and its end even unseen
  live (`grew = finished > 0`, `ended = (wasLive || newGeneration) && !live`).
  The press's 202 now goes through `applyJob` (a fresh issue number, as
  before) and reads the ranking when that change says grew or ended - a
  joined press of a generation the page never showed, already part-way.
- FW2-3 (`loadRead`, 233-262): rows apply when issued after the rows held
  (245), not only when latest. A failure is still shown only for the latest
  full read (256-258) and is remembered (`failedIssued`); a success clears
  the status only when issued after that failure (248-252), so an earlier
  read that answers after the latest one failed applies its rows underneath
  and leaves the failure, with its Retry, on screen.
- FW2-2 (`JOB_READ_STALL_MS` = 2 x `JOB_POLL_MS` = 10 s, 57; `refreshJob`,
  307-337): a call while a job read is out waits for it only while that read
  is younger than the deadline (`Date.now()` from the read's send; a negative
  age - the clock went back - counts as stalled, 317); otherwise it sends a
  new read. The stalled read is not aborted: its answer, if it comes, is
  ordered by the same rules. An abandoned flight stops looping and never
  clears its successor (`cur.jobFlight === flight` in the loop condition and
  the finally). `refreshJob` now returns void (no caller used the promise).

Tests (`useAnchorRanking.test.tsx`, new block "useAnchorRanking - ordering,
round 2", 512-701; `held()` gained `reject`):

| Test (line) | Row | RED on the FW1 hook | Mutation (that row alone reverted) |
|---|---|---|---|
| 515 a NEW generation first seen finished, no more batches than the last, reads again | FW2-1 | `expected "spy" to be called 2 times, but got 1 times` (getRanking; the gen-2 done view showed, no full read) | RED, same message |
| 531 a press joining an unseen generation part-way reads again | FW2-1 | same message (getRanking) | RED, same message (see note 1) |
| 548 one generation's later-issued but behind view is dropped | FW2-5 | `expected [ +0 ] to deeply equal [ +0, 1 ]` ("1 of 3" replaced "2 of 3") | RED, same message |
| 579 a never-answering job read stops blocking after JOB_READ_STALL_MS | FW2-2 | `expected "spy" to be called 2 times, but got 1 times` (getRankingJob) | RED, same message |
| 598 a stalled read answering after its successor is dropped | FW2-2 | same message (getRankingJob) | RED, same message |
| 619 three overlapping reads answering 2, 1, 3 show 2 then 3, never 1 | FW2-3 | `expected 'initial' to be 'two'` | RED, same message |
| 663 GUARD: the latest read's failure stays when an earlier read answers after it | FW2-3 | passes (FW1 dropped every non-latest read) | RED with the naive FW2-3 (rows newer than the screen also clear the failure): `expected 'ready' to be 'error'` |

Note 1: the first version of test 531 had the joined generation AHEAD of the
one on screen (3 finished vs 2), so it went RED on the FW1 hook (whose press
never read) but passed with only FW2-1's count-from-zero reverted. Its
fixture now has gen-2 at 2 of 4 against gen-1's 4 of 4; re-run: RED on the
FW1 hook and RED with FW2-1 alone reverted.

GREEN: 29/29 in the file (22 earlier, unchanged, plus 7); the rankings
directory 117/117 (8 files).

### FW2-4 - the edit form's notes_stale hands its contact up - commit f9031818

- `dashboard/src/routes/contact/ContactEditForm.tsx`: new optional prop
  `onContactUpdated?: (current: Contact) => void` (docblock 158-163,
  destructured 176); the notes_stale branch calls
  `onContactUpdated?.(currentNotes)` (726) instead of `onStale?.()`, without
  closing the form. The `onStale` docblock (154-157) names
  contact_type_changed only; that branch is untouched.
- `dashboard/src/routes/contact/ContactDetail.tsx:1392`:
  `onContactUpdated={setContact}` (the Staff notes card's wiring). The
  comment on `rereadRetypedContact` (935-944) and at the form's props
  (1383-1391) no longer say notes_stale uses the re-read.
- Tests:
  - `ContactEditForm.test.tsx:2355` (replaces FW1-7's test): a notes_stale
    refusal calls `onContactUpdated` once with the 409's contact, never
    `onStale`, keeps the form open and the typed box; Cancel then closes
    with no save and no second PATCH. RED: `expected "spy" to be called 1
    times, but got 0 times`. The it.each comment above (2034-2039) now says
    only contact_type_changed calls onStale.
  - `ContactDetail.test.tsx:675` (R2-dashboard-6 inverted, page level):
    every read of the contact after the first is held; after the refusal
    the page shows THEIR notes at once with no read of its own; the second
    Save lands and the dialog closes on MINE; the held read is then answered
    with THEIR notes and the page still shows MINE; the reopened form's
    save sends MY stamp. RED: `Unable to find an element with the text:
    zztheirs notes` (the page waited on its held re-read).
- GREEN: form + page + Staff notes card files 320/320.

### FW2-6 - RUNBOOK spend sentence - commit e9138e36

`RUNBOOK.md:1844-1852`: "every paid call that returns to a live worker is a
run record or one of those two log lines. Two kinds leave neither: calls in
flight when the worker is killed (pointing at "A deploy (or any worker
restart) mid-ranking" and item 4 of `ranking-job-lifecycle-robustness`), and
an attempt the client timed out or lost the connection on, which the SDK
retries once inside the call (the API may still have processed and billed
it; no usage comes back; a call whose two attempts both timed out records a
cost of 0)". The weekly cost reads low by the logged calls and by those two
kinds. Checked against `adapters/ranking.ts:36,91` (maxRetries 1) and
`runLog.ts:100-107` (usage absent -> 0 tokens, cost 0). Docs only.

### FW2-7 - GLOSSARY fingerprint entry - commit e9138e36

`documentation/GLOSSARY.md:913-930`: besides a decline, a tour, a Notes edit
or a card-field edit, a fingerprint moves with time (the tenant card carries
the last-heard-from BUCKET - this week, this month, one to three months,
older, never - so a tenant's matches go out of date as 7, 30 and 90 days of
silence pass or when the tenant is heard from again after one of them;
`cards.ts:209-218, 297`) and with an organization-list edit that changes how
a property's housing authority names map (`cards.ts:157`; the tenant card
carries its housing authority as stored, unmapped - checked). Docs only.

## FILE rows - commit 14d35cec

- `docs/issues/ranking-job-lifecycle-robustness.md`: "Update (2026-10-29,
  ... round 2)" with item 5 (R2-server-2: a takeOver / claimQueued write that
  lands but throws starts no job; the press fails "stopped before it
  finished" about 90 s later with no model call; the claim spends the
  takeover; fix: re-read in the catch and start the job if it holds this
  pass's generation) and item 6 (R2-server-3: a stale lease is never taken
  over while each pass has queued work; fix: takeovers first). Frontmatter
  `updated` and refs (job.ts:613, :630, rankingRunsRepo.ts:330) added; refs
  re-verified at HEAD.
- New `docs/issues/notes-guard-double-click-overwrite.md` (bug, low):
  R2-dashboard-1, both Notes cards (edit form and Staff notes card), the
  settle-window or distinct-control fix, the inverted test.
- New `docs/issues/rankings-page-hook-edges.md` (bug, low): R2-dashboard-3
  (Rank stuck on "Starting..." after a window toggle away and back) and
  R2-dashboard-8 a/b (joined mark under Done; a stale view clearing the 409
  copy). Re-checked against the FW2 hook: all three still hold (the press
  early return :363, joined :371, the 409's wasLive :380).
- New `docs/issues/ranking-unlawful-flag-reason-source.md` (decision, med):
  Q1 / R2-server-1 with the mechanism and refs, both options ((a) the fixed
  sentence only, recommended; (b) keep spec D10), why the narrower
  unknown-only variant is unsafe, the test that pins today's order
  (rankingFlags.test.ts:67-88), and the test for (a). Code unchanged.
- `npm run issues` indexes all four (459 open); no frontmatter error.

## Suites and gates

- Dashboard workspace `cd dashboard && npx vitest run` (foreground): exit 0
  - 282 files, 5798 tests passed (FW1: 5790; +7 hook tests, +1 page test;
  the form test was replaced), 61.8 s.
- `npm run typecheck` (root, bare): exit 0 (after the hook commit and again
  after the last code commit).
- ESLint on every .ts / .tsx the wave touched (`git diff --name-only
  --diff-filter=d 2729e299..HEAD`, 6 files): exit 0, no output.
- ASCII: 0 non-ASCII bytes in the added lines of `git diff -U0
  2729e299..HEAD` and in the wave's commit messages.
- e2e (lane 7, foreground, one at a time, after `session.pid` was confirmed
  absent and no listener on 9701 / 9711 / 9721 / 9731):
  - `npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/rankings.spec.ts`:
    exit 0, 5 passed (13.1 s).
  - A stale `session.pid` (45428) remained, no listener: `npm run e2e:stop`
    ("no running session found; retained state is stale or absent").
  - `npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/contact-notes-conflict.spec.ts`:
    exit 0, 1 passed (11.0 s).
  - `npm run e2e:stop` again (same message); no listener on the lane's
    ports afterwards; tree clean.
- Not run (orchestrator gates): root `npm test`, `npm run smoke`, the full
  e2e suite.

## Interpretations and deviations

1. FW2-1 reads the ranking for a new generation when its view has a finished
   batch or has ended - spec D12's two triggers (growth, end), measured from
   zero for a new generation. A new generation first seen queued, or running
   with no finished batch, reads nothing yet (nothing new to read; the next
   growth or the end reads it), which keeps the pinned "a fresh press reads
   nothing more" test green. The rule also covers the press's 202 (the header
   counts it as a job view): a joined press of an unseen generation part-way
   reads the ranking (R2-dashboard-2's "milder form").
2. FW2-5's order has one tier beyond the row's text: after finished batches,
   the pool built (batchCount), so "Ranking..." never replaces "Ranking: 0 of
   3 batches finished". Level views fall back to FW1's issue order.
3. FW2-3 keeps the latest-only rule for failures and adds `failedIssued`, so
   an earlier read cannot hide the latest read's failure (or Retry's loading
   state) behind an older table - the literal rule would put the A2-1
   symptom back by the error path. Guard test 663.
4. FW2-2 measures the deadline with `Date.now()` per read (the hook test's
   fake timers advance it; the suite's pinned Date never stalls a flight, so
   the panel and section tests behave as before).
5. `Current.jobGeneration` and `seenBatches` were removed as redundant with
   `jobView` (same values, one source).
6. FW2-7: R2-server-5 also named "the RUNBOOK's out-of-date list"; the
   RUNBOOK makes no "only edits move it" claim, so only the glossary changed.

## Questions

None. Every FIX row reproduced (each regression test RED on the FW1 code for
the finding's reason) and was applied as adjudicated. Q1 is filed, not acted
on.

## Commits

- 20e7305f fix(rankings page): a new generation counts from zero; one generation's views never step back; a stalled job read stops blocking; a newer full read shows (FW2-1, FW2-2, FW2-3, FW2-5)
- f9031818 fix(contact edit): a notes_stale refusal hands its current contact to the page instead of a re-read (FW2-4)
- e9138e36 docs: B2a code review R2 doc fixes (FW2-6, FW2-7)
- 14d35cec docs(issues): file the B2a code review R2 out-of-scope findings (FILE rows)
- this report (docs(records))
