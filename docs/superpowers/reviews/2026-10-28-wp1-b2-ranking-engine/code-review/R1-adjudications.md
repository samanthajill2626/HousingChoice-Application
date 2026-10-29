# B2a code review round 1 - orchestrator adjudications

Branch feat/wp1-b2-ranking-engine @a1077128 (base main @404e039d). Gates
battery 1 at a1077128 all green (typecheck 0, npm test 0, smoke 0, e2e 0
with 391 passed, lint 0 on 184 files, read budget isolated 228/178/158 ms).

Reviewers (opus, fresh, parallel): R1-conformance (spec + plan + worklist),
R1-adversarial-A1 (plan-blind, server), R1-adversarial-A2 (plan-blind, Notes
box + dashboard + e2e). Reports in this directory.

Totals: conformance 158 CONFORMS / 1 PARTIAL / 0 MISSING / 9
DEVIATES-BY-RULING, 0 MUST-FIX, 2 SHOULD-FIX, 14 NOTEs; A1 0 CRITICAL / 0
HIGH / 1 MEDIUM / 7 LOW / 8 INFO; A2 0 / 0 / 1 MEDIUM / 5 LOW / 2 INFO.

Classes: FIX (fix wave FW1), FILE (an issue in docs/issues, out of this
branch's scope), NOTE (no action; carried to the handback where Cameron
should see it), REJECT (with the reason).

## FIX - fix wave FW1 (one fresh child)

| Id | Finding | Fix (scope) |
|---|---|---|
| FW1-1 | A1-1 MEDIUM CONFIRMED: a thrown `takeOver` in the stale-lease loop leaks its job slot for the life of the worker (job.ts ~617-643) | Acquire/release in the queued loop's shape: the slot is released in the stale loop's catch. Regression test in the poll tests (one slot, takeOver throws, `inUse()` back to 0, a later pass claims a newly queued record) - must FAIL with the fix reverted. |
| FW1-2 | A1-2 LOW CONFIRMED: a model call that completes after its job was stopped or superseded leaves no run record, so the spend is invisible | Spec D7 puts the generation check before EVERY write, the run included, so the run stays unwritten. PR36's own remedy for a lost run applies: on the stopped-after-call path, LOG the usage and the computed cost at WARN (the same fields as the putRun-failure log) so spend is never invisible; the two pinned tests keep "no run" and gain the log assertion. RUNBOOK's "spend is never invisible" sentence is made exact (a run record, or a WARN line with usage and cost). |
| FW1-3 | A1-4 (a) LOW CONFIRMED: a thrown final `finishJob` after every batch landed turns a scored job into `failed` "could not finish" | Retry `finishJob` once on a thrown error before the catch-all (safe: it is conditioned on status running AND the generation, and a lost condition answers false, never throws). Test: finishJob throws once then succeeds -> job `done`, no failure message. |
| FW1-4 | A2-1 MEDIUM CONFIRMED: `useAnchorRanking` applies full-read (and job-read) responses in arrival order; an earlier read can land last and leave a stale table under "Done" | One ordering rule in the hook: a full read's response is applied only if it is the latest issued for the current anchor key (sequence counter or abort-the-previous); job views older than the last applied one are dropped; concurrent job refreshes are de-duplicated. Tests: the A2-1 reproduction inverted (the earlier read answering last is dropped; final rows shown). |
| FW1-5 | A2-2 LOW CONFIRMED (= conformance N1): a Rank press answered before the first read is overwritten by that read's older job (poll stops) | Same hook: a read never replaces a job that a press or a newer job read set after the read was issued. Test: hold the first read, press (202 queued), resolve the read with job null -> job stays queued and the poll runs. |
| FW1-6 | A2-8 INFO: the press error and "(joined ...)" stay on screen after the followed job ends | Clear the press error and the joined mark when the followed job ends. Test. |
| FW1-7 | A2-5 LOW CONFIRMED: after a `notes_stale` refusal the edit form never tells the page, so after "Cancel to keep them" the page still shows the old notes and the next edit is refused again | In the notes_stale branch call `onStale?.()` (ContactDetail's existing consistent re-read; update its comment, which names only contact_type_changed). Test: a notes_stale refusal calls onStale once. Spec D14.3 follows the Staff notes card's pattern, which hands the current contact up. |
| FW1-8 | Conformance SF1 (the one PARTIAL, spec D11): the run detail marks "Since re-scored" but does not link the pair to its current match | Render the mark as a control that opens run `currentRunId` through RankingsSection's existing URL state (no server change). Test. |
| FW1-9 | Conformance N2: the cost totals' `truncated` flag is never shown (a silent low total, against PR34's "never a silent drop") | Show a short plain note when `truncated` is true, beside the existing `incomplete` note. Test. |
| FW1-10 | Conformance N3, N5: the done-with-losses status states the loss twice; "1 candidates" | When the job carries a server message, the page does not also append its own not-scored count; pluralize candidate counts. Tests. |
| FW1-11 | A2-4 LOW (the comment half), A2-7 INFO: wrong comments | apply.ts (~968-971, ~988-991): the extraction write replaces the box with the run's SNAPSHOT plus the new lines, so a staff save during the model call is lost (the known residual, issue extraction-text-field-write-races-staff-fill; spec section 4 keeps extraction unguarded). ContactEditForm.tsx ~440: the server stores `notes` as sent; the form's trim only decides whether the box changed. |
| FW1-12 | Docs: conformance SF2 (= A2-7), N12, N14; A1-7 | GLOSSARY: the conflict panel shows the current notes ABOVE the box; the card/pair "Fingerprint" entry says how it differs from the prompt fingerprint every run records. RUNBOOK: the old extraction "owed ops" text (~1694-1704) no longer says nothing breaks without ANTHROPIC_API_KEY (production requires it now); the ranking section notes that ranking and extraction share the key's rate limits (size RANKING_BATCH_CONCURRENCY / RANKING_MAX_CONCURRENT_JOBS against the tier); the "spend is never invisible" sentence per FW1-2. |

## FILE - issues (the fix-wave child writes them from docs/issues/_TEMPLATE.md)

- `ranking-job-lifecycle-robustness` (low, open): A1-3 (one THROWN renewal
  stops the job although two thirds of the lease remain; spec D7's "a
  renewal that fails stops the job" is the rule today - a change is a
  ruling), A1-4 (b) (an ambiguous progress write can list a scored batch as
  failed; `updateJobProgress` uses list_append, so a blind retry could
  duplicate entries - needs idempotent progress first), A1-6 (a hung step
  keeps renewing; no job-lifetime ceiling and no DynamoDB request timeout),
  A1-10 (shutdown does not release leases; the new worker waits out 90 s and
  re-runs in full). Each with the reviewer's interleaving.
- `ranking-unlawful-flag-stale-overwrite` (low, open): A1-5 - the flag
  write's condition (`attribute_not_exists OR textHash <> :textHash`) lets a
  job holding pre-edit text replace an OPEN flag raised for the current
  text; the record then reads closed and the field caps again until a later
  press re-raises it. Fix options: read the unit's current text before the
  write and skip a stale hash (narrows the window), or key the record by the
  hash (a record-key change, spec D10). Narrow race; B4 owns the flag
  display.
- `notes-box-line-readers-split-differently` (low, open): A2-6 - the write
  side folds CR / LF / U+2028 / U+2029 (singleLine.ts), but the retry guard
  and the caseworker signal split stored Notes on LF only, and the ranking
  attach step has its own split; VT / FF / NEL are not folded.
- `ranking-card-custom-fields-unclassified` (medium, open): A1-8 -
  `customFields` is on the tenant card by spec D2.1 (approved), but it is a
  container of staff-defined label/value pairs, so a field staff add later
  (a birth date, an income, a diagnosis) reaches the model and two 180-day
  stores (run inputGzip, match inputSnapshot) without classification, and
  the counterfactual check has no custom-field swap. A decision for Cameron
  (exclude, allowlist labels, or add a swap); raised in the handback.
- Append to `extraction-text-field-write-races-staff-fill`: A2-4 - the new
  `notes_updated_at` stamp now makes an extraction-side guard cheap
  (expect the snapshot's stamp; on a conditional failure re-read, re-filter,
  write once more).

## NOTE - no action (carried to the handback where marked *)

- A1-9 * no production-legal pause of ranking spend; removing
  ANTHROPIC_API_KEY now stops the app AND the worker from booting (spec D6
  requires the key in production; charter item 12: no switch).
- A1-11 no startup cross-check that RANKING_QUEUE_EXPIRY_MS exceeds
  WORKER_POLL_INTERVAL_MS (defaults 600000 vs 30000).
- A1-12 * `uflag#` rows carry no TTL (spec D10 by design); matches and runs of
  a HARD-deleted contact keep its name and card up to 180 days.
- A1-13 / N11 `matchesRepo.listByUnit` / `listByTenant` exist per spec D8
  with no caller in B2a (later slices).
- A1-14 the SDK honors ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN from the
  environment (pre-existing for extraction).
- A1-15 a renewal in flight when the job finishes can log a misleading WARN.
- A1-16 * one run's unlawful flag (a false positive included) lifts the cap
  for that field on every pair of the property until the text is edited -
  spec D10 by design; B4's dismissal is display-only.
- N4 raw field keys in the run detail copy (test surface; B3 builds the
  staff row).
- N6, N7 run-list / run-detail labels for an unread run and an all-omitted
  run.
- N8 the finish write is conditional on status AND generation (stronger
  than the spec's read-before-write) - do not "restore" the read.
- N9 the VA e2e ranks a seeded tenant (role check only).
- N10 gate-run-commands.md `<commit>` / `<fingerprint>`: filled at S9.1
  after the final code commit.
- N13 * a control "hit" needs the flag on a listed field (narrower than
  D17's wording); it fails safe (FAIL, Cameron decides).

## REJECT

- A2-3 (the U+2028 / U+2029 fold turns old AI runs' message hashes into a
  false "mismatch"): ACCEPTED BY SPEC. Spec D14.1 names this side effect
  ("rendered transcripts holding those characters change") and plan PR28
  lists it for Cameron at the handback. Not a defect of the build; carried
  to the handback as PR28 requires.
- A2-4 (the guard half: extraction overwriting a staff save): OUT OF SCOPE
  BY SPEC (section 4: "A guard on the importer's or extraction's Notes
  writes"; D14.3 keeps both unguarded). The comment is fixed (FW1-11) and
  the issue gains the cheap-guard note (FILE).
