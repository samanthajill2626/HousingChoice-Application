# Code review R1 - adversarial (plan-blind) - feat/wp1-b1-ranking-inputs @ 67d877cc

Reviewer: R1 adversarial, plan-blind (nothing under docs/superpowers/ was read).
Inputs: the b1-r1 diff package, the worktree, AGENTS.md, RUNBOOK.md,
docs/issues/, documentation/GLOSSARY.md. The probe-script slice was swept by
a sub-reviewer under the same rules; its findings below were each reproduced
with a throwaway test in that pass (deleted), and the ones marked "re-run"
were reproduced again by me. All throwaway files are deleted.

Counts: 1 HIGH, 3 MEDIUM, 8 LOW, 3 INFO.

## ADV-1 - HIGH - `--baseline` comparison PASSES with nothing measured

- Where: app/scripts/extraction-prompt-probe.ts:627 (compareDefaultSuites),
  :1496-1556 (runComparison, exit code at :1556).
- What happens: a failed call is verdict `failed`, which simply is not `ok`.
  compareDefaultSuites only compares ok counts (per case 2+ below, total more
  than 2 below) and branch truncations; it never asks whether either side was
  measured. If every call fails on BOTH sides (expired/wrong key -> 401, a
  mistyped `--model` -> 404, an outage, a rate-limit storm) both sides score 0
  and the gate prints `Attempt 1: PASS - branch ok 0, baseline ok 0`, appends
  `- Verdict: PASS` to the record and exits 0. If only the baseline side fails
  wholesale, the branch can miss every case and still pass. The plain suite
  (runDefault) already exits 1 on `failed > 0`; the merge gate does not.
- Proof: throwaway `app/test/_r1adv_core.test.ts` (re-run):
  `compareDefaultSuites(allFailed, allFailed).pass` -> `true` (expected false);
  branch all `missed` vs baseline all `failed` -> `true`. Sub-reviewer: full
  `main([... --baseline ...])` with a stub driver returning `failure:'driver'`
  for every call -> exit 0, record line `- Verdict: PASS (after 1 attempt(s))`.
- Fix: a case needs at least 2 non-failed runs on EACH side or it is "not
  measured" and FAILS the comparison (the never-written suite's
  MIN_GRADED_RUNS rule); count baseline truncations too. Add both scenarios
  as tests.
- Status: CONFIRMED.

## ADV-2 - MEDIUM - The grader's explicit EXCLUDED verdict is discarded when any sibling entry is malformed

- Where: app/scripts/extraction-prompt-probe.ts:896-924 (parseGraderOutput:
  unknown id :911, duplicate :912, missing item :921-922), :927-933
  (applyGrade), :956 (judgeCase tolerates one ungraded run).
- What happens: the structured-output schema cannot pin the item ids or their
  count, so an answer can say `line-1: excluded/religion` and omit (or
  misspell, or repeat) another item. parseGraderOutput then rejects the WHOLE
  answer, the run becomes `ungraded`, and its explicit excluded verdict never
  reaches `excludedLines`. One ungraded run in three is tolerated, so the gate
  exits 0 and "Grader verdicts to review" reads `- none`; the raw grader answer
  is not recorded. Contradicts the parser's own docstring ("a leak is never
  dropped for a missing label"). Backstop: the line is listed under "Lines the
  grader did not judge ... [read it]" for the human sign-off.
- Proof: throwaway (re-run): `parseGraderOutput('{"verdicts":[{"id":"line-1",
  "verdict":"excluded",...}]}', ['line-1','field-area_preference'])` ->
  `{ok:false, message:'no verdict for field-area_preference'}`. Sub-reviewer:
  full main, case excluded-religion-free, run 1 writes a mosque line plus a
  field value and the grader omits the field item, runs 2-3 clean -> exit 0,
  review section `- none`.
- Fix: parse entry by entry; keep every well-formed verdict alongside the
  error; any line explicitly judged excluded fails the case even in a partly
  parsed run and is listed for review; record the (asciiSafe, truncated) raw
  grader text of every ungraded run.
- Status: CONFIRMED.

## ADV-3 - MEDIUM - A one-case `--baseline` run appends an unmarked PASS, and the record header says the latest section counts

- Where: app/scripts/extraction-prompt-probe.ts:667 (renderComparisonRecord
  takes no partial flag), :1340-1346 (RECORD_FILE_HEADER: "the latest section
  of each suite is the one that counts"), :1496 (runComparison honors `--case`).
- What happens: natural workflow - the full comparison FAILS on case X, the
  operator re-runs `--baseline ... --case X`, it passes on noise, and a
  `- Verdict: PASS` section is appended as the latest section, which by the
  file's own rule is the one that counts. The never-written suite does mark a
  `--case` run PARTIAL (:1092-1096); the comparison does not. Both exit 0.
- Proof: sub-reviewer throwaway: `--baseline ... --case states-voucher` ->
  exit 0, section verdict `PASS (after 1 attempt(s))`, no PARTIAL marker. Code
  read confirms renderComparisonRecord has no partial input.
- Fix: pass `partial` into renderComparisonRecord; mark heading and verdict
  PARTIAL; print PARTIAL on the console for both suites; header: "a PARTIAL
  section never counts".
- Status: CONFIRMED.

## ADV-4 - MEDIUM - The prompt lost its ban on addresses in noteLines; the client's own address now passes to the Notes box

- Where: app/src/services/extraction/prompt.ts (main had, at :132-133, "-
  Addresses NEVER go in noteLines - the address output is the only place for
  address information." - removed with no replacement; the new FEEDBACK rule
  at :167 now ASKS for address labels in noteLines); the only remaining
  guard is app/src/services/extraction/apply.ts:285 (`isPostal`: a line that
  STARTS with "Current address" and has a digit).
- What happens: the ban was dropped wholesale to make room for feedback
  lines, but nothing re-scopes it to "the client's own address". A line such
  as "Lives at 55 Pine St, Decatur with her mother" or "Moving out of 55 Pine
  St, Decatur at the end of March" (a move-timing fact the widened noteLines
  rule now invites) is not caught by `isPostal` and is appended. The
  filterNoteLines comment still claims "Addresses are a structured target - a
  model that still narrates one is overridden (spec SS5)", which now holds
  only for the "Current address ..." shape. Consequences: the tenant's own
  (or previous) address duplicated into the box the B2 card reads, going
  stale when the structured address changes, and inflating
  `unlabeledAddressLines` (counted as an "attach miss" though it is not one).
- Proof: throwaway (re-run): the system prompt matches no address-in-noteLine
  ban (`bans: false`) and filterNoteLines appends both lines above
  (`appended: 2`, expected 0). Whether the model writes such lines is
  PLAUSIBLE, not measured (no API calls by mandate).
- Fix: re-add a scoped rule, e.g. "Never write the client's own address -
  current, previous or future - in a noteLine; the address output is the only
  place for it. An address appears in a noteLine only as a PROPERTIES SENT
  label, copied exactly." Add a prompt test pinning it, and a never-written
  style probe case for it.
- Status: CONFIRMED (prompt and filter); model behavior PLAUSIBLE.

## ADV-5 - LOW - A confidence outside 0..1 is clamped to 1 and silently clears the floor

- Where: app/src/services/extraction/apply.ts:251 (clampConfidence), used by
  filterNoteLines; schema `confidence: { type: 'number' }` has no bounds
  (app/src/services/extraction/schema.ts noteLines items).
- What happens: a model that answers on a percent scale (40 meaning 40%)
  gets `min(1, 40) = 1` and every line passes the 0.7 floor; notesBelowFloor
  reads 0, so nothing signals that the floor stopped working. The unsafe
  direction is the clamp itself: an out-of-range value is malformed, not
  maximal confidence.
- Proof: throwaway (re-run): filterNoteLines with `{text:'Might have a cat',
  confidence:40}` and `{text:'Maybe moving in March', confidence:65}`, floor
  0.7 -> `append: ['Might have a cat','Maybe moving in March']` (expected []).
- Fix: treat a confidence < 0 or > 1 as 0 (dropped and counted in
  notesBelowFloor), or count it as its own run-record number; test 40 and 1.5.
- Status: CONFIRMED.

## ADV-6 - LOW - A model `write` over a FILLED portion with a DIFFERENT number overwrites the staff value, no suggestion

- Where: app/src/services/extraction/apply.ts:383-388 (comment "The dollars
  kind keeps the pets rule"), :478-495 (write path).
- What happens: for text inputs B1 drops a write on a filled field
  (text_field_filled) so the model never rewrites staff text live. For
  max_tenant_portion the "same fact in a better form" write is kept - but for
  a whole-dollar number the better form of the same fact IS the same number,
  so the rule's only reachable effect is letting a mislabeled contradiction
  (model says `write` "900" over staff's 450) overwrite the value and stamp
  `max_tenant_portion_source` (Auto badge), with no chip. voucherSize has the
  same shape today; the portion is the ranker's budget input.
- Proof: throwaway (re-run): contact `{max_tenant_portion:450}`, op write
  "900" -> update writes `max_tenant_portion: 900`, 0 suggestions (expected
  no write, 1 suggestion).
- Fix: for the dollars kind, a write on a filled field whose coerced value
  differs routes to the suggest path with `demotedFrom:'write'` (as the
  not-on-list housingAuthority demotion does); an equal value is a no-op that
  does not re-stamp `_source` over a human-entered number.
- Status: CONFIRMED (behavior); judged against the code's own text-kind intent.

## ADV-7 - LOW - Lines in the one tolerated ungraded run never fail the gate, and the console does not say so

- Where: app/scripts/extraction-prompt-probe.ts:956-968 (judgeCase), console
  verdict at :1489-1494.
- What happens: by design 2 of 3 runs must be graded, so a refused / failed /
  malformed grader answer on the run that leaked is tolerated; a grader
  refusal is more likely on exactly the runs carrying sensitive text. The
  console prints the plain "PASS on every automatic check" with no hint that
  a run went unjudged (the record does list the lines).
- Proof: sub-reviewer throwaway: grader returns `refusal` only for the leaking
  run -> exit 0, console never mentions it.
- Fix: retry the grader once on an ungraded run; print "PASS with N ungraded
  run(s) holding M line(s)" on the console and the Verdict line.
- Status: CONFIRMED (behavior); acceptability is a spec call.

## ADV-8 - LOW - The therapist control tells the grader "PLANTED FACT: none"

- Where: app/scripts/extractionProbeNeverWritten.ts:339-349
  (control-assistance-animal), :153-156 (buildGraderUserContent).
- What happens: the message carries an excluded medical fact ("my therapist
  wrote the letter"), and the case's own `about` says the therapist must not
  be written, yet the grader is told the conversation planted nothing - on
  the one case built to test the dog-yes / therapist-no boundary.
- Proof: sub-reviewer: graderRequest for this case with the line "Has an
  emotional support dog; letter from her therapist" starts `PLANTED FACT:
  none`. Grader leniency from it is PLAUSIBLE.
- Fix: give the case a planted-fact description of the therapist, or split
  it into a control (dog written) and an excluded case (therapist not).
- Status: mismatch CONFIRMED; effect PLAUSIBLE.

## ADV-9 - LOW - The "same checkout" guard is case-sensitive on Windows

- Where: app/scripts/extraction-prompt-probe.ts:1500-1501.
- What happens: `path.resolve` keeps case, so `--baseline w:/X/branch`
  against `W:\X\branch` compares the checkout with itself (noise only, nearly
  always PASS) instead of exit 2.
- Proof: sub-reviewer throwaway: exit 0 with roots differing only by case.
- Fix: compare `fs.realpathSync.native` of both (also resolves junctions), or
  refuse when both sides report the same commit and a clean tree.
- Status: CONFIRMED.

## ADV-10 - LOW - A contradictory grader entry (clean, but naming an excluded kind) is accepted as clean

- Where: app/scripts/extraction-prompt-probe.ts:914-917.
- What happens: `{verdict:'clean', kind:'religion'}` parses as clean with the
  kind overwritten to 'none'; the docstring says anything malformed leaves
  the run ungraded.
- Proof: sub-reviewer throwaway: parsed kind `'none'`.
- Fix: treat clean + a non-'none' kind as ungraded (or list it for review)
  and keep the kind in the record.
- Status: CONFIRMED.

## ADV-11 - LOW - The never-written record's commit and dirty flag are read AFTER every call

- Where: app/scripts/extraction-prompt-probe.ts:1481 (runComparison reads it
  at load, :1506).
- What happens: a checkout change during the multi-minute run is certified
  as the commit that was measured.
- Proof: sub-reviewer throwaway: event order load, extract x3, git.
- Fix: read gitInfo before loadBranchModules; optionally re-check at the end
  and flag a change.
- Status: CONFIRMED.

## ADV-12 - LOW - The gate's endpoint, credential source and floor come from the operator's shell and are not recorded

- Where: app/src/adapters/extraction.ts:259 (newAnthropicClient passes no
  baseURL when none is given), app/scripts/extraction-prompt-probe.ts:317
  (factFloor reads EXTRACTION_FACT_MIN_CONFIDENCE from the shell).
- What happens: the SDK falls back to ANTHROPIC_BASE_URL (and reads
  ANTHROPIC_AUTH_TOKEN) from the environment, so a proxy or mock URL left in
  the shell silently redirects both the extraction and grader calls; the
  record shows only the key tail. A shell floor higher than the deployed one
  makes the gate judge fewer lines than production writes (the floor is
  printed, so this half is visible).
- Proof: reasoned from the SDK client constructor and the probe code; not
  executed (no network by mandate).
- Fix: pin `baseURL` (and `authToken: null`) in the probe, or print the
  effective base URL in the console and record; default the floor to the
  production value unless a flag names one, and warn when the shell sets it.
- Status: PLAUSIBLE.

## ADV-13 - INFO - The never-written list does not cover the four fields the ranker reads

- Where: app/src/services/extraction/prompt.ts (the list is scoped "NEVER
  write a noteLine stating ..."); app/scripts/extraction-prompt-probe.ts:951-956
  (judgeCase: "A field value judged excluded is counted, never a reason").
- What happens: area_preference / preferences_constraints have no
  never-written instruction ("near my mosque", "space for the baby due in
  March" can be written to a field), and the gate reports such a field leak
  but never fails on it. The code comments say this is the chosen scope;
  flagged so the merge decision takes it consciously, since B2 ranks on these
  fields.
- Status: INFO (design, per code comments).

## ADV-14 - INFO - A typo in EXTRACTION_FACT_MIN_CONFIDENCE takes the whole app down, even with extraction disabled

- Where: app/src/lib/config.ts:535 and :939 (parsed unconditionally, throws).
- What happens: the app and the worker refuse to start on a bad floor value
  regardless of AI_EXTRACTION_ENABLED, while the sibling extraction knob
  AI_EXTRACTION_DEBOUNCE_MS (:933) WARNs and falls back because "a debounce
  typo must never take the app down". Documented as fail-fast in RUNBOOK, so
  deliberate - but an extraction tuning knob can now crash-loop texting and
  the dashboard.
- Fix (optional): validate fail-fast only when extraction is enabled, or WARN
  and fall back to 0.7 like the debounce.
- Status: INFO.

## ADV-15 - INFO - Probe test gaps

- No test covers ADV-1, ADV-2 or ADV-3.
- app/test/extractionPromptProbe.test.ts:205-215 ("every request carries ...
  blocks") has no non-empty guard and no exit-code assertion: it passes
  vacuously if nothing runs; :960-971 is titled "interleaved" but never
  asserts interleaving.
- Nothing exercises the real loadBaseModules / loadBranchModules /
  appendRecordFile / gitInfoOf; most failures there are loud (exit 1), but a
  wrong sent-block module path would silently drop PROPERTIES SENT from the
  branch side of the comparison.
- `main` fills omitted deps from defaultDeps() (env = process.env); a future
  test that omits `env` and `createGrader` would reach the real API.
- Status: INFO.

## Swept with no finding

- Contacts PATCH / create (app/src/routes/contacts.ts): parseTenantMatchingInputs
  (trim, 500 cap after trim, '' / null -> REMOVE, dollars integer 0..20000,
  0 kept as a value); provenance clear via PROVENANCE_FIELDS for all four;
  pending-suggestion supersede on a human edit; create skips nulls.
  contactsRepo.update SET / REMOVE semantics for 0 and null.
- Staff vs model value rules: coerceField (text trim / 500 drop; dollars
  `$ , space` strip, digits only, <= 20000) and the accept path
  (suggestionResolution coerceAccept -> coerceField) agree with the staff rule;
  a suggestedValue is always String(coerced) so its accept cannot refuse it;
  dismissal normalization; TENANT_ONLY_TARGETS fence (409 on non-tenant,
  classification_revision guard).
- text_field_filled: checked before coercion, after wrong_contact_type, never
  in demotedFields; decisions.ts explains it (no unexplained-drop error).
  Snapshot race already filed (extraction-text-field-write-races-staff-fill).
- filterNoteLines: floor first, blank / postal / retry guard before the cap,
  system lines unfloored, demotion last; ApplyOutcome.appendedLines equals
  what is joined into notes; the fake driver's legacy string items are dropped
  uncounted (documented). parseExtractionText keeps 20 structurally valid items.
- Job: PROPERTIES SENT read only for tenant / unknown (landlord / partner /
  team_member skip earlier); listByContact returns listed rows; requireComplete
  read of <= 20 unique ids; a failed read fails the run (documented in
  RUNBOOK); fingerprint recorded before the call; feedback counts are
  draftPiece best-effort. IAM: the shared instance role already grants
  Query / BatchGetItem on every table and index (infra/modules/ec2/main.tf).
- sentPropertiesBlock / propertyLabel: control characters folded to spaces
  (no line forging from a unit address; units are created only by staff
  routes), TRANSCRIPT lines dropped, budget arithmetic matches the joined text,
  identical labels once, labelMatches boundary logic, hasStreetAddress bounded
  (no catastrophic backtracking at 200 chars). prompt.ts keeps the block
  before the TRANSCRIPT header; the profile JSON escapes newlines.
- runTypes / schema / decisions / journal sweep: sixteen targets derived from
  the list everywhere (listJournals keys, SWEEP_MAX_ATTEMPTS_PER_CALL, schema
  required keys, ops view); no stale hard-coded twelve in runtime code.
- Structured-output client: SDK stays in app/src/adapters; refusal and
  max_tokens classified before usage; never throws; no test reaches the
  network; invokedDirectly is false under vitest.
- Priority switch: unitFields 'boolean', flyer allowlist excludes it (pinned),
  ListingEditForm / UnitCreateForm send only on change / when checked, legacy
  string reads off; the importer parses an Airtable "Priority" column but never
  writes it; no seed holds priority; no other app or dashboard reader.
- Dashboard: tenantMatchingInputs mirror + drift test; buildTenantMatchingPatch
  matches the server rule (pinned by the drift test); edit form diffs against
  the contact as opened; EligibilityIntakeCard rows / chips / AutoBadge via
  `<key>_source`; SUGGESTION_TARGET_LABEL from the list; AiRunDetail target
  order and Notes lines region; no server-side projection strips the new run
  record fields.
- Other readers / writers: no contact export or field-copy path; the
  Possible caseworkers ai_note signal (lib/caseworkers.ts) still parses the
  `[Auto - ...]` prefix (the demotion and floor effects on it are already
  recorded in voice-extraction-window-demotion-persistence); the import and
  edit-form Notes overwrites are already filed (import-overwrites-notes-box,
  contact-edit-form-notes-save-drops-auto-lines).
