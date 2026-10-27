# Code review R1 - adjudications (build orchestrator, 2026-10-27)

Reviewed head: 67d877cc (all five gates green there). Sources in this
directory: `R1-conformance.md` (spec-conformance; 145 rows: 142 CONFORMS,
1 PARTIAL, 2 MISSING pending by design; 1 LOW, 6 INFO) and
`R1-adversarial.md` (plan-blind; 1 HIGH, 3 MEDIUM, 8 LOW, 3 INFO). The
orchestrator re-read ADV-1 (compareDefaultSuites has no "measured" check) and
the CONF-1 code path before ruling.

Rule used: a CONFIRMED defect in new B1 code is fixed in the one fix wave
(FW1) when it is in scope and cheap; a finding that contradicts an explicit
spec decision or planner ruling is recorded BY DESIGN and surfaced to Cameron
in the handback; a pre-existing class outside B1 is FILED. The probe is B1's
merge gate, so anything that lets it report PASS without a real measurement
is a must-fix regardless of the reviewer's severity.

## Fix wave FW1 (binding list; one child, sequential)

| FW | Source | Ruling | What |
|---|---|---|---|
| FW-1 | ADV-1 HIGH | MUST-FIX | `--baseline`: a case needs at least 2 MEASURED runs (the extraction call returned a result: not a driver/refusal/parse failure, not a truncation) of its 3 on EACH side, else it is "not measured on <side>" and the comparison FAILS. Tests: both sides all failed; baseline all failed; branch all failed; a full `main` --baseline run whose stub driver fails every call exits 1 with a FAIL record. |
| FW-2 | ADV-2 MEDIUM | MUST-FIX | Grader answers are parsed entry by entry: an entry that judges a KNOWN item `excluded` counts as an excluded line (fails its case, listed under "Grader verdicts to review") even when the answer as a whole is malformed; the run stays UNGRADED for the 2-of-3 bar (planner decision 11 otherwise unchanged); a repeated id with conflicting verdicts keeps `excluded`. The record carries the raw grader text of every ungraded run (asciiSafe, truncated). Tests. |
| FW-3 | ADV-3 MEDIUM | MUST-FIX | A `--case` comparison run is PARTIAL: heading and Verdict say PARTIAL (not a gate run), the console says so for both suites, and the record file header says a PARTIAL section never counts. Test. |
| FW-4 | ADV-9 LOW | MUST-FIX | The same-checkout guard compares canonical paths (resolved; realpath when it exists; case-insensitive on win32). Test: roots differing only by case exit 2. |
| FW-5 | ADV-10 LOW | MUST-FIX | A `clean` verdict naming a kind other than `none` is a malformed entry: the run is UNGRADED and the item is listed for review with the kind it named. Test. |
| FW-6 | ADV-11 LOW | MUST-FIX | The never-written run reads the commit and dirty flag BEFORE the first call and again after the last; a change FAILS the run ("the checkout changed during the run") and the record shows both. Test via injected git info. |
| FW-7 | ADV-7 LOW | SHOULD-FIX (part) | The console verdict and the record's Verdict line state ungraded runs: "N ungraded run(s) holding M line(s) - read them under 'Lines the grader did not judge'". No grader retry: spec D7 says ONE grader call per run. Test. |
| FW-8 | ADV-12 LOW (PLAUSIBLE) | SHOULD-FIX (part) | The console and the record print the effective API base URL host (`ANTHROPIC_BASE_URL` from the injected env, or "default") and whether `ANTHROPIC_AUTH_TOKEN` is set (yes / no, never a value). The floor source stays as PR35 rules (already printed). Test with injected env. |
| FW-9 | ADV-8 LOW | SHOULD-FIX | The assistance-animal control's message carries an excluded fact by design (the therapist); the grader is told so instead of "PLANTED FACT: none". The case stays a CONTROL scored on the dog line. If the data model ties a planted fact to excluded-case scoring, use a separate optional field fed to the grader the same way. Update the pin. |
| FW-10 | ADV-15 INFO | SHOULD-FIX | extractionPromptProbe.test.ts: the "every request carries ... blocks" case gains a non-empty guard and an exit-code assertion; the "interleaved" case asserts the interleaving or is retitled to what it proves. |
| FW-11 | CONF-1 LOW | MUST-FIX | The portion control keeps `type="number"` (spec D2, PR26) but an UNPARSEABLE entry (`validity.badInput`) is refused at Save with the server's copy, never read as a clear (today it sends `max_tenant_portion: null` and removes a stored value). Tests with a stubbed `validity`: stored 900 + bad entry -> alert, no update; nothing stored + bad entry -> alert. Correct e2e/support/selectors.md:60 to what the form does. |
| FW-12 | CONF-6 INFO | SHOULD-FIX | Drop `maxLength={500}` from the three text controls, so an over-long value reaches the client refusal with the server's copy instead of a silent cut that also counts surrounding spaces. Update any pin. |
| FW-13 | CONF-3 INFO | SHOULD-FIX | RUNBOOK: the merge gate is BOTH commands (`--suite never-written` and the `--baseline` comparison); the comparison also fails on a branch truncation and on a case not measured on either side (FW-1). |
| FW-14 | CONF-4 INFO | SHOULD-FIX | docs/issues/extraction-fields-to-notes.md gains a line: no reader consults the list's `source` today, so the later move must make the readers filter on it (or remove the entry). |
| FW-15 | CONF-7 INFO | SHOULD-FIX | The probe's `withRecorded` finds the dollars kind through the list (no `max_tenant_portion` literal); the CLI closing line on a passing `--case` run matches WL-33 (PARTIAL, not a gate run, no sign-off); American spelling in three comments (extraction-prompt-probe.ts "recognised", AiRunsSection.test.tsx and tenant-matching-inputs.spec.ts "labelled"). |
| FW-16 | ADV-4 (comment part) | SHOULD-FIX | The apply.ts note-path comment that says a narrated address "is overridden (spec SS5)" is stale since the no-address bullet was removed: reword it to what the postal filter does (drops only lines starting "current address" with a digit) and why addresses may now appear (feedback lines name sent properties). |

## Orchestrator-owned

- FILE: the pre-existing number-input class CONF-1 found in the Rent min /
  Rent max / Payment standard / Voucher size inputs (an unparseable entry
  reads as a clear) - a tier-2 issue, not fixed in B1.

## By design - recorded, surfaced to Cameron in the handback

- ADV-4 (MEDIUM, plan-blind): the prompt's no-address bullet was removed with
  nothing in its place by Cameron's launch-gate decision (spec rev 9 D5.2;
  charter section 20 item 9; PR50). The reviewer, blind to that, rated the
  consequence MEDIUM: the client's own address in shapes other than "Current
  address ..." is no longer kept out of the Notes box. Not changed. Offer: a
  never-written control "the client states their own address beside
  feedback -> no noteLine carries it" if Cameron wants it measured at the gate.
- ADV-5 (LOW): spec D4 says confidence is CLAMPED to 0..1, so an out-of-range
  value (a percent-scale 40) clears the floor. Per spec.
- ADV-6 (LOW): spec D3 keeps the pets rule for max_tenant_portion, so a model
  `write` with a different number over a filled portion lands (Auto badge, no
  chip). Per spec; the portion is a ranker input - Cameron's eye.
- ADV-7 (retry part): no grader retry - spec D7, one grader call per run.
- ADV-12 (floor part): PR35 fixes the probe's floor source; printed.
- ADV-13 (INFO): the never-written list does not govern the four fields -
  spec D3 / charter 20.2 by design; the gate reports a field leak.
- ADV-14 (INFO): a bad EXTRACTION_FACT_MIN_CONFIDENCE stops startup even with
  extraction off - spec D4 fail-fast by design.
- ADV-15 (last two bullets): the module loaders and default deps are not unit
  tested end to end - recorded.
- CONF-2 (INFO): the gate run is Cameron's (PR1); self-qa.md and
  gate-run-commands.md are the orchestrator's S7.5 / S7.6 (WL-42).
- CONF-5 (INFO): the spec's street-suffix pattern over-counts
  `unlabeledAddressLines` (a count only); B2 reads it as an upper bound.
