# R3-dashboard - fresh code re-review (round 3), the Rankings page hook, the Rankings page, the edit form's notes_stale hand-up

- Reviewer: R3-dashboard (Claude Opus 5.5), 2026-10-29. Fresh; rounds 1-2
  and both fix waves read as claims only.
- Branch: feat/wp1-b2-ranking-engine @ 432c0a1f (base main @ 404e039d); fix
  wave FW2 = 2729e299..432c0a1f (`.superpowers/review/pkg-fw2.diff`).
- Area: dashboard/src/routes/settings/rankings/useAnchorRanking.ts (FW2-1,
  FW2-2, FW2-3, FW2-5), RankAnchorPanel.tsx and the rest of the Rankings page,
  the edit form's notes_stale hand-up (ContactEditForm.tsx / ContactDetail.tsx,
  FW2-4), the FW2 doc changes (RUNBOOK FW2-6, GLOSSARY FW2-7) and the FW2
  issue files.
- Read: the brief; R2-adjudications.md (loop rule), R2-dashboard.md,
  FW2-report.md; the FW2 diff in full; at HEAD in full: useAnchorRanking.ts
  and its test, RankAnchorPanel.tsx, RankingsSection.tsx, RankingRunDetail.tsx,
  RankingRunList.tsx, RankingTable.tsx, rankingFormat.ts, useRankingRuns.ts,
  useRankCandidates.ts, ContactEditForm.tsx (state, save flow, render of the
  Notes box), ContactDetail.tsx (contact state, the form wiring, the per-contact
  reset effect), useContact.ts, StaffNotesCard.tsx; the API types; server
  readers and writers the hook's rules depend on: job.ts (claim, jobView's
  derived `expired`, runJob, the poll pass), rankingRunsRepo.ts (claimQueued,
  takeOver, markExpiredQueued conditions), readRanking.ts (read order),
  routes/rankings.ts (press, job read, read), jobs/pollLoop.ts (tick now),
  routes/contacts.ts (the guarded PATCH's 409 body, the contact.updated emit),
  adapters/ranking.ts and runLog.ts (FW2-6), cards.ts (FW2-7), config.ts
  (rank rate limit, queue expiry, lease); the four FW2 issue files; the
  notes-conflict e2e spec.
- Proof (all throwaways deleted, tree clean): one throwaway hook test
  `dashboard/src/zz-review-r3-hook.test.tsx` (probes P1a, P1b, P2, P3).
  Mutants copied OUTSIDE the worktree (session scratch dir) and aliased by a
  throwaway vitest config: the FW1 hook (2729e299), the HEAD hook, one mutant
  per FW2 hook row with only that row reverted (m21, m22, m23, m25), two
  mutants for untested FW2 details, a "fixed" hook carrying the two fixes
  proposed below, and the edit form with FW1-7's mechanism (onStale instead of
  onContactUpdated). Spec/plan not opened.
- Verdict: no CRITICAL, HIGH or MEDIUM. FW2-1 .. FW2-5 fix what they were
  asked (re-run here: every new test is RED on the FW1 code and RED with only
  its own row reverted; FW2-4's two tests are RED on the FW1-7 mechanism).
  FW2 adds two LOW regressions in the hook: FW2-1's broadened "the job ended"
  also drives A2-8's clearing, so a refused press's own message (429, network
  error) is wiped when the first view of an old finished job lands; and
  FW2-5 ranks the server's DERIVED `expired` as an end, so a job claimed on a
  tick that straddled its expiry is never followed. Both have a one- or
  two-line fix, verified against the whole hook, panel and section suites
  (62/62 with the probes). Round 2 missed one LOW: R2-dashboard-7's late
  snapshot also exists ACROSS generations, where FW2-5 kept issue order. The
  edit form's hand-up (FW2-4) is clean: it resets nothing in the open form,
  leaves an open Staff notes edit alone, and adds no race with the page's SSE
  re-read. The FW2 docs and issue files are accurate at HEAD.
- Counts: CRITICAL 0, HIGH 0, MEDIUM 0, LOW 3, INFO 2.

## 1. NEW findings (round 2 missed)

### R3-dashboard-3 - LOW - CONFIRMED - NOT A REGRESSION - the adopting read's late job snapshot still loses to issue order ACROSS generations: the page can show the old job's end, stop polling, and wait on events while a new generation runs

- Where: dashboard/src/routes/settings/rankings/useAnchorRanking.ts:211-212
  (a view of another generation: issue order only), :243 (the first read and
  Retry offer their job with the issue number they took when SENT);
  app/src/services/ranking/readRanking.ts:357 then :365 (the read assembles the
  pool and cards first, then reads the job).
- What happens: FW2-5 closed R2-dashboard-7 within one generation. Across
  generations the same late snapshot still loses, in both landing orders.
  (a) The first read (or Retry) R is out. A job read J, issued after R, is
  served at once with the previous generation's end (gen-1 done) and applied.
  Another actor - a second admin or tab pressing Rank, or the worker's takeover
  - creates gen-2 before R takes its job snapshot. R lands with gen-2 and is
  dropped (issued before J). (b) R lands first with gen-2; J then lands with
  gen-1 done and is applied over it (issued after R). Either way the page shows
  gen-1 "Done", does not poll (the shown job is not live), counts gen-1's
  stale view as "ended" (one full read, the press marks cleared), and learns
  of gen-2 only from its next ranking.updated event. If those events are lost
  (the bridge is best-effort), it keeps the old Done line and a table read
  before gen-2's batches - A2-1's "stale table under Done" - until a reload
  or a press.
- Reproduced: probe P3 (order a): held first read; one event -> job read
  answers gen-1 done; release the first read with gen-2 running ->
  `job.generation` stays 'gen-1'. Same result on the FW1 hook (pre-existing).
- Why it matters: LOW. It needs a generation change inside the first read's
  assembly plus a job read in that window, and events normally correct it
  within a batch; but when they do not, the page sits on a finished job and an
  old table with no poll to rescue it.
- Smallest fix (for the filed issue): order generations by the record, not by
  issue order. A claim stamps `requestedAt` (job.ts:194) and a takeover keeps
  it and moves `startedAt` (rankingRunsRepo.ts:334), so a view of another
  generation is newer when (requestedAt, startedAt) is later; keep issue order
  as the tie-break and for a null view. (The hook test fixtures give every
  generation one requestedAt, so the tie-break is load-bearing there.)
- Class: NOT A REGRESSION (FW1 behaves the same; the R2 adjudication scoped
  FW2-5 to one generation). FILE: append to `rankings-page-hook-edges`.
- Test: P3 inverted, and order (b): the read with gen-2 lands first, the job
  read with gen-1 done second -> gen-2 stays and the poll keeps running.

## 2. Defects in the fix diff

### R3-dashboard-1 - LOW - CONFIRMED - REGRESSION (FW2-1) - a refused press's own message (429, network error) is wiped when the first view of an old finished job lands

- Where: useAnchorRanking.ts:217 (`newGeneration` is true for the FIRST view
  the page applies, `shown === null`), :221 (`ended = (cur.wasLive ||
  newGeneration) && ...`), :227 (the same `ended` clears `rankError` and
  `joined`); the comment above it, :225-226, still says those marks "speak of
  the job the press followed"; the refused-press path :373-383 (a 429, 404 or
  network error sets `rankError` and follows no job - only a 409 sets
  `wasLive`, :380); RankAnchorPanel.tsx:160 (Rank is enabled while the first
  read loads - no job, not ranking) and :176-180 (the alert).
- What happens: an admin picks an anchor (or reloads with it in the URL) and
  presses Rank before the first read answers. The press is refused 429 ("Too
  many rankings. Wait a minute and try again." - 6 presses per user per
  minute, app/src/lib/config.ts:835) or fails on the network ("The ranking
  could not be started. Try again."). The first read then lands with the
  anchor's previous, finished job: it is the first view applied, so it is a
  "new generation", so its end counts as "the job ended", and the message is
  cleared. The panel shows the old "Done: ..." line, no alert, Rank enabled:
  the refused press looks as if it did nothing. The same happens when the
  first view is a job read that finds someone else's generation already
  finished. FW1 kept the message (`ended` needed `wasLive`).
- Reproduced: probes P1a (429) and P1b (network error): held first read; the
  press is refused; release the first read with a done job -> at HEAD
  `rankError` is null; on the FW1 hook (mutant alias) the message stays.
- Why it matters: LOW - copy only, and a second press shows it again. But it
  is A2-8's rule misapplied by FW2-1 (FW2-1's row asked for a full read on a
  new generation, not for clearing press marks), and the comment at :225-226
  no longer describes the code.
- Smallest fix: keep FW2-1's `ended` for the full read only; clear the press
  marks on the FOLLOWED job's end - FW1's rule, computed before `wasLive` is
  overwritten:
  `const followedEnded = cur.wasLive && (next === null || !isJobLive(next.status));`
  then `...(followedEnded && { rankError: null, joined: false })`. A joined
  press (its own live view at :370) and a 409 (:380) both set `wasLive`, so
  every A2-8 case still clears. Verified on a scratch copy of the hook with
  this fix and R3-dashboard-2's: the hook file's 29 tests, RankAnchorPanel and
  RankingsSection tests and the probes all pass (62/62). (The filed item 3 of
  `rankings-page-hook-edges` - a stale view clearing a 409's copy - is a
  different path; its suggested fix does not cover this one.)
- Test: P1a inverted into the hook file - a held first read, a 429 press, the
  read released with a done job -> the 429 copy is still shown.

### R3-dashboard-2 - LOW - CONFIRMED - REGRESSION (FW2-5) - FW2-5 ranks the server's derived `expired` as an end, but the same generation can be claimed and run after it: the page then drops every running view and shows "not picked up" while the job runs

- Where: useAnchorRanking.ts:126 (`stage`: queued 0, running 1, anything else
  2 - `expired` sits with done and failed), :206-210 (a view of the generation
  on screen that is behind it is dropped). Server: job.ts:251-256 (`expired`
  is DERIVED on read for a queued record past `queuedExpiresAt`, with the
  request's now); jobs/pollLoop.ts:63-72 and job.ts:596-617 (a tick takes
  `nowIso` once at its start, picks due records by it and claims with it);
  rankingRunsRepo.ts:309 (claimQueued's condition `#qexp > :now` uses that
  tick-start time). A tick that starts just before a record's expiry claims it
  just after; a job read served in between reads `expired`; then the SAME
  generation runs.
- What happens: the page, polling its queued press, applies `expired`
  (stage 2) and stops polling (not live). The claim lands; from then on every
  `running` view of that generation is behind (1 < 2) and dropped - before
  `grew` is computed, so no per-batch full read either. The panel says "The
  ranking was not picked up. Press Rank again." while the job runs. A second
  press joins it (same window); its view is the generation on screen, so it is
  never applied (:370) and only `joined: true` lands - "... not picked up.
  Press Rank again. (joined the ranking already running)". The `done` view is
  ahead (finished > 0) and finally applies with one full read. FW1 applied the
  running views (issue order).
- Reproduced: probe P2 - press (gen-1 queued); the poll reads `expired`; two
  events read `running` 0 of 2 then 1 of 2. At HEAD the status stays
  `expired`, no batch read, no poll; on the FW1 hook `running`, one full read
  per change, the poll resumes.
- Why it matters: LOW - it needs a job queued for the whole
  RANKING_QUEUE_EXPIRY_MS (10 minutes, both slots busy) and a page read inside
  the tick's straddle (tens to hundreds of ms; more with app/worker clock
  skew). But it is new behavior of FW2-5's rule; the adjudication's row lists
  only "queued < running < done / failed".
- Smallest fix: rank `expired` with `queued` - it is a queued record read past
  its expiry: `const stage = view.status === 'queued' || view.status ===
  'expired' ? 0 : view.status === 'running' ? 1 : 2;`. A running or failed
  view after it is then ahead; queued and expired views are level and fall
  back to issue order, as in FW1. Verified with R3-dashboard-1's fix (62/62).
- Test: P2 inverted (as written above, it passes on the fixed copy).

### R3-dashboard-4 - INFO - CONFIRMED (by reading) - NOT A REGRESSION (FW1 wording kept by FW2's rewrite) - the header and the press comment overstate what the press path does

- :14-16 "every request takes an issue number when it is sent": a press takes
  its number when its 202 is ANSWERED (:370), as the press comment itself
  says (:366-367).
- :22-30 says a job view "from ... a press" of the generation on screen is
  applied when not behind; the press path never offers such a view to
  applyJob (:370), whatever its progress. Its comment's premise (:364-366, "a
  job read already shows this generation - read after the claim, so as new or
  newer") is false for a JOIN: the joined generation existed before the press,
  so the view on screen can predate the claim's read (queued on screen, the
  202 says running 2 of 4). Today's cost is at most one poll (that view is
  live, so the poll runs). With FW2-5 in place the gate is unnecessary:
  passing every press view through applyJob would apply it exactly when ahead.
- :225-226 vs :221: see R3-dashboard-1.
- Fix: the wording, in the same change as R3-dashboard-1 (or drop the gate at
  :370 and let applyJob order the press's view).

### R3-dashboard-5 - INFO - CONFIRMED - fix-diff test gap (FW2-5, FW2-2); no behavior is wrong, so NOT A REGRESSION - two FW2 details are pinned by no test

- FW2-5's third tier (`view.batchCount`, the pool built, :127): replacing it
  with 0 leaves all 117 rankings-directory tests green (mutant run here).
- FW2-2's "a negative age counts as stalled" (`age >= 0`, :317): removing it
  leaves all 117 green.
- Tests: a same-generation running view with batchCount 0 landing after one
  with batchCount 3 is dropped ("Ranking..." never replaces "Ranking: 0 of 3
  batches finished"); a flight whose `since` lies in the future
  (vi.setSystemTime back) does not hold the next job read.

## 3. Adjudication challenges

- FW2-5's scope ("across generations keep the issue-order rule"): the late
  snapshot R2-dashboard-7 named is not confined to one generation
  (R3-dashboard-3, both landing orders). Agree it is LOW and FILE under the
  loop rule; the reason for keeping issue order across generations (A2-2: a
  read issued before a press never replaces the press's job) is also met by
  ordering generations by the record's (requestedAt, startedAt).
- The R2 FILE of R2-dashboard-8 b (item 3 of `rankings-page-hook-edges`) still
  holds at HEAD; R3-dashboard-1 is a new path of the same "press message
  cleared by a view of another job" class, introduced by FW2-1, so it is a FIX
  under the loop rule, not an addition to that issue.
- R2-server-7 NOTE ("the page's 5 s job poll recovers" a skipped done event):
  true while the page shows the job live; not in R3-dashboard-3's state (an
  older generation's end on screen, no poll). Agree with NOTE.
- Upheld: notes-guard-double-click-overwrite (FILE, low) - the hole is in the
  branch's own pre-review guard code, so pre-existing for the loop rule; the
  FW2-4 choice (hand the 409 contact up) - verified below; FW2-6 / FW2-7 as
  docs-only.

## 4. Fix verification (my rows)

| Row | Verdict | Evidence |
|---|---|---|
| FW2-1 (R2-dashboard-2) | REAL, with a new LOW (R3-dashboard-1) | Tests :515 and :531 RED on the FW1 hook (re-run through the mutant alias: "expected spy to be called 2 times, but got 1 times") and RED on mutant m21 (count-from-zero and the new-generation end reverted, every other test green). |
| FW2-2 (R2-dashboard-4) | REAL; negative-age branch untested (R3-dashboard-5) | Tests :579 and :598 RED on FW1 and on m22 (the stall check removed). An abandoned flight never loops again nor clears its successor (:330, :334); its read is aborted with the anchor (cur.controller). |
| FW2-3 (R2-dashboard-5) | REAL | Test :619 RED on FW1 ("expected 'initial' to be 'two'") and on m23 (latest-only restored). :663 is a guard, green on FW1 as the report says. |
| FW2-4 (R2-dashboard-6) | REAL | Both new tests (ContactEditForm.test "hands the current contact up once", ContactDetail.test "shows the current notes on the page at once") RED on a scratch copy of the form with FW1-7's mechanism (onStale instead of onContactUpdated: "expected spy to be called 1 times, but got 0 times"; "Unable to find ... zztheirs notes"), GREEN on a scratch copy of the HEAD form through the same alias. |
| FW2-5 (R2-dashboard-7) | REAL within one generation, with a new LOW (R3-dashboard-2); batchCount tier untested (R3-dashboard-5) | Test :548 RED on FW1 ("expected [ +0 ] to deeply equal [ +0, 1 ]") and on m25 (issue order only). Server progress is monotonic within a generation except for the derived `expired` (updateJobProgress / finishJob / renewLease are conditioned on running + generation; a takeover starts a new generation, rankingRunsRepo.ts:330-361). |
| FW2-6 (R2-server-6) | REAL | RUNBOOK.md:1844-1851 matches adapters/ranking.ts (one SDK retry, "one retry included" on a timeout) and runLog.ts (usage absent -> 0 tokens and cost); its two pointers exist (RUNBOOK.md:1943; item 4 of the lifecycle issue). |
| FW2-7 (R2-server-5) | REAL | GLOSSARY Fingerprint entry matches cards.ts:157 (the property card's authorities, mapped through the organization list), :209-218 (the recency bucket) and :297 (the tenant card carries it). |
| FILE rows (R2-dashboard-1, -3, -8) | Accurate | notes-guard-double-click-overwrite refs ContactEditForm.tsx:707, :750, :764 and StaffNotesCard.tsx:146, :217 match HEAD; rankings-page-hook-edges refs :363, :197, :186, :371, :380 and RankAnchorPanel.tsx:152, :160 match HEAD and all three items still hold; ranking-unlawful-flag-reason-source's dashboard refs (RankAnchorPanel.tsx:40, RankingRunDetail.tsx:159) match. |

## Swept and fine

- First read vs a press: an accepted or joined press takes the highest issue
  number, so the first read's view of another generation is dropped; of the
  same generation it is ordered by progress (ahead applied, level dropped);
  the read's own rows always apply (they are read after its job snapshot,
  readRanking.ts:365 then :413).
- Press refused 409: `wasLive` forced, the follow-up read goes through the one
  flight, the followed job's end clears the copy and reads the table (the
  filed R2-dashboard-8 b edge unchanged). 429 / 404: copy only, apart from
  R3-dashboard-1.
- Job reads: polled every 5 s only while the shown job is live; events and
  the poll coalesce into one flight; slow-but-alive reads (6 s) run back to
  back one at a time; 11 s reads cap at two in flight, one new read per 10 s;
  a stalled answer is ordered by the same rules; a job read that throws is
  swallowed and the next poll or event reads again.
- Full reads: rows monotonic by issue; a failure shown only for the latest
  read; an earlier success under a later failure keeps the error and Retry;
  Retry's "loading" ends with the first later read that succeeds (ready) or
  the latest that fails (error) - no stuck spinner found.
- New generation: a fresh press reads nothing until a batch finishes; a
  takeover's generation counts from zero (takeOver resets batchesDone,
  failedBatches, notScored and removes batchCount, rankingRunsRepo.ts:333-335),
  so its first batch reads the table (R2-dashboard-2's milder form fixed).
- Anchor / window change and unmount: a new request context, old answers
  dropped behind `currentRef` checks, reads aborted; R2-dashboard-3's slice
  reuse unchanged (filed); FW2-1 incidentally clears a reused slice's stale
  rankError / joined when the new context's first view is a finished job.
- FW2-4, the open form: it diffs against `base` and `notesBaseline`, state
  seeded once (ContactEditForm.tsx:212, :263); the live prop is read only for
  `contactId` (:663, :688); ContactDetail mounts it without a key
  (ContactDetail.tsx:1376) and its only effect is the refusal focus (:278) -
  so the hand-up re-renders it and resets nothing; the panel, the typed box
  and the re-based stamp stay.
- FW2-4, Staff notes: StaffNotesCard captures its baseline and stamp at Edit
  (StaffNotesCard.tsx:99-106), so a new page contact never re-bases an open
  staff-notes edit; a later staff-notes save still meets its own guard.
- FW2-4, contact_type_changed: untouched (ContactEditForm.tsx:734-742, onStale
  -> the consistent re-read); a notes_stale refusal stops before the status
  write, so the two never meet in one save.
- FW2-4, SSE re-read: useContact's re-read on contact.updated /
  suggestion.updated is latest-wins among its own re-reads only
  (useContact.ts:74-87), unordered against setContact - pre-existing for every
  setContact caller (onSaved, the Staff notes card); FW2-4 removes the page's
  own re-read, so it adds no race. The worst case is a page holding an older
  notes stamp, which the guard turns into a 409, never an overwrite.
- FW2-4's premises: a notes-only PATCH emits no contact.updated
  (routes/contacts.ts:2300-2307); the 409 body's contact is the raw repo item
  read consistently (:2081, :2097), the same shape onSaved already applies;
  phones are derived client-side (ContactDetail.tsx:666). ContactDetail is the
  only user of ContactEditForm.
- Rest of the Rankings page (RankingRunDetail, RankingRunList, RankingTable,
  RankingCostTotals, useRankingRuns, useRankCandidates, RankingsSection's URL
  state): unchanged by FW2; nothing at MEDIUM or above.
- Gates on the FW2 files: eslint on the six touched .ts/.tsx files exit 0;
  `tsc -p dashboard/tsconfig.json --noEmit` exit 0; added lines of
  2729e299..HEAD are ASCII; the rankings directory and the ContactEditForm,
  ContactDetail and StaffNotesCard files: 11 files, 437 tests green at HEAD.
