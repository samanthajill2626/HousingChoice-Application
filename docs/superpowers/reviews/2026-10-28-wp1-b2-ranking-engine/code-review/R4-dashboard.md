# R4-dashboard - fresh code re-review (round 4), fix wave FW3 and the Rankings page hook

- Reviewer: R4-dashboard (Claude Opus 5.5), 2026-10-29. Fresh; rounds 1-3
  and the fix waves read as claims only.
- Branch: feat/wp1-b2-ranking-engine @ 3671faa0 (base main @ 404e039d); fix
  wave FW3 = 4ce4746d..3671faa0 (`.superpowers/review/pkg-fw3.diff`).
- Area: dashboard/src/routes/settings/rankings/useAnchorRanking.ts as it now
  stands (FW3-1, FW3-2, FW3-3), its test file (the FW3-1, FW3-2 and FW3-4
  tests), the FW3 append to docs/issues/rankings-page-hook-edges.md, and the
  residual the FW3 report left unfiled (N1).
- Read: the brief (BRIEF-rereviewer.md) with the round-4 specifics;
  R2-adjudications.md (loop rule), R3-dashboard.md, R3-adjudications.md,
  FW3-report.md; the FW3 diff in full; at HEAD in full: useAnchorRanking.ts,
  useAnchorRanking.test.tsx, rankingFormat.ts (status copy, isJobLive,
  finishedBatchCount), RankAnchorPanel.tsx (Rank enablement, the status
  line), api/useEventStream.ts; the hook at 0e136b67 (before the review),
  21fe22b3 (FW1) and 20e7305f (FW2); the server facts the hook and its
  comments rest on: job.ts (claimRanking, jobView's derived `expired`,
  runJob's events, runDueRankings), rankingRunsRepo.ts (claimQueued,
  markExpiredQueued, takeOver), readRanking.ts (read order),
  routes/rankings.ts (when each route takes `now`).
- Proof (throwaways deleted, tree clean): one throwaway hook test
  `dashboard/src/zz-review-r4-hook.test.tsx` (probes P1, P1b, P3, P4, P5).
  Hook versions and one-line mutants copied OUTSIDE the worktree (session
  scratchpad, `r4/`, imports made absolute) and aliased by a throwaway vitest
  config: head, pre (0e136b67), fw1 (21fe22b3), fw2 (20e7305f), mA (FW3-1
  reverted), mB (FW3-2 reverted), mD and mE (FW3-4's two mutants), nogate
  (R4-dashboard-1's fix), leftlive (R4-dashboard-2's fix), both. Spec and
  plan not opened.
- Verdict: no CRITICAL, HIGH or MEDIUM. FW3-1 .. FW3-4 are real (each
  row's mutant turns exactly that row's new tests RED; the FW3-1 and FW3-2
  tests are RED on the FW2 hook, the FW3-4 pins green there) and FW3's
  rewritten comments are exact. The residual the FW3
  report left to the orchestrator (N1) is real (R4-dashboard-1, LOW,
  CONFIRMED): it is R3-dashboard-2's second press, which FW3-2 does not cover
  because FW1's press gate still discards a join's running view while
  `expired` is on screen; dropping the gate is one line and breaks nothing
  (123/123). Round 3 missed one pre-existing LOW (R4-dashboard-2): a followed
  generation replaced by a new LIVE generation never counts as ended, so its
  last batches are not read and the joined mark moves to the new job. Two
  INFO.
- Counts: CRITICAL 0, HIGH 0, MEDIUM 0, LOW 2, INFO 2.

## 1. NEW findings (round 3 missed)

### R4-dashboard-2 - LOW - CONFIRMED - NOT A REGRESSION - a followed generation replaced by a new LIVE generation never counts as ended: its unseen last batches are not read, and the joined mark moves to the new job

- Where: dashboard/src/routes/settings/rankings/useAnchorRanking.ts:232-236
  (`grew` counts a new generation from zero; `ended` needs the NEW view not
  live), :242 (`followedEnded`, the same condition on the press marks), :397
  (`joined` from the press); RankAnchorPanel.tsx:183-184 (the status line and
  its "(joined ...)" suffix).
- What happens: the page follows gen-1 (live on screen, so `wasLive`). gen-1
  finishes its last batch or batches and ends, and before the page's next job
  read is served another actor's press claims gen-2 (a press can claim only
  once gen-1 has ended: job.ts:178-185, :211-223). That read shows gen-2
  queued: a new generation with nothing finished (`grew` false) that is live
  (`ended` and `followedEnded` false). Nothing reads the full ranking for
  gen-1's tail, and a joined mark from this page's press on gen-1 stays:
  "Waiting for a free slot (joined the ranking already running)". The table
  catches up at gen-2's first finished batch or at its end (a queued gen-2
  waits while every slot is busy, up to RANKING_QUEUE_EXPIRY_MS, after which
  its `expired` view ends it and reads); the joined mark clears when gen-2
  ends. A worker takeover (a new generation replacing a live one) takes the
  same path; nothing of the old generation is unread there, only the mark
  carries.
- Reproduced: probe P3 - a press joins gen-1 running 1 of 2 (one full read
  for the finished batch); one event; the job read answers gen-2 queued -> at
  HEAD the full-read count stays 2 and the line reads "Waiting for a free
  slot (joined the ranking already running)". The same on the FW1 hook and on
  the hook before the review (0e136b67), so no fix wave introduced it.
- Why it matters: LOW. The window is the event's read latency after gen-1
  ends (sub-second) while events arrive, or one 5 s poll interval while they
  do not (two admins, or two tabs, on one anchor). The table stays one or
  more batches behind until gen-2 progresses, under a line that says a new
  ranking is waiting. It is A2-1's class (a table older than the job shown)
  by a path FW2-1 left out: FW2-1's adjudicated text says a view of another
  generation "counts as a change: read the full ranking"
  (R2-adjudications.md:19), while the code counts the new generation's
  batches from zero and its end - which reads nothing for a LIVE new
  generation with no batch finished.
- Smallest fix (for the filed issue): count a live view on screen replaced
  by another generation as the followed job's end, for the read and for the
  marks: `const leftLive = newGeneration && shown !== null &&
  isJobLive(shown.status);`, then `ended = leftLive || (...as now...)` and
  `followedEnded = leftLive || (...as now...)`. Keyed on the view on screen,
  not on `wasLive`, so a 409's forced follow keeps its copy when the job the
  409 named first appears (test :258 stays green). Verified on a scratch copy
  of the hook: P3 green (one more full read, no joined mark), rankings
  directory 123/123.
- Class: NOT A REGRESSION (the hook before the review behaves the same).
  FILE: append to `rankings-page-hook-edges` as a new item.
- Test: P3 as written - a joined press on gen-1 part-way, then an event whose
  job read answers gen-2 queued -> one more full read, `joined` false.

### R4-dashboard-3 - INFO - CONFIRMED - NOT A REGRESSION - item 3 of rankings-page-hook-edges has a second path: the first read (or Retry), issued before a press refused 409, clears the 409 copy while the job it named runs

- Where: useAnchorRanking.ts:242 (`followedEnded` reads the `wasLive` the 409
  forced at :406), :262 (the first read and Retry offer their job with the
  number they took when sent).
- What happens: the first read R is out; the admin presses (Rank is enabled
  while it loads); the press is refused 409 (a live job of the other window
  exists). R took its job snapshot before that job was claimed and lands
  after the 409 with the previous generation's end. It is the first view, so
  it is applied, and because the 409 forced `wasLive` it clears "A ranking is
  running for this record. Try again when it finishes." The follow-up job
  read then shows the named job running, without the copy.
- Reproduced: probe P5 - held first read and held follow-up job read; the
  409; release R with gen-1 done -> `rankError` null; release the job read
  with gen-2 running -> still null. The same on the FW1 hook.
- Why it matters: INFO - the status line shows the job running and Rank is
  disabled, so the lost copy says nothing the page does not; same class and
  cost as item 3.
- Fix: none of its own. Item 3's suggested fix (remember the 409 press's
  issue number; only a view issued after it clears the copy) covers this path
  too, since R was issued before the press. Add one sentence to item 3 when
  the issue is next touched.

### R4-dashboard-4 - INFO - CONFIRMED - NOT A REGRESSION (FW2 wording, outside FW3-3's scope) - two comments still state a rule the code no longer follows

- useAnchorRanking.ts:259-261 (loadRead): its job is "never over a press or a
  job read issued after this read (A2-2)". Since FW2-5 a read's view of the
  generation on screen that is AHEAD of it is applied over both. Probe P4: a
  press answers gen-2 queued; the first read, issued before the press, lands
  with gen-2 running -> applied (on FW1 it was dropped). The code is right
  (the read's snapshot is newer); the sentence should read "never over a view
  of another generation from a press or a job read issued after this read;
  never behind the view on screen".
- :36, :229, :388: "a generation the page has not shown" / "had not shown".
  The code tests "another generation than the one on screen"
  (`!sameGeneration`, :219, :232), so a generation shown earlier and since
  replaced (item 4's order b) also counts from zero and its end counts. Say
  "a generation other than the one on screen".
- Optional, FW3's own docblock and exact as written: jobProgress (:137-138)
  calls `expired` "level with queued, not an end" - true of the order;
  elsewhere the hook still treats it as not live (one full read, the press
  marks clear, no poll). A clause would stop a reader taking "not an end" as
  "followed".

## 2. Defects in the fix diff

### R4-dashboard-1 - LOW - CONFIRMED - REGRESSION (R3-dashboard-2 left incomplete; the mechanism is FW1's press gate) - a press that joins the generation on screen while it reads `expired` is discarded: the page stays on "not picked up ... (joined the ranking already running)" with no poll

The FW3 report's residual N1 (FW3-report.md:168-178), which the round-4
brief asks this review to judge.

- Where: useAnchorRanking.ts:396 (the press gate: a press's job of the
  generation on screen is never offered to applyJob), :361-367 (the poll runs
  only while the view on screen is live), :140 (FW3-2: running is now ahead of
  expired, so a job READ's running view is applied); RankAnchorPanel.tsx:160
  (Rank stays enabled under `expired`), :183-184; rankingFormat.ts:143-144
  ("The ranking was not picked up. Press Rank again."). Server: job.ts:604
  and :617 with rankingRunsRepo.ts:309 (a tick that started before the expiry
  claims after it), job.ts:211-223 (a press on a running record of the same
  window JOINS it), job.ts:416 (the first event after a claim is the
  pool-built one; there is none at the claim).
- What happens: a straddled expiry (R3-dashboard-2) puts `expired` on screen
  and the page stops polling. The copy says "Press Rank again"; the admin
  does, and the press joins the generation the tick just claimed. Its answer
  (running) is of the generation on screen, so the gate drops it and only
  `joined: true` lands: "The ranking was not picked up. Press Rank again.
  (joined the ranking already running)", with Rank still enabled. FW3-2 lets
  the next job READ's running view through, so while events arrive the page
  recovers at the pool-built event's read; without them nothing reads the job
  again, and the page keeps that line and a table read before the job's
  batches until a reload or a press after the job ends (each re-press joins
  again, with the same result).
- Reproduced: probe P1 (press gen-1 queued; the poll reads `expired`; a
  second press joins gen-1 running 1 of 2; no events; 15 s) - at HEAD the
  status stays `expired`, with no job read and no full read after the join.
  Probe P1b (the same, then one event) - the line is wrong until the event's
  read, then "Ranking: 0 of 2 batches finished (joined the ranking already
  running)". Across hooks: FW1 identical to HEAD (P1 red, P1b green); FW2
  worse (both red - R3-dashboard-2); the hook before the review green on both
  (it applied every press's job) - the gate came with FW1-5 (21fe22b3, A2-2's
  fix).
- Why it matters: LOW - it needs R3-dashboard-2's straddle (a job queued for
  the whole 10 minutes, a page job read inside the claiming tick's straddle)
  and then a press before the pool-built event's read (the wrong line is then
  transient) or lost events (then it lasts until a reload). But the page's
  own copy asks for the very press that triggers it, and when the bridge
  drops events the press's answer is the only fresh view the page receives -
  the gate throws it away.
- Class: R3-dashboard-2's text names this press and this line
  (R3-dashboard.md:152-155), and the FW3 report says FW3-2 does not fix it, so
  under the loop rule it is an R3 finding FW3 left incomplete - a REGRESSION.
  FW3 did not introduce it: HEAD behaves exactly as FW1 here. If the
  orchestrator reads R3-dashboard-2 as scoped to FW2-5's ranking (as its
  adjudicated test was), it is NOT A REGRESSION and files as a new item of
  `rankings-page-hook-edges` with the fix below. Recommended: fix - one line,
  verified, and it removes a gate FW2-5's ordering made redundant.
- Smallest fix: :396 `const change = applyJob(cur, res.job, issue());` -
  every press's job goes through the order rules. Of another generation it is
  applied as now (the newest number). Of the generation on screen it is
  applied unless it is behind (FW2-5's order), so a fresh press's claim record
  never steps a newer view back - the gate's purpose - and a join's newer view
  is taken. Rewrite the header bullet :31-35 and the press comment :383-395
  (both shrink: no "never applied, whatever its progress", no join caveat).
  Verified on a scratch copy: P1 and P1b green (running 1 of 2 at once, the
  poll resumes, a full read for the join's finished batch), rankings
  directory 123/123; with R4-dashboard-2's fix as well, 127/127 with the
  probes.
- Test: P1 into the hook file - press (gen-1 queued); the poll reads
  `expired`; a second press joins gen-1 running 1 of 2; no events -> status
  `running`, the next JOB_POLL_MS reads the job, `getRanking` called once
  more. RED at HEAD, GREEN with the gate dropped.

Nothing else in the FW3 diff is defective. FW3-1 restores FW1's clearing
rule exactly (`followedEnded` is FW1's `ended`, computed before `wasLive`
moves, :242 then :245) and keeps FW2-1's wider `ended` for the read only.
FW3-2's level tier is the one R3-dashboard-2 proposed with eyes open
("issue order, as in FW1"); its one new interleaving is in Swept and fine.
FW3-3's sentences each match the code (section 4). The FW3-4 tests pin what
they claim. The issue append is accurate.

## 3. Adjudication challenges

- FW3-3 (from R3-dashboard-4) took the press gate as wording only.
  R3-dashboard-4 costed the gate at "at most one poll (that view is live, so
  the poll runs)" (R3-dashboard.md:185-186). That premise is false in the one
  state FW3-2 made a supported mid-generation state: `expired` on screen is
  not live, so nothing polls (R4-dashboard-1). Revisit as a code fix;
  R3-dashboard-4 already named it ("drop the gate at :370 and let applyJob
  order the press's view").
- FW2-1's adjudicated fix text ("counts as a change: read the full ranking",
  R2-adjudications.md:19) was implemented narrower (from zero; its end
  counts). That is right for R2-dashboard-2's case, and R3 verified it; the
  literal text would also have covered R4-dashboard-2's table half. Not a
  reopen - context for that FILE.
- Upheld: R3's FILE of R3-dashboard-3 (item 4) - FW3 changed no
  cross-generation rule; R2's FILE of items 1-3 - all three still hold at HEAD
  (item 3 by a second path, R4-dashboard-3); FW3-2's level tier for
  expired / queued (see Swept and fine).

## 4. Fix verification (my rows)

| Row | Verdict | Evidence |
|---|---|---|
| FW3-1 (R3-dashboard-1) | REAL | mA (only :246 back to `ended`): exactly the three FW3-1 tests RED (:712 x2 "expected null to be 'Too many rankings...'" and "'The ranking could not be started...'", :736 the same 429 copy). The FW2 hook: the same three RED. HEAD green. A2-8's own tests (:456, :472, :490) green at HEAD: a joined press's own view sets `wasLive`, a 409 forces it (:406), and both still clear on the followed job's end. |
| FW3-2 (R3-dashboard-2) | REAL for job-read views; a press's view is not covered (R4-dashboard-1) | mB (only :140 back): exactly :759 RED ("expected { status: 'expired' } to match object { status: 'running' }"). The FW2 hook: RED. HEAD green. |
| FW3-3 (R3-dashboard-4) | REAL | Each sentence of the header (:14-17 issue numbers; :23-30 the sources and the order; :31-35 a press offered only for another generation, then the newest number; :39-42 the marks), the `wasLive` docblock (:121-124), applyJob's comments (:228-231, :237-241) and the press comment (:383-395) checked against the code and the server's claim (job.ts:211-223). The press comment's "the poll's, while the view on screen is live, or an event's" is exactly R4-dashboard-1's mechanism. Two older comments FW3-3 did not own: R4-dashboard-4. |
| FW3-4 (R3-dashboard-5) | REAL (pins) | mD (the pool-built tier -> 0): only :790 RED. mE (`age >= 0 &&` removed): only :816 RED ("expected spy to be called 2 times, but got 1 times"). Both green on the FW2 hook, as pins of FW2 behavior should be. |
| FILE (R3-dashboard-3, item 4) | Accurate | Refs checked at HEAD: useAnchorRanking.ts:225-226 and :262; readRanking.ts:357 then :365; job.ts:194 (the claim stamps requestedAt); rankingRunsRepo.ts:334 (takeOver keeps requestedAt and moves startedAt). Items 1-3's re-pointed refs (:382, :211, :200, :397, :406) match HEAD; the new title and `updated:` are well formed and ASCII. |

## Swept and fine

- FW3-1 against every A2-8 case: messages set while the page follows no job
  (429, 404, network error) now stay until the next press or the end of a job
  the page later follows - FW1's rule. The reused-slice carry-over this
  re-exposes (FW3 report, interpretation 3) is item 1's own text ("A stale
  `rankError` or `joined` carries over the same way").
- FW3-2's tier, the next view of an `expired` generation: `failed` (the poll
  pass's mark and its event, job.ts:604-606) or `running` (a straddling claim)
  - both ahead now, so applied; `failed` reads nothing more (the page no
  longer follows; nothing ran). A later-issued `queued` view can replace
  `expired` (one poll of "Waiting for a free slot", one extra full read) only
  if the later-issued request reached the server first: the job route derives
  `expired` from its time after reading the record (routes/rankings.ts:152),
  the read from its start (:166). Not worth a fourth stage.
- First read vs a press: a press's job of another generation takes the newest
  number, so an earlier read's view of another generation is dropped; a view
  of the same generation is ordered by progress (P4: a newer one is applied -
  right, the comment aside).
- Job reads: polled every 5 s only while the view on screen is live
  (:361-367); events, the poll and a 409's follow-up share one flight; the
  stall rule and its negative-age branch (now pinned) unchanged by FW3.
- Full reads: `ended` is FW2's, unchanged (FW3-1 moved only the marks off it,
  :242); a generation first seen ended still reads once (:736, RED under the
  FW3 report's mC); growth reads unchanged.
- Anchor or window change and unmount: untouched by FW3; old answers are
  dropped behind `currentRef`, reads aborted with the controller.
- The server facts FW3's comments cite: the derived `expired`
  (job.ts:246-255); one `nowIso` per tick for both the due list and
  claimQueued's `#qexp > :now` (job.ts:589-617, rankingRunsRepo.ts:309); a
  fresh press answers the claim record, a join a consistent read of the live
  record, a queued record past its expiry is reclaimed, never joined
  (job.ts:178-185, :211-223).
- Gates on the FW3 files: eslint on useAnchorRanking.ts and its test exit 0;
  dashboard `tsc -p tsconfig.json --noEmit` exit 0; 0 non-ASCII characters in
  the added lines and the commit messages of 4ce4746d..3671faa0; rankings
  directory 8 files, 123/123 at HEAD.
