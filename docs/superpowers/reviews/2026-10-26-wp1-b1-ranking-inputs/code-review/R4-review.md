# Code review R4 - fresh re-review after fix wave FW3 - feat/wp1-b1-ranking-inputs @ aca3ccda

Reviewer: R4 (fresh), Claude Opus 5.5, 2026-10-27. Merge base main @ d0e2c2d8.
Inputs: BRIEF-r4.md, R3-review.md, R3-adjudications.md, R2-adjudications.md
(loop rule), FW3-report.md, FW2-report.md, the FW3 diff package
(626e7f06..aca3ccda), earlier records for context, the spec, the live tree,
AGENTS.md.

Method: the FW3 diff read cold; then the Notes box readers and writers
(apply.ts filterNoteLines and the notes block, jobs/extraction.ts window and
counts, prompt.ts as a whole, lib/caseworkers.ts, the probe's writtenLines)
and the probe's git checks on BOTH gate commands. Throwaway tests (all
DELETED before handback): `app/test/_r4_cmpgit.test.ts` (1 case, FAILS on
the head) and `app/test/_r4_guard.test.ts` (2 cases FAIL on the head, 1
passing demonstration). Run as
`env -u ANTHROPIC_API_KEY -u AI_EXTRACTION_MODEL npx vitest run test/<file>`.
Also at the head: extractionNoteLines, extractionSchema, extractionPromptProbe
-> 217 / 217 green. No in-place revert, no API call, no key read, no probe
run, no e2e, no full suite; read-only git. `git status` is clean apart from
this file (untracked; the orchestrator commits it).

Counts: CRITICAL 0, HIGH 0, MEDIUM 0, LOW 1, INFO 2.
By class: REGRESSION 2 (R4-1, R4-3), NOT A REGRESSION 1 (R4-2).

## 1. What earlier rounds missed in the state FW3 touches

## R4-1 - LOW - The --baseline comparison, the other half of B1's merge gate, still passes certifying "unknown (git failed)" on both sides

- Where: app/scripts/extraction-prompt-probe.ts:1825-1836 (runComparison
  reads `gitInfoOf` once per side, after the load, and never checks
  GIT_FAILED), :767-768 (the record's "- Branch: ... @ <commit>" /
  "- Baseline: ... @ <commit>" lines), :1884 (the exit code follows the
  comparison alone); FW3-3's check sits in runNeverWritten only (:1761-1766).
  RUNBOOK.md:1536-1537: "WP1 B1's merge gate is BOTH commands - the
  `--baseline` comparison and `--suite never-written` - each passing on the
  final prompt." Spec D7 (design.md:496-503): the default suite is "ALSO part
  of the gate ... Both results go in the same record"; (design.md:559-562)
  "The record carries the commit ... A change to any of these after a passing
  run requires a new run." R3-adjudications.md:52-57 rules for this very
  suite that "the commit line is the certificate".
- What happens: R3-2's mechanism, on the gate command FW3-3 did not touch.
  When git cannot answer for a checkout (the R3-2 trigger: git absent from
  PATH, or git refusing a mapped network drive as W: is), both sides read
  `{ commit: 'unknown (git failed)', dirty: false }`, every call runs, and
  the comparison PASSES with exit 0, appending a record whose Branch and
  Baseline commits identify nothing. The prompt fingerprint on each line
  pins the prompt and schema, but not the driver code
  (adapters/extraction.ts: thinking setting, max_tokens) or which main was
  the baseline, so the D7 "a change after a passing run requires a new run"
  rule cannot be applied to it. FW3-3's own principle ("no readable commit,
  no certificate") is thus applied to one of the two gate commands. (Related,
  not new: a never-written run whose checkout is dirty BEFORE the first call
  also certifies a commit that is not the measured code; FW-6 chose to label
  it "(tracked files modified)" rather than fail it.)
- Proof: throwaway `_r4_cmpgit.test.ts`: the injected GitRunner answers 128
  to every command, a stub driver answers every default case correctly;
  `main(['--model','claude-sonnet-5-5','--baseline','W:/probe-test/main',
  '--out','rec.md'])` -> expected a non-zero exit, RECEIVED 0 after 60 stub
  calls, record lines "- Verdict: PASS (after 1 attempt(s))",
  "- Branch: W:\probe-test\branch @ unknown (git failed), prompt
  fb0aabde1690", "- Baseline: W:\probe-test\main @ unknown (git failed),
  prompt fb0aabde1690" - FAIL.
- Fix: mirror FW3-3 in runComparison: after the sides are read and before
  any driver is created, a side whose commit is GIT_FAILED fails the run
  ("git could not read the commit of <root> - no certificate. Nothing was
  sent and no record written"), exit 1; the dry run unchanged. One test
  through the injected git runner (each side refusing in turn).
- Status: CONFIRMED (mechanism); the trigger is environmental: PLAUSIBLE.
- Class: REGRESSION (the same class R3 gave R3-2 and the orchestrator
  accepted; the comparison, its record and its git read are B1 code - main's
  probe had no `--baseline` and no git read).

## R4-2 - INFO - The F1 retry of a run with more than five passing lines appends the lines the cap kept out of run 1

- Where: app/src/services/extraction/apply.ts:345-361 (the guard drops lines
  in the loop; the cap is `[...model, ...system].slice(0, MAX_NOTE_LINES)`
  at :361, after it), :299-322 (rule 4, rewritten by FW3: the F1 retry "is
  the guard's one purpose"; its "Accepted costs" list); schema.ts:173 (the
  parser keeps up to 20 items). Spec D4 (design.md:253-256) moved the guard
  BEFORE the cap; main ran it after (`git show d0e2c2d8:app/src/services/
  extraction/apply.ts` :723 cap, :739 guard), so main's retry appended
  nothing.
- What happens: run 1's model returns seven lines that pass the floor; the
  cap writes five; complete() fails and the retry re-extracts the same
  transcript. The guard drops the five written lines, which no longer take
  cap slots, so lines six and seven are appended - the retry is not
  idempotent, and that transcript gets seven lines past a five-line cap.
  No duplicate and no lost meaning (the extra lines are facts the model
  found); the cost belongs in the list FW3 wrote, which omits it. Reach: a
  manual press over imported history (up to 200 messages) is the likeliest
  long output; a complete() failure is rare.
- Proof: throwaway `_r4_guard.test.ts`: seven passing lines -> run 1 appends
  five; notes as apply writes them (`${PREFIX} <line>`); the retry with the
  same seven -> expected [], RECEIVED ['fact six', 'fact seven'] - FAIL.
- Fix: record it in rule 4's accepted costs (a retry of a run that hit the
  cap appends the rest, at most another five); no code change - keeping the
  WI5 order is what lets new lines past duplicates, and a retry cannot be
  told from a new run inside filterNoteLines.
- Status: CONFIRMED.
- Class: NOT A REGRESSION (the code conforms to spec D4's explicit order;
  the gap is in the spec's trade-off, never named).

## 2. The FW3 diff reviewed cold

## R4-3 - INFO - "Same day" is the same month and day of ANY year: the prefix has no year, so a flip back on an anniversary is dropped silently

- Where: app/src/services/extraction/apply.ts:212-216 (autoPrefix:
  `[Auto - <Mon> <D>]`, no year), :338 (modelPresent compares
  `${input.prefix} ${line}` with the stored lines), :306-309 and
  R3-adjudications.md:23-26 ("The prefix carries the run's date, so this is
  exactly the F1 retry (same day)").
- What happens: the ruling's premise is inexact - the prefix carries a month
  and a day, not a date. A model line whose words equal a line written on
  the same month-day of an earlier year is treated as the same-day retry and
  dropped. A tenant who said "412 Oak Ave, Decatur: on the fence" on
  2026-10-20, "now likes it" on 2026-11-03, and is back on the fence on
  2027-10-20 loses that change of mind (spec D5.2, design.md:379-380), the
  R2-1 loss again, uncounted. Rare (an exact anniversary and identical
  words), but neither FW3's tests nor the accepted-cost list name it.
- Proof: throwaway `_r4_guard.test.ts`: existing "[Auto - Oct 20] 412 Oak
  Ave, Decatur: on the fence" and "[Auto - Nov 3] 412 Oak Ave, Decatur: now
  likes it", prefix "[Auto - Oct 20]" (autoPrefix of 2027-10-20), candidate
  "412 Oak Ave, Decatur: on the fence" (0.95) -> expected that line
  appended, RECEIVED [] - FAIL.
- Fix: no code change (spec D4 keeps the prefix as is): add it to rule 4's
  accepted costs and to the For-Cameron note ("same day" means the same
  month and day in any year).
- Status: CONFIRMED (mechanism); reach very rare.
- Class: REGRESSION (introduced by FW3: FW2 and main dropped any date, so
  the question did not arise), doc-only fix.

Swept with no finding: the model path vs the system path (one prefix-stripping
normalizer serves both sides of the system comparison; the model path keeps
the stored prefix, as ruled); a candidate holding a line break, CRLF (every
physical line trimmed on both sides, so "\r" never survives), a copied prefix
on a continuation line (R3-5, filed); every leading prefix stripped before
the 200-character cut and the postal filter; an invalid clock ("[Auto - Jan
NaN]" on both runs, still equal); `prefix` is now load-bearing and both
callers pass what they write with (apply.ts:958 and :971 share `prefix`; the
probe's PROBE_NOTE_PREFIX, with no case carrying profile notes); no other
caller of filterNoteLines or applyExtraction; no stale description of the
guard in RUNBOOK, docs/issues, e2e support or code comments;
lib/caseworkers.ts hasAiCaseworkerNote (a copied prefix is now stripped, so an
identity line is single-prefixed and still read; a model identity line equal
to a bare staff line is now written and fires the ai_note signal - the AI did
identify the contact); the e2e note assertions (single runs, `toContain` /
one pre-wrap element); FW3-3's placement (after the dry run, before the
driver, grader and first call; an unreadable AFTER read still fails as a
change); the new tests discriminate by reading (each R3-3, cross-date and
copied-prefix test fails under FW2's any-date guard; the later-date system
PIN fails if system lines were compared same-day), matching FW3's
reverted-fix runs.

## 3. Adjudication challenges

- The retry guard, decided (R3-adjudications.md:18-21): the weighing calls a
  cross-date verbatim repeat "noise, no wrong meaning; a repeated 'on the
  fence' is a true reaffirmation". Not when it is a stale re-read, which this
  pipeline makes likely: every run re-sends the already-extracted window
  ("The window is re-sent on EVERY run", jobs/extraction.ts:80-85; up to 50
  messages / 30 days), a manual press re-reads up to 200 messages with no age
  floor (:66-76), and the transcript does not mark which lines were already
  extracted (prompt.ts:36-37). After an intermediate change of mind, a
  verbatim re-read of the older view becomes the NEWEST line for the home:
  existing "[Auto - Oct 20] 412 Oak Ave, Decatur: on the fence", "[Auto -
  Oct 22] 412 Oak Ave, Decatur: now likes it"; an Oct 27 run that re-emits
  the Oct 20 words writes "[Auto - Oct 27] 412 Oak Ave, Decatur: on the
  fence" (throwaway demonstration, passes by ruling; FW2 dropped it). That is
  a wrong meaning, R2-1's mirror image, and the line B2's ranker would read
  as the latest view. Spec D5.2 (design.md:379-380): "feedback already
  recorded is not repeated; a CHANGE of mind is a new line"; D4
  (design.md:266): "Kept as is: ... the verbatim retry guard". I do not ask
  for FW2's guard back - text alone cannot tell a flip back from a stale
  re-read - but: (1) the For-Cameron note should state this cost as "a
  re-read older view can become the newest line", not as noise; (2) neither
  failure mode's frequency is known, because no run counts a guard drop (R2's
  suggestion, FW2 divergence 5) - a count on the run record would let the
  choice be revisited from production before B2 reads "the latest line"; (3)
  R3-3's other option (compare a label-naming line with the LATEST line for
  its label) would still drop the commonest slip, a re-read of the CURRENT
  view, which FW3 now writes on every later day it happens - though it needs
  the labels inside filterNoteLines (D5.3 "No new filter"; D5.4 leaves
  attaching to B2), which is presumably why it was not taken.
- FW3-3's scope (R3-adjudications.md:44): see R4-1 - the ruling's principle
  covers both gate commands; the binding row named only the never-written
  run.
- FW3's open items (FW3-report.md:245-246): no challenge. Divergence 1 (a
  model line equal to a bare staff line is written) follows from the ruling's
  "as this run would write it"; failing FW3-3 before any call is the better
  reading (nothing an uncertifiable run measures can be signed off).

## 4. FW3 items verified

- FW3-1: REAL, and it implements the ruling as written: a model line is
  dropped only when `${prefix} ${line}` equals a run of whole stored lines
  (apply.ts:337-338), a system line when its prefix-stripped text equals a
  prefix-stripped line of any date (:340-341), every copied leading prefix is
  removed in the clamp before the comparison, the postal filter and the write
  (:349; never a double prefix on the first physical line), the multi-line
  run matching is kept (:333-334); the accepted costs are recorded in rule 4
  (:318-322); every test the binding row lists exists, and FW2's pin was
  updated with the stated reason. Not in the accepted-cost list: R4-3 (any
  year) and the pre-existing R4-2 (cap overflow on a retry).
- FW3-2: REAL. The bullet names the property in both examples, says the label
  is the one wording a noteLine may repeat, and drops FW2-1's "never written
  again" sentence (prompt.ts:181-185); each pinned phrase sits on one line
  (extractionSchema.test.ts:867-878); ASCII; the reconcile bullet (D4,
  verbatim) is unchanged. Residual, recorded by FW3: no gate case carries
  profile notes, so the gate never sees a change of mind.
- FW3-3: REAL for `--suite never-written` (fails before any call, no record;
  the two RED tests fail with the check removed, by reading and per FW3's
  reverted run). NOT applied to the `--baseline` comparison - R4-1.
