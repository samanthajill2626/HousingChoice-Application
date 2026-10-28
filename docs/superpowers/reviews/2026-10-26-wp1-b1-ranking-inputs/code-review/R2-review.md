# Code review R2 - fresh re-review after fix wave FW1 - feat/wp1-b1-ranking-inputs @ 0f271f74

Reviewer: R2 (fresh), Claude Opus 5.5, 2026-10-27. Merge base main @ d0e2c2d8.
Inputs: BRIEF-r2.md, R1-adversarial.md, R1-conformance.md, R1-adjudications.md,
FW1-report.md, the FW1 diff (f24fe99e..0f271f74), the full branch diff, the
spec (adjudication checks only), the live tree, AGENTS.md.

Method: the FW1 diff read cold, then the branch's runtime code (contacts
route, tenantMatchingInputs, apply.ts, jobs/extraction.ts,
sentPropertiesBlock, propertyLabel, unitsRepo, suggestionResolution, schema,
prompt, adapters, dashboard edit form / intake card / chips / run detail /
property forms) with a grep of every other reader of the state B1 touches.
Throwaway tests (all DELETED): `app/test/_r2_noteguard.test.ts`,
`dashboard/src/routes/contact/_r2_badinput.test.tsx`; a static form page in the
scratchpad driven through the project Playwright MCP's bundled Chromium (a
data: URL, no app, no lane); a temp git repo in the scratchpad. One
in-place mutation of extraction-prompt-probe.ts:1117 (FW-2 check), restored
with the Edit tool. No API call, no key read, no e2e session, no full suite.
`git -C W:/tmp/wp1-b1-ranking-inputs status` is clean.

Counts: CRITICAL 0, HIGH 0, MEDIUM 1, LOW 2, INFO 0.
By class: REGRESSION 3 (R2-1 breaks B1's own D5.2 behavior; R2-2 and R2-3 are
in FW1's own changes), NOT A REGRESSION 0.

## 1. What R1 missed

## R2-1 - MEDIUM - The Notes retry guard silently drops a feedback line that changes the tenant's mind back to earlier words, or that names a different property whose label ends another's

- Where: app/src/services/extraction/apply.ts:289-290 (`alreadyPresent`:
  `existingNotes.includes(`${prefix} ${line}`) || existingNotes.includes(line)`),
  applied to every model line at :303 and every system line at :308.
  Against: spec D5.2 (design.md:379-380, and prompt.ts:181 tells the model
  the same) "feedback already recorded is not repeated; a CHANGE of mind is a
  new line"; app/src/lib/propertyLabel.ts:79-88 (labelMatches matches a label
  only at a boundary precisely so 12 and 112 differ).
- What happens: the guard exists for one case - a complete() failure re-arms
  the SAME due row and the retry re-extracts the SAME transcript minutes
  later. But it is a bare SUBSTRING test against the whole Notes box, so it
  also drops, on any later run:
  1. A flip back. Oct 20 "412 Oak Ave, Decatur: on the fence", Oct 22 "412
     Oak Ave, Decatur: likes it", Oct 27 the tenant is unsure again and the
     model - as D5.2 tells it - writes the change of mind "412 Oak Ave,
     Decatur: on the fence" (the prompt itself suggests that phrase). The
     line is already in the box verbatim, so it is dropped; the newest
     feedback the box (and B2's ranker, which reads it) carries for that home
     is "likes it". The same holds for a no -> yes -> no flip, and for a
     shorter line contained in an older longer one ("likes it" inside "likes
     it, worried about the commute").
  2. A different property. "12 Oak St, Decatur: likes it" is a substring of
     an earlier "112 Oak St, Decatur: likes it", so feedback on 12 Oak St is
     dropped although labelMatches (and countFeedbackLines) treat the two as
     different homes.
  Nothing counts a guard drop (notedLines is just lower; there is no
  run-record field), so the loss is invisible except by comparing the AI
  run's Parsed result with the Notes box.
- Proof: throwaway `app/test/_r2_noteguard.test.ts` (deleted), two cases
  calling filterNoteLines with floor 0.7, prefix "[Auto - Oct 27]":
  (a) existingNotes = the Oct 20 and Oct 22 lines above, model line "412 Oak
  Ave, Decatur: on the fence" (confidence 0.95) -> expected append [that
  line], RECEIVED [] - FAIL; (b) existingNotes "[Auto - Oct 20] 112 Oak St,
  Decatur: likes it", model line "12 Oak St, Decatur: likes it" ->
  `labelMatches('112 Oak St, Decatur: likes it', '12 Oak St, Decatur')` is
  false (passes) but append RECEIVED [] - FAIL. Run:
  `env -u ANTHROPIC_API_KEY -u AI_EXTRACTION_MODEL npx vitest run test/_r2_noteguard.test.ts`
  -> 2 failed, exit 1. The filter behavior is CONFIRMED; that the model
  repeats the exact earlier wording is PLAUSIBLE (the prompt hands it the
  phrase "on the fence" and tells it to copy the label exactly).
- Fix: scope the guard to what it is for - drop a candidate only when a
  WHOLE line of the box equals `${prefix} ${line}` (same run date, so a
  retry of the same transcript), never on a bare substring; a flip back on a
  later date gets a new prefix and is kept. If the bare check must stay for
  another reason, make it whole-line equality, not `includes`. Count guard
  drops on the run record. Note the spec tension for Cameron: D4
  (design.md:266) keeps "the verbatim retry guard" as is, which is what
  breaks D5.2 here.
- Status: CONFIRMED (mechanism); model wording PLAUSIBLE.
- Class: REGRESSION (a defect R1 swept past - "filterNoteLines ... Swept with
  no finding" - that breaks B1's own D5.2 feedback behavior).

Swept with no new finding (beyond R1's list): every reader of `priority`
(all `=== true`; the Airtable parser's string is never written); every reader
of `noteLines` / `rawResult` (the run detail JSON.stringifies it; no React
child reads the new object shape); every drop-reason and target label map
(`text_field_filled` and the four chip labels present); the only
`driver.extract` caller passes `sentPropertiesBlock` (required in the type);
`hasAiCaseworkerNote` matches line STARTS, so feedback lines cannot trip it;
no contact merge path exists; the public intake does not use the contacts
parsers; MAX_OUTPUT_TOKENS is unchanged at 4096 (the gate measures
truncation); no import cycle from suggestionResolution -> apply.

## 2. The FW1 diff reviewed cold

## R2-2 - LOW - FW-11 guards a path no real browser reaches; selectors.md:60 now documents a refusal Chromium never shows

- Where: dashboard/src/routes/contact/ContactEditForm.tsx:488-491 (reads
  `validity.badInput` at Save), :692 (`<form id="contact-edit-form">` has NO
  `noValidate`), :686 (Save is a `type="submit"` button tied by `form=`),
  :958 (the portion `type="number" step="any"`); e2e/support/selectors.md:60
  (FW-11/FW-12 text); docs/issues/number-input-unparseable-entry-silently-ignored.md:19.
- What happens: a number input holding text it cannot parse is "suffering
  from bad input", i.e. INVALID, so the browser's interactive validation
  refuses the submission and shows its own bubble ("Please enter a number.");
  the `submit` event never fires and React's onSubmit - where FW-11's check
  lives - never runs. FW-11's code and tests are correct in jsdom only,
  because the tests stub the element's `validity` property while jsdom's own
  validation (which gates submit) still sees a valid control. Consequences:
  (1) the original CONF-1 data loss ("an unparseable entry clears a stored
  portion") was not reachable in Chromium in the first place, and FW-11
  changes nothing a staff member sees; (2) spec D2's "the client-side
  message for a bad portion matches the server's" is still unmet for such an
  entry - the browser's words show, not the server's copy; (3) selectors.md:60
  now tells e2e authors "the form reads validity.badInput at Save, so such an
  entry is refused" in the form's role="alert" - a spec written to that
  would find no alert; (4) the filed issue says "Save succeeds, the entry is
  dropped without a message" for the pre-existing inputs, which Chromium
  contradicts too.
- Proof: (a) Chromium 155.0.8059.12 (the project Playwright MCP's bundled
  browser), a data: page mirroring the form: `<form id=...>` without
  noValidate, `<input type="number" step="any" value="900">`, Save outside
  the form with `form=`. Typed "1e" -> value "", badInput true, valid false,
  validationMessage "Please enter a number."; click Save -> submit did NOT
  fire; Enter in a sibling text input -> did NOT fire; typed "12.5" -> valid,
  submit fired. Typing "1,200" or "$1200" lands as "1200", "abc" types
  nothing, "1.2.3" lands as "1.23" - Chromium drops what it cannot parse as
  it is typed. (b) throwaway `dashboard/src/routes/contact/_r2_badinput.test.tsx`
  (deleted): FW-11's exact stub (`Object.defineProperty(input, 'validity',
  { value: { badInput: true } })`) -> `input.validity.badInput` true but
  `form.checkValidity()` true and a Save click submits; the same form with
  the input `required` and empty -> checkValidity false, no submit (jsdom
  does gate submit on real validity). 1 passed. Firefox not observed (it also
  reports badInput as a validity error; PLAUSIBLE that it blocks the same way).
- Fix: correct selectors.md:60 - an unparseable portion entry is refused by
  the BROWSER's own validation bubble before Save runs (no role="alert"); the
  form's role="alert" covers parseable bad values only. Either accept the
  browser message as the D2 deviation for that case (Cameron's call) or, to
  meet D2, render the portion `type="text" inputMode="numeric"` (CONF-1's
  option a) - then FW-11's ref and stubbed tests can go. Re-check the filed
  issue in Chromium and Firefox before anyone builds its "shared helper".
- Status: CONFIRMED (Chromium); Firefox PLAUSIBLE.
- Class: REGRESSION (the selectors.md:60 claim is FW1's; the code is
  harmless dead weight in a browser).

## R2-3 - LOW - FW-6 can fail a never-written gate run on a records-only change, because the dirty flag counts the record file once it is committed

- Where: app/scripts/extraction-prompt-probe.ts:1569-1573 (gitInfoOf: `git
  status --porcelain --untracked-files=no` over the WHOLE checkout), :1543
  (the dep's doc assumes "the record file itself is untracked"), :1675 /
  :1724-1725 (FW-6: read before and after, any change FAILS the run),
  :1773 (the comparison reads it once per side at load). The record path is
  inside the measured checkout (spec design.md:573:
  docs/superpowers/reviews/2026-10-26-wp1-b1-ranking-inputs/never-written-test.md),
  and AGENTS.md:55 requires mission records to be committed AS PRODUCED.
- What happens: once the first gate record is committed (a FAIL record is
  committed as produced too), the record is a TRACKED file. Then (a) every
  gate command after the first in a session certifies "@ <commit> (tracked
  files modified)" because the previous command appended to the record -
  the comparison's Branch line, or the never-written "- Commit:" line when it
  runs second; and (b) new with FW-6: if the record is appended by the other
  gate command, or committed by the orchestrator following AGENTS.md, while a
  never-written run is in flight, the dirty flag or the commit flips between
  the two reads and the run FAILS "the checkout changed during the run",
  although no measured code changed - a wasted paid gate run (every case x 3
  extraction calls plus grader calls).
- Proof: temp git repo (deleted): commit `docs/never-written-test.md`, then
  `git status --porcelain --untracked-files=no` prints nothing; append a
  section to the record -> ` M docs/never-written-test.md` (gitInfoOf would
  return dirty: true). FW-6's own test "tracked files modified during the
  run fail it too" (extractionPromptProbe.test.ts) shows any such flip exits
  1. The flip during a run needs a concurrent append or commit: PLAUSIBLE.
- Fix: certify the measured code, not the records: exclude the `--out` file
  (or the records directory) from the dirty check
  (`git status --porcelain --untracked-files=no -- . ':(exclude)<out>'`)
  and compare the before/after commits on the measured paths only (for
  example `git diff --quiet <before> <after> -- app/`), or tell the gate
  sheet to commit the record only after both commands finish and never to
  run them in parallel.
- Status: PLAUSIBLE (git behavior and FW-6 logic CONFIRMED; the in-flight
  trigger is a workflow assumption).
- Class: REGRESSION (FW-6 introduced the fail path; the "(tracked files
  modified)" marking predates FW1).

Reviewed cold with no finding:
- FW-1: measured = verdict not `failed` (outcomeOf :502 maps every non-ok
  call to `failed`); bySide slots are indexed `ci * GATE_RUNS + r`, so
  scoreSide's per-case slices are right despite the interleaving; the
  re-run then fails a dead endpoint (exit 1).
- FW-2: parseGraderOutput walked by hand for conflicting repeats in both
  orders, a "clean naming a kind" entry plus an "excluded" entry for the same
  id (excluded kept), unknown ids, malformed verdicts (answered, not also
  "missing"); applyGrade keeps only excluded verdicts of a malformed answer;
  judgeCase counts them (mutation below); raw text is asciiSafe'd, one line.
- FW-3: PARTIAL in both suites' console, the comparison heading and verdict,
  the never-written closing line; the header text only reaches new files.
- FW-4: both roots pass through the same canonicalRoot, so a W: mapped drive
  realpath'd to its UNC form on one side matches the other; a missing root
  keeps its resolved form and fails loudly later.
- FW-5, FW-7, FW-8 (host only - userinfo, path, query and the token value
  never printed; the SDK falls back to ANTHROPIC_BASE_URL because the probe's
  createDriver/createGrader pass no apiBaseUrl), FW-9, FW-10 (call order is
  deterministic: pool workers take jobs in index order and the stub records
  synchronously), FW-12 (no other maxlength pin in dashboard or e2e), FW-15
  (no max_tenant_portion literal left in the probe).

## 3. Adjudication challenges

- CONF-1 -> FW-11 (MUST-FIX, R1-adjudications.md FW-11): the ruling rests
  on a jsdom-only reproduction (R1-conformance.md CONF-1 "NOT exercised in a
  real browser"). In Chromium the data-loss scenario does not occur (R2-2);
  the real deviation from spec D2 (design.md D2, "the client-side message
  for a bad portion matches the server's") is that the BROWSER's message
  shows for an unparseable entry, which FW-11 cannot change while the
  control is type="number" inside a validating form. The orchestrator-owned
  FILE (docs/issues/number-input-unparseable-entry-silently-ignored.md) carries
  the same unverified premise ("Save succeeds, the entry is dropped without a
  message", :19) and should be re-checked in a browser before it is worked.
- FW-9 vs spec D7 (design.md:535-537: "Each excluded case carries a PLAIN
  DESCRIPTION of the fact it plants ... Control cases plant none."): the
  fix gives a CONTROL a planted fact. Sensible, but it departs from the
  spec's text and is not listed as a deviation for Cameron's sign-off
  (ADV-8's other option - split into a dog control and a therapist
  excluded case - matched the spec). Related, INFO: the planted fact is in
  neither the grader fingerprint (graderPromptFingerprint hashes a
  '<planted fact>' placeholder, probe :1100-1105) nor the per-case content
  hash (extraction user content only), so a change like FW-9's is invisible
  to the record's "a change to any of these after a passing run requires a
  new run" check (design.md D7); the FW1 report notes no record exists yet.
- Upheld after checking the spec text: ADV-4 (design.md:381-391: the
  no-address bullet REMOVED "with nothing in its place"), ADV-5 (D4 :251
  "clamp ... confidence to 0..1"), ADV-6 (D3: "max_tenant_portion keeps the
  pets rule, including a same-fact write"), ADV-7 retry part (D7 "ONE grader
  call"), ADV-13 (D7 "A field value so judged is REPORTED, not failing"),
  ADV-14 (D4 "parsed fail-fast ... startup throws"). R2-1 is not a challenge
  to ADV-4 but a separate spec tension: D4 :266 keeps the verbatim retry
  guard, D5.2 :380 wants a change of mind written.

## 4. FW items verified

- FW-1: REAL - five unit cases plus the full-main stub run; scoreSide's
  per-case slicing is correct under the interleaved slots.
- FW-2: REAL - in-place mutation of probe :1117 back to
  `r.grading === 'graded' ? r.items : []` fails 3 tests (judgeCase scenario,
  record lists the line, main exits 1); restored, 119 passed, status clean.
- FW-3: REAL.
- FW-4: REAL.
- FW-5: REAL.
- FW-6: REAL (with R2-3's records-only false-FAIL path).
- FW-7: REAL.
- FW-8: REAL.
- FW-9: REAL as ruled (see the spec-text challenge).
- FW-10: REAL.
- FW-11: PLAUSIBLE ONLY - real in jsdom; in Chromium native validation
  intercepts first, so the fix changes nothing a user sees and its doc text
  is wrong (R2-2).
- FW-12: REAL - guarded by the "no maxlength" pin only; the new 501-character
  case passes with maxLength present (programmatic value), as FW1 disclosed.
- FW-13: REAL - RUNBOOK.md:1519-1540 matches compareDefaultSuites.
- FW-14: REAL.
- FW-15: REAL - no max_tenant_portion literal, closing line, spellings fixed.
- FW-16: REAL (comment only; matches isPostal at apply.ts:288).
