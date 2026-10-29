# R2-dashboard - fresh code re-review (round 2), Notes box + dashboard + e2e

- Reviewer: R2-dashboard (Claude Opus 5.5), 2026-10-29. Fresh; round 1 and
  the fix wave read as claims only.
- Branch: feat/wp1-b2-ranking-engine @ be595125 (base main @ 404e039d); fix
  wave FW1 = ebc618dd..be595125.
- Area: the contact Notes box (app/src/lib/singleLine.ts, extraction apply
  and job, the contacts PATCH Notes guard, contactsRepo, the importer stamp)
  and the dashboard (the edit form's Notes guard and conflict panel,
  ContactDetail's re-read, the AI run detail's new count, everything under
  dashboard/src/routes/settings/rankings/, the settings tab and route, the
  rankings API client and types, EventStreamProvider), the e2e specs and
  fixtures (rankings.spec.ts, contact-notes-conflict.spec.ts,
  e2e/fixtures/ranking.ts) and the e2e/performance pins. FW rows: FW1-4 ..
  FW1-12 (FW1-12: GLOSSARY only).
- Read: the brief; R1-adversarial-A2.md, R1-conformance.md (dashboard rows,
  SF1/SF2, N1-N14), R1-adjudications.md, FW1-report.md; the FW1 diff
  (`git diff ebc618dd..HEAD`, all of my area) and the area-2 feature diff;
  at HEAD in full: useAnchorRanking.ts (+ its test), RankAnchorPanel.tsx,
  RankingsSection.tsx, RankingRunDetail.tsx, RankingTable.tsx,
  rankingFormat.ts, useRankingRuns.ts, useRankCandidates.ts,
  ContactEditForm.tsx (save flow, Notes guard, render), ContactDetail.tsx
  (re-read, form wiring), useContact.ts, StaffNotesCard.tsx,
  useEventStream.ts, EventStreamProvider.tsx (ranking wiring), api/client.ts
  (request), the ranking endpoints; server: routes/contacts.ts (parser,
  create stamp, PATCH guards and 409 selection), contactsRepo.ts update
  (expect clauses, no-op path), extraction apply.ts (filterNoteLines, the
  append and stamp), jobs/extraction.ts, lib/import/apply.ts (upsertContact),
  services/ranking/job.ts + runBatch.ts (event emit points),
  readRanking.ts (read order), routes/rankings.ts, lib/eventBridge.ts,
  routes/dev.ts (ranking tick); both e2e specs, fixtures/ranking.ts, the
  specs that run after them, e2e/performance diffs, GLOSSARY. The spec
  (D14, section 4) and plan (PR28) were opened only to check the reasons
  the two REJECTs cite.
- Proof: throwaway tests, all deleted before returning -
  `dashboard/src/zz-review-anchor-ranking.test.tsx` (7 hook probes H1-H7),
  `dashboard/src/zz-review-notes-reread.test.tsx` (ContactDetail harness
  copied, one probe), `dashboard/src/zz-review-notes-dblclick.test.tsx`
  (one form probe). Mutant: the PRE-FIX hook (ebc618dd) copied to a scratch
  dir outside the worktree and aliased by a throwaway vitest config, to run
  (a) my probes and (b) the FW1 ordering tests against it.
- Verdict: no CRITICAL, HIGH or MEDIUM. FW1-4 .. FW1-12 are REAL for what
  they were asked to fix (the 7 new hook tests are RED on the pre-fix hook,
  re-run here). The fix wave adds three LOW defects (a stuck job read now
  freezes all job reads; "latest issued wins" throws away a newer-than-
  screen table; the notes_stale re-read can land after the user's own
  save) and leaves A2-1's job-status clause partly open. Round 1 missed
  three LOW edges: a double-click on Save turns the Notes guard into a
  silent overwrite; a new job generation first seen finished never re-reads
  the table (A2-1's symptom by another path); a press answered after the
  window toggles away and back leaves Rank stuck on "Starting...". No
  adjudication is wrong; one FW1 implementation choice is challenged.
- Counts: CRITICAL 0, HIGH 0, MEDIUM 0, LOW 7, INFO 1.

## 1. NEW findings (round 1 missed)

### R2-dashboard-1 - LOW - CONFIRMED (jsdom mechanism; real timing PLAUSIBLE) - a double-click on Save after a stale form overwrites the current notes without the user ever seeing them

- Where: dashboard/src/routes/contact/ContactEditForm.tsx:743 (`setSaving(false)`
  after the 409), :757 (`canSave = !saving && ...`), :776 (Save enabled
  again), :702-719 (the notes_stale branch re-bases the baseline to THEIR
  stamp); the save path :620. Same pattern in StaffNotesCard.tsx:146, :217
  (not tested).
- What happens: click 1 sends the stale PATCH; the 409 notes_stale answers,
  the form re-bases `notesBaseline` to the current contact's stamp and
  re-enables Save. If the 409 arrives inside the double-click interval
  (a PATCH round trip is ~60-150 ms through CloudFront; a habitual
  double-click is ~100-250 ms), click 2 submits the box again with the
  re-based stamp and it lands: the colleague's lines or the extraction's
  `[Auto - ...]` lines are replaced although the conflict panel was never
  seen. Spec D14.3's premise - "the next Save is a deliberate overwrite of
  notes the user has now seen" (also the form's own comment at :703-707) -
  does not hold for one gesture.
- Why it matters: it is the one path left in this branch by which the edit
  form drops Notes lines silently, and since B2a those lines are ranking
  evidence (tenant card, feedback lines). Bounded: needs a stale form AND a
  double-click AND a fast 409; the outcome equals pre-B2a behavior.
- Reproduced: `zz-review-notes-dblclick` - updateContact rejects once with
  409 notes_stale (+ contact, stamp THEIRS), then resolves; one
  `userEvent.dblClick(Save)`: updateContact called TWICE, the second with
  `{ notes: 'mine', notes_expected_updated_at: THEIRS }`, onSaved once.
- Smallest fix: after a notes_stale refusal ignore submits for a short
  settle window (e.g. keep Save disabled ~750 ms after the panel renders),
  or make the overwrite a distinct control ("Replace the current notes")
  that only a fresh click after render can press. Apply the same to the
  Staff notes card.
- Test: the reproduction inverted - one dblClick after a stale form sends
  ONE PATCH and leaves the panel showing.

### R2-dashboard-2 - LOW - CONFIRMED - a new job generation first seen finished, with no more finished batches than the last one, never re-reads the table (A2-1's "stale table under Done" by another path)

- Where: dashboard/src/routes/settings/rankings/useAnchorRanking.ts:157-158
  (`grew = finished > cur.seenBatches`, `ended = cur.wasLive && ...`) and
  :161-162 (seenBatches / wasLive carried across generations; the press
  branch :293 sets the baseline from a snapshot the same way).
- Interleaving: the page shows G1 done (1 batch; seenBatches 1, wasLive
  false, so no poll). Another admin or tab ranks the same anchor (G2, one
  batch). The claim emits no event (rankings.ts POST; job.ts emits at pool
  built :416, per batch runBatch.ts:103, finish :326); if the page's first
  job read of G2 is served after G2 finished - the "pool built" event lost
  by the best-effort bridge (eventBridge.ts: 2 s timeout, no retry), events
  posted out of order, or a burst coalesced by FW1-4's one-flight rule -
  the view is "done 1/1": grew 1 > 1 false, ended false (never saw it live).
  No full read: the job line says G2 is done, the table is G1's, nothing
  reads again until a reload. Pre-existing (the pre-fix hook behaves the
  same), but it is exactly A2-1's MEDIUM symptom and FW1-4 did not cover it.
  A milder form: G2 first seen at "running 3/8" after G1's 8 skips G2's
  table refreshes until batch 4.
- Reproduced: probe H3 - initial read G1 done 1/1; one event; job read G2
  done 1/1; three poll periods: getRanking called once, job shows gen-2
  done. Passes on HEAD and on the pre-fix hook (pre-existing).
- Smallest fix: in applyJob treat a generation change as a change -
  `newGen = next !== null && next.generation !== cur.jobGeneration`;
  `grew = finished > (newGen ? 0 : cur.seenBatches)`;
  `ended = (cur.wasLive || newGen) && (next === null || !isJobLive(next.status))`.
- Test: probe H3 inverted (expect a second full read).

### R2-dashboard-3 - LOW - CONFIRMED - a Rank press answered after the window toggles away and back leaves "ranking" true: the button reads "Starting..." and stays disabled

- Where: useAnchorRanking.ts:285 (`if (currentRef.current !== cur) return;` -
  the answer of a superseded cur never clears `ranking`), :147-149 (`update`
  reuses the held slice whenever its KEY string matches), :136 (the key is
  `kind:id:window`); RankAnchorPanel.tsx:150-155 (the window checkbox is not
  disabled during a press), :160 (Rank disabled while `ranking.ranking`).
- Interleaving: press Rank on K1 (slice K1 `ranking: true`); toggle "Include
  tenants not heard from" (K2, its read slow); toggle back before K2's read
  lands (K1 again - a NEW cur, but the held slice is still K1's, with
  `ranking: true`); the press answers for the old cur and is dropped. The
  new cur's reads keep `ranking: true` (they spread the old slice). The job
  itself runs and is followed, but Rank stays disabled with "Starting..."
  until another anchor/window change or a reload. Browser Back/Forward over
  the URL state does the same. Stale `rankError` / `joined` carry over the
  same way. Pre-existing.
- Reproduced: probe H4 - held press, K1 -> K2 (read never answers) -> K1,
  resolve the press: `readStatus 'ready'`, `ranking === true` after four
  poll periods. Same on the pre-fix hook.
- Smallest fix: in the early return clear the flag on the matching slice
  only: `setSlice(prev => prev !== null && prev.key === cur.key ? { ...prev, ranking: false } : prev)`
  (or tag the slice with its cur so a returning key starts blank).
- Test: probe H4 inverted.

## 2. Defects in the fix diff

### R2-dashboard-4 - LOW - CONFIRMED - FW1-4's one-flight rule: a job read that never answers freezes every later job read (poll, events, the 409 follow-up) for that anchor

- Where: useAnchorRanking.ts:242-245 (a call while a read is out only sets
  `jobReadAgain` and returns the same promise), :248-251 (the loop waits on
  that read); dashboard/src/api/client.ts:132-138 (`fetch` with no timeout;
  only the anchor's own abort signal).
- What happens: before FW1-4 every 5 s poll issued a fresh job read, so one
  stalled request cost one poll. Now the stalled read holds the flight: the
  status line, the end-of-job full read and Rank (disabled while the shown
  job is live) stay frozen until that request settles. In production
  CloudFront's origin_read_timeout is 30 s (infra/modules/cloudfront/main.tf:114,
  plus its retries), so the freeze is bounded at roughly 30-90 s instead of
  5 s. On the e2e lane (no CloudFront) a stalled request would outlast the
  15 s expect timeout (e2e/playwright.config.ts:135), so a stall the old hook
  absorbed at the next poll would fail rankings.spec (PLAUSIBLE; no such
  stall has been seen on this spec).
- Reproduced: probe H5 - first job read never resolves; 12 poll periods and
  an event: getRankingJob called ONCE, the job still "running", no full
  read. Against the pre-fix hook the same probe sees 14 job reads (the
  regression is FW1-4's).
- Smallest fix: bound each job read (abort it after ~2 x JOB_POLL_MS with a
  per-read controller chained to `cur.controller`), or let a call start a
  new read when the flight is older than JOB_POLL_MS - the issue-number
  rule already drops an older answer.
- Test: probe H5 inverted (a stuck read does not stop the next poll's read).

### R2-dashboard-5 - LOW - CONFIRMED - FW1-4's "latest issued wins" throws away a full read that is NEWER than the table on screen whenever a later one is still out

- Where: useAnchorRanking.ts:182 (`if (issued !== cur.latestRead) return;`),
  :174 (every full read moves `latestRead` at issue time); the superseded
  read is not aborted either (it still costs ~10 reads per candidate).
- What happens: with batches finishing closer together than a full read
  takes (RANKING_BATCH_CONCURRENCY 4 starts four calls together, so their
  ends cluster; a 300-candidate pool's read is seconds), each per-batch
  read is superseded before it lands and its table is discarded although it
  is newer than what is shown. The table then moves once per cluster, not
  per batch (spec D9h's per-batch re-read is issued but its result dropped).
  The final table is still right (A2-1 fixed). The pre-fix hook applied
  such a read (probe H1 fails on it), so this is new behavior.
- Reproduced: probe H1 - reads after batch 1 and batch 2 both issued; the
  batch-1 read answers first: the table stays "initial"; only the batch-2
  read shows.
- Smallest fix: monotonic, not latest-only - keep `rowsIssued` (the issue
  number of the rows on screen) and apply a full read iff
  `issued > cur.rowsIssued`; keep the latest-only rule for errors and the
  loading state.
- Test: probe H1 inverted (the batch-1 rows show, then the batch-2 rows;
  the A2-1 inverted test still passes).

### R2-dashboard-6 - LOW - CONFIRMED - FW1-7's re-read is unordered against the form's own next save: answering after a quick second Save it puts the REPLACED notes back on the page, and the next edit is refused again

- Where: dashboard/src/routes/contact/ContactEditForm.tsx:719 (`onStale?.()`
  on notes_stale); ContactDetail.tsx:946-952 (`rereadRetypedContact`:
  `getContact(..., { consistent: true }).then(setContact)` - no sequence),
  :1381 (onSaved's `setContact(updated)`); useContact.ts sequences only its
  own event re-reads, never against setContact.
- Interleaving: 409 notes_stale -> re-read GET issued (served now, holds
  THEIR notes) -> the user saves again before it answers -> PATCH lands ->
  onSaved shows MY notes, the dialog closes -> the GET answers ->
  `setContact(theirs)`: the page shows the notes the user just replaced.
  A notes-only PATCH emits no contact.updated (contacts.ts:2294-2306), so
  nothing corrects it; the next edit opens from that contact and sends THEIR stamp,
  which the server refuses (stored stamp is MINE) - the A2-5 symptom FW1-7
  was asked to remove. R2-dashboard-1's double-click makes the precondition
  common (a second save ~100 ms after the re-read is issued); the re-read,
  sent first, usually still answers first, so the race also needs it to be
  the slower of the two requests.
- Reproduced: `zz-review-notes-reread` (ContactDetail harness) - held
  consistent re-read; second Save resolves with MINE; dialog closes, page
  shows "zzmine notes"; release the re-read with THEIRS: the page shows
  "zztheirs notes", and the reopened form's next save sends
  `notes_expected_updated_at: THEIRS`.
- Smallest fix: hand the 409's contact up synchronously (the Staff notes
  card's pattern, StaffNotesCard.tsx:139 - the one the adjudication itself
  pointed to) instead of re-reading; or drop a re-read answer when
  setContact ran after it was issued (a page-level version counter).
- Test: the reproduction inverted (the page keeps MINE).

### R2-dashboard-7 - LOW - CONFIRMED - FW1-4 orders job views by ISSUE time, but the adopting full read takes its job snapshot late, so a later-issued job read can still regress the status (A2-1's job-status clause only partly fixed)

- Where: useAnchorRanking.ts:154 (`if (issued <= cur.jobIssued) return null;`),
  :180 (the first read and Retry adopt their job by that rule);
  app/src/services/ranking/readRanking.ts:357 then :365 (the read assembles
  the pool and cards FIRST, then reads the job). The header (:14-21) claims
  "never puts back an older ... job".
- What happens: a page opened mid-job issues the first read R (issue 1); an
  event issues job read J (issue 2), served at once. R's job is read seconds
  later, after the pool. R lands first with "2 of 3", J lands with "1 of 3"
  and is applied (2 > 1): the status regresses, and the next poll's "2 of 3"
  counts as grown, costing a redundant full read. A2-1 named exactly this
  ("out-of-order JOB reads ... regress the shown status for a poll period
  and trigger an extra full read"); FW1-4 closed it for job read vs job read
  (one flight), not for the adopting read vs a job read. Pre-existing
  behavior; transient (one poll).
- Reproduced: probe H2 - status regresses from [0,1] to [0]; the next poll
  issues one more full read.
- Smallest fix: compare server progress, not issue order: within one
  generation apply a view only if it is not behind the shown one (queued <
  running < finished; finished batches non-decreasing); or read the job
  FIRST in readRanking so a read's snapshot is taken at arrival.
- Test: probe H2 inverted.

### R2-dashboard-8 - INFO - CONFIRMED - FW1-6 edges: the joined mark and the 409 copy can still disagree with the job shown

- (a) useAnchorRanking.ts:296-297: a joined press whose answer lands after
  the page already applied that SAME generation's done view takes the else
  branch and sets `joined: true` under "Done" - the A2-8 copy again
  (probe H6; needs the job to finish between the claim and its 202).
- (b) :306-307 with :158: a 409 whose follow-up read is coalesced behind an
  OLDER job read (issued before the press) - that stale view of the previous
  job's end satisfies `ended` (wasLive was forced true) and clears "A ranking
  is running for this record..." while the new job still runs (probe H7;
  the trailing read then shows it running, so the page is not wrong for
  long; the pre-fix hook showed the stale job instead).
- Smallest fix: (a) in the else branch set `joined` only while the shown
  job is live; (b) on a 409 remember the press's issue number and let only
  a view issued after it clear the error.

## 3. Adjudication challenges

- FW1-7 (A2-5): not the adjudication's class or row, its chosen mechanism.
  The row names two fixes - `onStale?.()` (the page's consistent re-read)
  and the Staff notes card's pattern (hand the 409's contact up) - and the
  wave took the re-read, which is asynchronous and unordered against the
  user's next save (R2-dashboard-6). The 409 already carries the current
  contact, so handing it up is synchronous and race-free; recommend
  switching.
- A2-3 REJECT (U+2028/U+2029 "mismatch" on old runs): reason verified -
  spec D14.1 says "rendered transcripts holding those characters change",
  and plan PR28 lists exactly this "mismatch" for Cameron at the handback.
  No challenge (the handback must carry it).
- A2-4 REJECT (the extraction-side guard): reason verified - spec section 4
  lists "A guard on the importer's or extraction's Notes writes" out of
  scope; the FILE note on extraction-text-field-write-races-staff-fill is
  there. No challenge.
- A2-6 FILE (line readers split differently): agreed - the writer side is
  what D14.1 asked for; the readers' split is a separate, low change.
- N1 -> FW1-5, N2 -> FW1-9, N3/N5 -> FW1-10, SF1 -> FW1-8, SF2/N14 -> FW1-12:
  agreed.

## 4. Fix verification (my rows)

| Row | Verdict | Evidence |
|---|---|---|
| FW1-4 (A2-1) | REAL for the table; PARTIAL for A2-1's job-status clause | The A2-1 reproduction inverted (useAnchorRanking.test.tsx:348) and the one-flight test (:408) are RED on the pre-fix hook: re-run here through the mutant config - all 7 new ordering tests fail on the pre-fix hook, the 15 earlier ones pass. The adopting-read vs job-read regression remains (R2-dashboard-7). The fix adds R2-dashboard-4 and R2-dashboard-5. |
| FW1-5 (A2-2, N1) | REAL | Test :431 RED on the pre-fix hook (re-run); the issue-number rule at :154 drops the first read's job when a press answered first; the press takes a fresh number at :291. |
| FW1-6 (A2-8) | REAL (main path); INFO edges | Tests :454, :470, :488 RED on the pre-fix hook (re-run); clearing at :165 on `ended`, 409 marks `wasLive` at :306. Edges in R2-dashboard-8. |
| FW1-7 (A2-5) | REAL, with a new race | ContactEditForm.tsx:719 calls `onStale` only in the notes_stale branch (test :2353 asserts it once, no onSaved, one PATCH). The page's re-read does not touch the open form (`base` and every field are seeded at mount; the only live-prop reads after mount are `contactId` and the unused-on-this-path `updated = contact`). The re-read can land after the user's own save (R2-dashboard-6). No page-level test for the notes path; the FW3-1 page test pins the shared prop's wiring. |
| FW1-8 (SF1) | REAL | RankingRunDetail.tsx:116-139 renders the button only for `currentRunId` not null and not this run, and only with `onOpenRun`; RankingsSection.tsx:94-100 sets `run`; both tests (RankingRunViews.test.tsx:314, RankingsSection.test.tsx:120) query the button by role and name, so they fail without it. |
| FW1-9 (N2) | REAL | RankingCostTotals.tsx:47-51; test asserts absent for false, present for true. |
| FW1-10 (N3, N5) | REAL | rankingFormat.ts:127-140 (the done branch) states the loss once when S5's message is present (every S5 done-message counts its own loss: job.ts:50-67); `candidateCountText` in the list and detail; e2e rankings.spec.ts:191-194 asserts the full new line. |
| FW1-11 (A2-4 comment, A2-7) | REAL | apply.ts:968-972 and :989-994 now match the code (the write at :995 stores the snapshot plus lines, unguarded); ContactEditForm.tsx:440-444 matches routes/contacts.ts:655-659 (stored as sent). |
| FW1-12 (GLOSSARY) | REAL | GLOSSARY.md:181 "a panel above the box" matches ContactEditForm.tsx:1273-1296 (panel precedes the label); the Fingerprint entry's prompt-fingerprint lines match prompt.ts:168-179 (system text + schema), runBatch.ts:138 / runLog.ts:99 (recorded on match and run) and readRanking.ts:174-175 (only rubric/examples versions and model mark "version"). |

## Swept and fine

- Hook: unmount and anchor change abort reads; a superseded cur's job read
  exits the loop; the flight clear in `finally` cannot strand a call; no
  setState after unmount; React StrictMode double effect is harmless (the
  request helper drops an aborted request before it touches the network).
- useEventStream reads handlers through a ref, so a stale kind/id after an
  anchor change can only cause a dropped read; EventStreamProvider's
  `ranking.updated` listener parses and dispatches like its siblings.
- Press outcomes: 429 and 404 only set copy; a lost 202 (network error) is
  picked up by events; a joined press of the shown generation never
  replaces a newer view.
- The poll runs only while the shown job is queued or running and stops on
  `expired` (derived server-side after RANKING_QUEUE_EXPIRY_MS).
- URL state: every choice in the URL; `parseAnchorParam` refuses unknown
  kinds and empty ids; the run link keeps the other params (an opened run
  from the other anchor is simply not in a filtered list).
- Edit form: the trim compare decides "changed" only; the stamp rides only
  with notes; FB8 re-bases only after a PATCH that carried notes; the
  conflict panel is outside the label and linked by aria-describedby; the
  re-read never resets an open form; keyboard double-Enter is safe (the
  refusal moves focus into the textarea).
- Server guard: a lone Notes guard 409s only on a moved stamp (the repo
  condition is `attribute_exists(contactId) AND #expect = :v` or
  `attribute_not_exists`); the no-op path checks guards on a consistent read;
  staff_notes_stale wins; a gone contact is 404.
- Every contact Notes writer stamps in the same write: PATCH
  (contacts.ts:1987), create (:1268), extraction (apply.ts:995, `at` taken
  once per apply), importer (lib/import/apply.ts:1200, one write per merged
  person per run). No other writer: public intake, unmatched-email create,
  the caseworker conversion, the dev org fixture, statusTransition, the
  twilio/voice webhooks and app/scripts never write `notes`.
- Readers of the stamp: the PATCH guard, the form, cardFields' exclusion;
  no dashboard path round-trips a contact into POST/PATCH, so the new
  SERVER_OWNED refusal breaks none.
- singleLine/filterNoteLines: `withoutAutoPrefix` trims (line terminators
  included) before the fold, so no leading/trailing " / "; CRLF-safe split.
- AI run detail: `notesDuplicate` rides the whole run record (aiRuns.ts:272)
  and is counted in `counted`.
- e2e: Playwright 1.61's injected expect fails a negated text assertion on a
  missing element, so `not.toContainText('not ranked yet')` cannot pass on
  an absent table; contact-notes-conflict asserts the copy and the stored
  values between saves; the dev tick is unscoped but only rankings.spec
  presses Rank and workers is 1; run-unique records persist after the spec
  (tenants, properties, org entries, a done job on contact-tenant-0001 from
  the VA test) and the later specs that skip a reseed scope their
  assertions (send-outcome-cards sends to explicit ids; roster-paging mints
  its own volume).
- e2e/performance: the mutation catalog count and entry, the route pin and
  its TODO with docs/issues/perf-pages-settings-rankings-surface.md agree.
- Settings tab adminOnly and the route inside AdminRoute; the VA e2e proves
  the redirect.
