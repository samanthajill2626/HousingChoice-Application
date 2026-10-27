# FW3 report - WP1 B1 code review R3 fix wave (implementer, 2026-10-27)

Scope: the binding list FW3-1, FW3-2, FW3-3 in `R3-adjudications.md` (this
directory), including its section "The retry guard, decided"; source findings
R2-1, R3-1, R3-2, R3-3, R3-4 in `R2-review.md` / `R3-review.md`. Base
626e7f06. Nothing else changed. Status: DONE - all 3 items.

## Commits

| Commit | Items |
|---|---|
| c619eea1 | FW3-1 |
| 6dc880d9 | FW3-2 |
| 837cec28 | FW3-3 |
| (this report) | records |

## How RED and the reverted-fix proof were taken

- Every app vitest run was prefixed `env -u ANTHROPIC_API_KEY -u AI_EXTRACTION_MODEL`
  (G1). No probe run, no API call; ANTHROPIC_API_KEY was never read or printed.
- RED: the new or changed tests were written first and run against the
  unfixed code; the reason was read from each failing assertion. GREEN: the
  fix, tests unchanged.
- Reverted-fix proof: after GREEN, the fix lines were put back to their
  pre-fix form with the Edit tool, the same files re-run, then restored with
  the Edit tool (no revert marker left; grep checked) and re-run green.

## FW3-1 - the retry guard, as decided (R2-1, R3-3, R3-4, R3 challenge)

What changed (`app/src/services/extraction/apply.ts`, HEAD lines):
- `:218-224` LEADING_AUTO_PREFIX doc (what reads it now); the regex is
  unchanged.
- `:226-235` new `withoutAutoPrefix(line)`: trimmed, EVERY leading
  `[Auto - <date>]` removed (a loop over LEADING_AUTO_PREFIX).
- `:252-258` the `prefix` field doc: the guard reads it again (FW2
  divergence 4 is moot).
- `:285-289` rule 1 (clamp) and `:299-322` rule 4 rewritten to the ruling:
  model lines as this run writes them (same date), system lines against any
  date prefix-stripped, the accepted costs listed.
- `:331-341` the guard: `physical()` splits and trims; a MODEL line is
  present when `fenced(physical(`${prefix} ${line}`))` occurs in the fenced
  stored lines (prefix kept); a SYSTEM line when its parts, prefix-stripped,
  occur in the fenced prefix-stripped lines. Fenced runs keep the multi-line
  handling (a candidate spanning lines matches a run of whole lines).
- `:349` the model text goes through `withoutAutoPrefix` BEFORE the 200-char
  cut, the postal filter, the guard and the write (apply writes
  `${prefix} ${line}` at the unchanged write site): never a double prefix.
- `app/scripts/extraction-prompt-probe.ts:283-290` PROBE_NOTE_PREFIX doc
  (comment only): the guard compares under this prefix again.

Tests:
- `app/test/extractionNoteLines.test.ts:160-250` new FW3-1 describe (8
  tests): R3-3 case a and case b append (RED); a model line repeated
  verbatim from an EARLIER date appends, one holding a line break too - the
  documented cost (RED); PIN a same-day re-emission is dropped, both sides
  trimmed (the documented same-day flip-back cost); PIN a line-break
  candidate matches only a RUN of whole lines as written, not scattered
  lines; PIN a system line repeated on a later date is dropped; a model line
  that copied an old prefix (and a doubled one) is returned bare - written
  under ONE prefix - and a copied-prefix postal line is dropped (RED); a
  same-day echo with the prefix copied is dropped (RED).
- `app/test/extractionApply.test.ts:1793-1811` two tests through the write
  path: a flip back to an earlier date's exact words is written under this
  run's prefix (RED); a copied old prefix is written under ONE prefix and a
  same-day echo dropped (RED).
- The same-day retry (F1) keeps its existing pins, green throughout:
  `extractionNoteLines.test.ts:149-158` (line break and system line
  included), `extractionApply.test.ts:693-715` (apply twice). FW2's 12/112
  and contained-wording tests stay green, unchanged.

Existing pins changed, each with a one-line reason citing R3-adjudications
in the test:
- `extractionNoteLines.test.ts:78-86` (D4 C1): the MODEL half flips - a bare
  staff line "works nights downtown" no longer drops the model's identical
  line (expected `['works nights downtown', 'has a car']`, was
  `['has a car']`); the system half (C1's point) is unchanged. RED.
- `extractionNoteLines.test.ts:134-147`: FW2's PIN "still drops a line
  identical to an earlier one under any date prefix" becomes R2-1
  reproduction a verbatim APPENDING (the ruling names this update). Its
  bare-staff-line candidate moved out: that case is now the C1 test above,
  and "both sides trimmed" lives in the same-day re-emission PIN. RED.
- `extractionApply.test.ts:1867-1879` (D5.3 appendedLines) and
  `extractionJob.test.ts:2274-2289` (D5.3 counts): the existing line's date
  moved to the run's own date (Jul 15 -> Jul 16; Jul 16 -> Jul 17), so the
  test still exercises a guarded line. Green before and after.
- `extractionPromptProbe.test.ts:401-410` (the probe runs the production
  guard): the profile line is now `${PROBE_NOTE_PREFIX} Works nights
  downtown` instead of a bare staff line. Green before and after.

RED (4 files: extractionNoteLines, extractionApply, extractionJob,
extractionPromptProbe): 9 failed / 377 passed, exit 1. Received, per test:
cross-date and second-oscillation lines `[]` (dropped); the C1 model half
`['has a car']`; the copied-prefix test 3 items (all kept, prefixed, the
postal one included); the same-day echo kept; the two apply tests `[]` and
two prefixed lines. Every PIN passed on arrival. GREEN: 386 / 386, exit 0.

Reverted-fix proof: the FW2-1 guard (any-date, prefix-stripped existing
side) and the FW2-1 clamp (`text.trim()`) put back -> the same 9 failed
(9 / 377, exit 1). Discrimination check: the new guard kept and only the
prefix strip reverted -> exactly the 3 R3-4 tests failed (3 / 146 over
extractionNoteLines + extractionApply, exit 1). Restored -> green.

Divergences and consequences (name each):
1. A model line equal to a BARE staff line is now written. The ruling's
   "dropped ONLY when ... `${prefix} ${line}` ... equals" implies it but does
   not list it; under FW2-1 such a line was dropped. Pinned in the C1 test.
   If a bare staff line should still drop a model line, that is a new rule
   for the orchestrator (it would re-open R2-1-style drops for staff-typed
   feedback).
2. EVERY leading prefix is removed from a model line, not just one: "never
   a double prefix" taken literally (a doubled `[Auto - Oct 19] [Auto - Oct
   18]` is possible in boxes main wrote). The same normalizer serves both
   sides of the system-line comparison (R3-4's "one normalizer").
3. The strip sits in rule 1, before the 200-character cut and the postal
   filter: a copied prefix takes no characters from the line, and a
   copied-prefix "Current address ..." line is now caught by the postal
   filter (pinned). Under FW2-1 it would have been written, double-prefixed.
4. Equality is exact after trimming each physical line; the prefix's own
   spacing is not canonicalized. A staff edit that deletes the space after a
   same-day prefix makes a retry append once (a duplicate, not a loss).
5. RUNBOOK.md: grepped for the guard (retry guard, verbatim, duplicate,
   written again, whole line, same day) - no sentence describes it; nothing
   changed. Code comments describing the old guard were all in apply.ts and
   the probe's PROBE_NOTE_PREFIX doc (updated). Left as is, being history:
   `extractionSchema.test.ts:600-607` narrates main's "VERBATIM includes()
   guard" in the past tense (a production incident), and the FW2-1 comments
   at `extractionNoteLines.test.ts:67-68` / `extractionApply.test.ts:1771-1772`.

Risks:
- Identity lines the prompt hands the model word for word ("Identified as a
  caseworker at Hope Atlanta", "Identified as property manager for ...") are
  the likeliest cross-date verbatim repeats: when the evidence is still in a
  later day's window and the model ignores the reconcile rule, the line is
  written again (main and FW2 dropped it). Accepted cost per the ruling;
  `lib/caseworkers.ts` hasAiCaseworkerNote is a boolean read, so a duplicate
  changes no caseworker behavior - noise in the box only.
- A retry crossing UTC midnight appends its lines once more; a second run
  the same day that flips back to that day's words is dropped (both accepted
  in the ruling, both pinned or documented in rule 4).
- R3-5 (a model line holding a line break) is untouched: its continuation
  lines still carry no prefix (filed by the orchestrator for B2).

## FW3-2 (R3-1 MEDIUM) - the change of mind names its home

What changed:
- `app/src/services/extraction/prompt.ts:181-185` the bullet now reads: "a
  CHANGE of mind is / a new noteLine that still NAMES the property by
  copying its label, then / SAYS the view changed, e.g. "123 Main St,
  Decatur: now likes it" or / "123 Main St, Decatur: back on the fence". The
  label is the one wording / already in the notes that a noteLine may
  repeat." FW2-1's sentence ("a line identical to an earlier notes line is
  never written again, so a change back worded as before is lost") is gone.
  ASCII; "a CHANGE of mind is" (pinned at `extractionSchema.test.ts:863`)
  stays on its own unchanged line; every new pinned phrase sits inside one
  line. The reconcile bullet (spec D4, verbatim) is unchanged.
- `app/test/extractionSchema.test.ts:867-878` the FW2-1 wording test
  replaced by the FW3-2 pin (four labeled phrases present; "never written
  again" and "a change back worded as before is lost" absent), with the
  stated reason in its comment.

RED: 1 failed / 60 passed, exit 1 (the labeled phrase absent). GREEN: 61 /
61, exit 0. Reverted-fix proof: the FW2-1 bullet restored -> 1 failed / 60
passed, exit 1; restored -> green.

Divergences: the sentence wording is mine within the ruling's terms. Not
done (outside the binding list): R3-1's "consider one never-written
feedback control whose profile notes already carry a line on the same
home" - no gate case carries profile notes, so the gate still never sees a
change of mind.

Risk: the extraction prompt fingerprint changed again; any gate run must be
on 6dc880d9 or later (no gate record exists yet, per FW1/FW2).

## FW3-3 (R3-2 LOW) - no readable commit, no certificate

What changed (`app/scripts/extraction-prompt-probe.ts`):
- `:1219-1220` `GIT_FAILED = 'unknown (git failed)'`, used by `gitInfoOf`
  (`:1231`; same text as before).
- `:1757-1766` in the never-written run, after the dry-run branch and
  before the driver and grader are created: when the BEFORE read is
  `GIT_FAILED`, print "FAIL: git could not read the commit - no certificate.
  Nothing was sent and no record written;" and "re-run where git can read
  <root>.", and return 1.
- Unchanged and kept: an unknown AFTER read fails the run as a change
  (`measuredCodeChanged`: the diff git cannot answer, or a throw).

Tests (`app/test/extractionPromptProbe.test.ts:1286-1337`, through the
injected git runner): git refusing every command (exit 128) fails the run
with exit 1, no extraction or grader call, no record, the FAIL line printed
(RED); a git that cannot start (throws) fails the same way (RED); PIN an
AFTER read git cannot answer still fails as a change, the record certifying
the BEFORE commit and showing "Commit after the last call: unknown (git
failed)"; PIN a dry run with an unreadable git still exits 0.

RED: 2 failed / 129 passed, exit 1 (each run exited 0 - the R3-2 pass).
GREEN: 131 / 131, exit 0. Reverted-fix proof: the check's condition made
unreachable -> the same 2 failed (2 / 129, exit 1); restored -> green.

Divergence: the ruling says the run FAILS with that message; it does not
say when. I made it fail BEFORE any call rather than at the end with a FAIL
record (the changed-checkout path). Why: the BEFORE read is known before the
first call; a gate run is 33 extraction calls plus up to 33 grader calls
(11 cases x 3), all of which an uncertifiable run would waste; and R3's
trigger (git refusing a checkout on a network drive, as W: is) is plausible
on Cameron's machine. Cost: the failed attempt leaves no record entry -
nothing ran. If an end-of-run FAIL record is wanted instead, move the check
below the run and add its reason to the suite verdict. Not changed:
`measuredCodeChanged` in isolation still reads two unknown reads as "no
change"; its one caller can no longer reach it with an unknown BEFORE read.

## Commands (exit codes as shown)

| Command | Result |
|---|---|
| vitest `extractionNoteLines`, `extractionApply`, `extractionJob`, `extractionPromptProbe` - FW3-1 RED | exit 1, 9 failed / 377 passed |
| same - FW3-1 GREEN | exit 0, 386 / 386 |
| same - FW3-1 fix reverted | exit 1, 9 failed / 377 passed |
| vitest `extractionNoteLines`, `extractionApply` - prefix strip alone reverted | exit 1, 3 failed / 146 passed (the R3-4 tests) |
| vitest `contactStaffNotes`, `caseworkers`, `possibleCaseworkers` after FW3-1 | exit 0, 116 / 116 |
| vitest `extractionSchema` - FW3-2 RED / GREEN / reverted | exit 1 1/60; exit 0 61/61; exit 1 1/60 |
| vitest `extractionPromptProbe` - FW3-3 RED / GREEN / reverted | exit 1 2/129; exit 0 131/131; exit 1 2/129 |
| final, at 837cec28: 13 app files (`extractionNoteLines`, `extractionApply`, `extractionSchema`, `extractionJob`, `extractionPromptProbe`, `extractionAdapter`, `extractionDecisions`, `caseworkers`, `extractionJobDraftGuard`, `contactExtractionRun`, `extractionProbeNeverWritten`, `contactStaffNotes`, `possibleCaseworkers`) | exit 0, 652 / 652 |
| `npm run typecheck` (bare, root) before the FW3-1 commit and before the FW3-3 commit | exit 0 each, 0 TS errors |
| `npx eslint` per item, then over every touched .ts (`git diff --name-only --diff-filter=d 626e7f06 HEAD -- '*.ts' '*.tsx'`, 8 files) | exit 0 |
| ASCII: `git diff -U0 626e7f06 HEAD \| grep '^+' \| tr -d '\11\12\15\40-\176' \| wc -c` (and per item) | 0 |
| `\u` escapes in the touched files (`grep -cF '\u'`) | 0, as at base |

Not run (per the dispatch): root `npm test`, `npm run e2e`, the probe.

## For Cameron (carried from R3-adjudications, now built)

Spec D4 keeps "the verbatim retry guard" as is; it is now a same-day retry
guard for model lines (and a dedupe of apply's own system lines across
dates), because the date-agnostic form silently dropped a tenant's change
of mind back to earlier words (R2-1, R3-3), which D5.2 requires to be
written. Costs: a retry across UTC midnight appends once more; a model line
repeated verbatim on a later date is written again (most likely an identity
line such as "Identified as a caseworker at ..."); a second same-day run
that flips back to that day's words is dropped; and (implied, not listed in
the ruling) a model line identical to a bare staff line is written beside
it.

## Next step (orchestrator)

A fresh reviewer on 626e7f06..HEAD. Open for a ruling only if wanted:
divergence 1 of FW3-1 (bare staff lines) and FW3-3's fail-before-any-call.
