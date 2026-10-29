# R1-adversarial-A2 - plan-blind adversarial code review

- Reviewer: R1-adversarial-A2 (plan-blind; nothing under docs/superpowers/ was opened)
- Branch: feat/wp1-b2-ranking-engine @ a1077128 (base main @ 404e039d)
- Area 2: how a contact's Notes box is written (line folding of machine-added
  lines, the dropped-repeat count, the `notes_updated_at` stamp and the edit
  form's stale-save guard) plus the admin-only Rankings page (API client, live
  updates, URL state) and its e2e specs.
- Read: .superpowers/review/pkg-area2-notes-dashboard.diff in full; in the repo
  app/src/routes/contacts.ts (parser, create, PATCH guards and 409 selection,
  emit rules), app/src/repos/contactsRepo.ts (update/create, expect clauses),
  app/src/services/extraction/apply.ts (filterNoteLines, the append),
  app/src/jobs/extraction.ts (snapshot read, model call, run draft),
  app/src/lib/import/apply.ts (upsertContact) and app/scripts/import-apply.ts,
  app/src/lib/singleLine.ts, prompt.ts, runWindow.ts, routes/aiRuns.ts,
  lib/caseworkers.ts, services/ranking/{seenFeedback,cardFields,job}.ts,
  routes/api.ts (mounts, SSE), dashboard ContactEditForm/StaffNotesCard/
  ContactDetail/useContact, every new rankings file, App.tsx/AdminRoute/
  settingsTabs, EventStreamProvider/useEventStream, e2e playwright.config.ts,
  fixtures/ranking.ts, both new specs, the specs that run after them,
  docs/issues (notes guard, import overwrite, line break, flip-back, field-write
  race), GLOSSARY.
- Verdict: the Notes stale-save guard is sound on the server and in the form,
  and every Notes writer in app code stamps the box. No CRITICAL or HIGH. The
  Rankings page's data hook has no ordering on its reads: with parallel batches
  an earlier full read can land last and leave a stale table under "Done"
  (MEDIUM, reproduced). The rest are LOW/INFO edges: a press racing the first
  read, false hash "mismatch" on old AI runs, the still-open inverse Notes race
  that the new stamp now makes cheap to close, and the form not refreshing the
  page after a refusal.
- Counts: CRITICAL 0, HIGH 0, MEDIUM 1, LOW 5, INFO 2.
- Reproductions: throwaway tests (run, passed as reproductions, deleted);
  details in .superpowers/sdd/research/R1-adversarial-A2-reference.md.

## Findings

### R1-adversarial-A2-1 - MEDIUM - CONFIRMED - a stale full read can land after the final one and win; the table is stale under "Done" and nothing reads again

- Where: dashboard/src/routes/settings/rankings/useAnchorRanking.ts:125-148
  (loadRead applies any response whose `cur` is current - no order check),
  :166-185 (refreshJob issues a full read on `grew` and on `ended`, with no
  in-flight dedupe), :198-202 (every ranking.updated for the anchor calls
  refreshJob).
- Interleaving: a job with 2+ batches runs them in parallel
  (RANKING_BATCH_CONCURRENCY default 4, services/ranking/job.ts:418), so the
  last batch's progress event and the done event (job.ts:313) reach the page
  back to back. t1: event "batch k-1 finished" -> job read -> grew -> full read
  L1 issued (served before batch k's matches are written). t2: event "batch k
  finished" / "done" -> job read -> grew/ended -> full read L2 issued. A full
  read is "about ten DynamoDB reads per candidate", so the two overlap and can
  answer in either order. L2 answers first (complete table), then L1 answers
  and replaces it. The job now reads "Done: N batches" but the table shows the
  pre-batch-k state ("not ranked yet" rows, older scores). The job is no longer
  live, so the 5 s poll is off and no event follows: it stays wrong until a
  reload or an anchor change. The same missing order makes out-of-order JOB
  reads (event bursts plus the poll) regress the shown status for a poll
  period and trigger an extra full read.
- Why it matters: this page is the only place B2a shows a ranking; an admin
  judging the engine sees candidates "not ranked yet" after a finished job and
  is likely to press Rank again (model spend). The single-batch e2e cannot see
  it. If B3 reuses this hook the defect ships to staff.
- Reproduced: throwaway hook test with held endpoint promises - initial read
  (running, 2 batches), two ranking.updated events in one act, resolve the
  final read then the earlier one: `read.rows` is the earlier read while
  `job.status === 'done'` (reference file, A2-1).
- Smallest fix: a per-hook read sequence (or one AbortController per full
  read, aborting the previous when a newer one starts): loadRead applies a
  response only if it is the latest issued for the current key. The same
  guard for refreshJob responses (drop a job view older than the last applied
  one, e.g. by a request counter), plus dedupe of concurrent refreshJob calls.
- Test that catches it: the reproduction inverted - "an earlier full read that
  answers after a later one is dropped" expects the final rows (fails today).

### R1-adversarial-A2-2 - LOW - CONFIRMED - a Rank press answered before the first read is overwritten by that read

- Where: useAnchorRanking.ts:130-141 (`adoptJob` copies the read's job and
  resets seen/wasLive), :159 (the first read adopts), RankAnchorPanel.tsx:160
  (Rank is enabled while the first read is still loading).
- Interleaving: the admin picks an anchor; the first full read (slow for a big
  pool) is in flight. They press Rank; the 202 lands -> job "queued", poll on.
  The first read - served before the press wrote the job - answers with job
  null (or the previous "done" job) and replaces the live job: no job status,
  poll stopped, Rank enabled again. The page recovers only if a
  ranking.updated event arrives (the bridge is best-effort); a second press
  joins the live job.
- Smallest fix: do not adopt a read's job when a press or a job read has set a
  job since that read was issued (compare a job-update counter captured at
  issue time), or always prefer the job with the newer `requestedAt` /
  generation; alternatively disable Rank until the first read answers.
- Test: hold the first read, press, resolve the read with job null; expect the
  job to stay "queued" (fails today; reference file, A2-2).

### R1-adversarial-A2-3 - LOW - CONFIRMED - folding U+2028/U+2029 in the transcript renderer turns every stored AI run that saw such a body into a false hash "mismatch"

- Where: app/src/services/extraction/prompt.ts:245 (renderUtteranceLine now
  uses toOneLine, app/src/lib/singleLine.ts:20-21), runWindow.ts:52-57 (the
  per-message hash is over that rendering), app/src/routes/aiRuns.ts:257-264
  (the run detail recomputes the hash with TODAY's renderer and reports
  `mismatch` when it differs).
- What happens: a run recorded before this change, whose window held an SMS,
  email or call line containing U+2028 or U+2029, stored a hash of the old
  rendering. The detail view now recomputes with the new rendering and shows
  "mismatch" - "this message changed since the run" - for a message that did
  not change. prompt.ts's own docblock names this as the failure the single
  renderer exists to prevent. Bounded by RUN_TTL_DAYS (90) and by how rare the
  separators are.
- Reproduced: throwaway app test - the pre-B2a rendering hashed inline equals
  hashRenderedMessage for a body with "\n" (control) and differs for a body
  with "<U+2028>" (reference file, A2-3).
- Smallest fix: stamp a renderer version on runs written from now on
  (RunWindow), and have aiRuns.ts hash a window without it with the legacy
  CR/LF-only fold; or report `unavailable` instead of `mismatch` for such runs.
- Test: a full-detail run window without the new marker, its message body
  holding U+2028, hash computed with the old fold -> hashStatus `match`
  (fails today).

### R1-adversarial-A2-4 - LOW - CONFIRMED - the inverse Notes race is still open: extraction's append overwrites a staff save made during the model call, and B2a's comment says otherwise

- Where: app/src/jobs/extraction.ts:486 (the contact snapshot is read before
  the message, org-list and sends reads and the model call at :673),
  app/src/services/extraction/apply.ts:972-992 (nextNotes = snapshot notes +
  new lines, written with no `expect`), and the new comment at :988-991
  ("No guard here: extraction appends to whatever the box holds").
- Interleaving: t0 extraction reads the contact (notes N0, stamp S0). t1 staff
  open the edit form (N0, S0), edit, Save with notes_expected_updated_at S0 ->
  accepted, stored N1 / S1, form closes. t2 the model call returns; apply
  writes N0 + "[Auto - ...] line" and stamps the run's `at`. N1 is gone; the
  page then refetches on suggestion.updated and shows the AI line without the
  staff edit. The comment is wrong: the append replaces the box with the
  run's SNAPSHOT plus lines, it does not append to what the box holds (lines
  968-971 of the same function still say so).
- Why it matters: B2a closes the form-over-extraction direction but not
  extraction-over-form. It is the documented, accepted residual
  (docs/issues/extraction-text-field-write-races-staff-fill.md: "the Notes
  box read-modify-write accepts it too"), but B2a is what makes the fix cheap:
  the stamp now exists on every Notes write, and the box is now ranking
  evidence (tenant card, feedback lines), so a lost staff line changes the
  next ranking.
- Reproduced: throwaway app test - applyExtraction with snapshot notes N0 / S0
  while the stub store holds a staff save N1 / S1: one contacts.update with
  `opts === undefined`, stored notes = N0 + the Auto line, the staff line
  gone (reference file, A2-4).
- Smallest fix: write the append with
  `{ expect: { attr: 'notes_updated_at', value: contact.notes_updated_at ?? null } }`;
  on ConditionalCheckFailedException re-read the contact (consistent), re-run
  filterNoteLines against the fresh box and write once more (bounded). Fix the
  comment either way.
- Test: an apply test whose first update throws ConditionalCheckFailed and
  whose re-read returns N1: the second write contains N1's staff line plus the
  new line (fails today: no guard, no retry).

### R1-adversarial-A2-5 - LOW - CONFIRMED - after a notes_stale refusal the form never refreshes the page, so "Cancel to keep them" leaves the page on the old notes and the next edit conflicts again

- Where: dashboard/src/routes/contact/ContactEditForm.tsx:695-710 (the
  notes_stale branch re-bases the form only; no onSaved, no onStale), compare
  StaffNotesCard.tsx:139 (`onContactUpdated?.(theirs)` in the same case);
  app/src/routes/contacts.ts:2305 (a PATCH emits contact.updated only for a
  status or type change - a colleague's notes-only save tells no open page);
  dashboard/src/routes/contact/useContact.ts:88-91.
- Interleaving: page A is open; a colleague saves new notes (no event reaches
  A). A opens Edit (from A's stale contact), types, Saves -> 409 notes_stale,
  panel shows the colleague's notes. A presses Cancel ("Cancel to keep
  them"): the form closes and page A still shows the OLD notes. Re-opening
  Edit starts from the old text and the old stamp, so the next notes Save is
  refused again; only a reload shows the kept notes. No data loss (the guard
  holds), but the page contradicts the copy. Also: Cancel discards every
  other field typed in the form; the only way to keep the current notes AND
  save the other edits is to copy the current notes into the box (covered by
  a unit test, not said in the copy).
- Reproduced: throwaway form test - reject updateContact with 409 notes_stale
  + contact, Save, Cancel: onClose once, onSaved and onStale never called
  (reference file, A2-5).
- Smallest fix: on notes_stale call `onStale?.()` (ContactDetail already wires
  it to a consistent re-read), or add an `onContactUpdated` prop and hand the
  409's contact up as StaffNotesCard does.
- Test: the reproduction inverted - expect onStale (or the new callback) once
  after a notes_stale refusal (fails today).

### R1-adversarial-A2-6 - LOW - PLAUSIBLE - "the ONE rule" for a line exists only on the write side; the readers of the same Notes box split it three different ways

- Where: app/src/lib/singleLine.ts:1-21 (writer: CR, LF, U+2028, U+2029
  runs); readers: app/src/services/extraction/apply.ts:342 (retry guard:
  split on "\n" only, then trim), app/src/lib/caseworkers.ts:77 (AI
  caseworker signal: split on "\n", no trim before the anchored prefix
  match), app/src/services/ranking/seenFeedback.ts:26-41 (tenant card: CR,
  LF, CRLF, U+2028, U+2029, a hand-copied fourth definition).
- What happens: a stored box whose lines are separated by CR alone or by
  U+2028 (pasted text, an imported workbook cell) is several lines to the
  ranking card but ONE line to the retry guard and to the caseworker signal,
  so a re-emitted line is not seen as present (appended again, and counted as
  new, not in notesDuplicate) and an AI caseworker line after such a
  separator is not seen. The new file says two callers "can never disagree";
  the box's readers already do. Separately, the fence omits the other UAX #14
  mandatory breaks (VT U+000B, FF U+000C, NEL U+0085), which a UCS-2 SMS or
  an email body can carry; whether the model or the Notes card renders them
  as breaks was not verified (PLAUSIBLE).
- Smallest fix: export one `splitLines` beside toOneLine (same character
  class, CRLF as one break) and use it in filterNoteLines, hasAiCaseworkerNote
  and seenFeedback.noteLines; decide whether VT/FF/NEL join the class.
- Test: filterNoteLines with existingNotes "keep<U+2028>works nights" and a
  model line "works nights" -> duplicate 1, append [] (fails today).

### R1-adversarial-A2-7 - INFO - CONFIRMED (by reading) - doc and comment drift

- documentation/GLOSSARY.md:180-181 says the current notes are "shown below
  the box"; the panel renders ABOVE the Notes box
  (ContactEditForm.tsx:1264 precedes :1278), as the issue file's resolution
  says.
- ContactEditForm.tsx:440 says the Notes diff is "trimmed as the server
  stores it (C5)"; the PATCH stores `notes` verbatim (contacts.ts:655-659).
  Harmless (a whitespace-only edit is simply not sent), but the stated reason
  is false.
- The extraction comment at apply.ts:990-991 (see A2-4).

### R1-adversarial-A2-8 - INFO - CONFIRMED (by reading) - Rankings page status copy outlives the state it describes

- RankAnchorPanel.tsx:176 keeps a press's rankError (e.g. "A ranking is
  running for this record. Try again when it finishes.") on screen after that
  job finishes - beside "Done: ..." - until the next press; :184 keeps
  "(joined the ranking already running)" appended to the finished job's
  status. Clear rankError and `joined` when the followed job ends
  (useAnchorRanking `ended`).

## Swept and fine

- Every Notes writer in app code stamps in the same write: PATCH
  (contacts.ts:1987), manual create (:1268), extraction (apply.ts:992), the
  importer (lib/import/apply.ts:1200, importedAt is per run,
  scripts/import-apply.ts:375). Seeds stay unstamped and read as null. No
  other writer of contact `notes` in app/src, app/scripts, scripts, e2e or
  fake-twilio (the line 1562 import write is the unit's notes).
- Server 409 selection (contacts.ts:2080-2099): a lone notes guard is stale;
  with other guards only a moved stamp is; staff_notes_stale wins; a gone
  contact is 404. The other guards are server-read in the same request, so a
  re-Save cannot loop on them.
- Repo guard semantics: null -> attribute_not_exists; the no-op update path
  checks guards on a consistent read (contactsRepo.ts:1656-1711).
- No client round-trips a contact into POST/PATCH (dashboard updateContact /
  createContact callers, every e2e contacts PATCH, seed-smoke), so the new
  SERVER_OWNED refusal of notes_updated_at breaks none.
- The stamp stays off the ranking card (cardFields.ts:189), so a stamp-only
  write (import with identical text) never marks matches out of date.
- Form: sends the opened stamp only with a changed Notes box; FB8 re-bases
  only after a PATCH that carried notes; a PATCH without notes never adopts an
  unseen stamp; `base` is frozen at open, so an SSE refetch while the form is
  open cannot hide a conflict.
- filterNoteLines: withoutAutoPrefix trims stored lines (CRLF safe); the
  collapse runs before the cut; notesDuplicate is plumbed into the run record,
  the aiRunsRepo type and the run detail.
- Line-folding readers: hasAiCaseworkerNote, the ranking card's feedback
  attachment and the extraction profile all read a folded line correctly;
  stored text is never rewritten.
- Role gating: tab adminOnly, route inside AdminRoute, no catch-all under
  /settings (so the VA redirect in the e2e proves the guard), the run log and
  cost API are requireRole('admin'); rank/read/job are admin and VA by design.
- ranking.updated carries ids, status and counts only; the hook ignores other
  anchors; unmount aborts reads (useAnchorRanking, useRankCandidates,
  useRankingRun, useRankingCost; loadMore's late setState is a no-op).
- URL state: parseAnchorParam refuses unknown kinds and empty ids; ids are
  encoded on the wire; a bad anchor reads as a 404 with Retry.
- e2e: workers 1, fullyParallel false, so the unscoped ranking tick and the
  beforeAll reseed cannot hit a concurrent spec; RANKING_WORKER_POLL=off and
  RATE_LIMIT_RANK_PER_MIN raised on the lane; run-unique authorities keep each
  pool to its own records; later specs that skip a reseed assert only scoped
  rows. contact-notes-conflict asserts the notes_stale copy and the stored
  values between the two saves, so it cannot pass on another 409.
- Mutation catalog (startRanking) and the route registry exclusion with its
  TODO and issue are consistent.
