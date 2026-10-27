# Code review R3 - fresh re-review after fix wave FW2 - feat/wp1-b1-ranking-inputs @ 28450c2d

Reviewer: R3 (fresh), Claude Opus 5.5, 2026-10-27. Merge base main @ d0e2c2d8.
Inputs: BRIEF-r3.md, R2-review.md, R2-adjudications.md, FW2-report.md, the
FW2 diff package (512cf98d..28450c2d), R1/FW1 records for context, the spec
(adjudication checks), the live tree, AGENTS.md.

Method: the FW2 diff read cold; then every reader and writer of the Notes box
(apply.ts filterNoteLines and the notes block, jobs/extraction.ts toProfile
and the D5.3 counts, prompt.ts as a whole, lib/caseworkers.ts, the dashboard
NotesText card and AiRunDetail NotesLines, the probe's writtenLines and its
cases) and the probe's git checks on both suites. Throwaway tests (all
DELETED before handback): `app/test/_r3_noteguard.test.ts` (4 cases, all FAIL
on the head - the proofs below) and `app/test/_r3_realgit.test.ts` (the
probe's exported gitInfoOf / measuredCodeChanged driven with REAL git on
win32 through a runner byte-identical to the unexported runGit; read-only git
commands only). Run as
`env -u ANTHROPIC_API_KEY -u AI_EXTRACTION_MODEL npx vitest run test/<file>`.
No in-place revert, no API call, no key read, no probe run, no e2e, no full
suite. `git -C W:/tmp/wp1-b1-ranking-inputs status` is clean apart from this
file (untracked; read-only git, so the orchestrator commits it).

Counts: CRITICAL 0, HIGH 0, MEDIUM 1, LOW 3, INFO 1.
By class: REGRESSION 4 (R3-1, R3-2, R3-3, R3-4), NOT A REGRESSION 1 (R3-5).

## 1. What earlier rounds missed in the state FW2 touches

## R3-1 - MEDIUM - The change-of-mind examples name no home, beside a kept rule that forbids repeating wording already in the notes; a change of mind written that way attaches to no property and no count sees it

- Where: app/src/services/extraction/prompt.ts:181-184 (FW2-1: "a CHANGE of
  mind is / a new noteLine that SAYS the view changed, e.g. "now likes it" or
  / "back on the fence""); against :157-164 (the reconcile rule spec D4 keeps
  verbatim: "when the notes already cover a fact and you now know something
  MORE about it (..., a change of mind), append ONLY what is new and NEVER
  repeat wording already in the notes", worked example "Confirmed interest
  again on 8/17 call" - a follow-up that does not name its subject) and
  :167-175 (the feedback rule: NAME the property by copying its label).
  Spec D5.2 (design.md:364-371) requires every feedback line to name its
  home; D5.3 (design.md:404-414) counts by label.
- What happens: for a home the notes already discuss, the label IS "wording
  already in the notes". Both rules that name a change of mind now model it
  WITHOUT the label - the kept reconcile rule (repeat nothing; its worked
  follow-ups carry no subject) and FW2-1's new examples, written bare - while
  only the general feedback rule says to copy the label. A model that follows them writes "now likes it" or
  "back on the fence". That line passes every filter (apply.ts:326), lands in
  the Notes box, and is invisible: countFeedbackLines
  (sentPropertiesBlock.ts:155-166) counts it neither as feedback nor as an
  unlabeled address, and B2's attach (labelMatches) cannot put it under the
  home; per D5.3 a home-less line reads as feedback on every property. The
  latest view of the home is thus missing from the home and smeared over all
  of them - the outcome FW2-1 was meant to protect. The never-written gate
  cannot see this: no never-written or default case carries profile notes
  (extractionProbeNeverWritten.ts profiles :371, :405 set only matching
  fields), so no gate run ever exercises a change of mind.
- Proof: throwaway `_r3_noteguard.test.ts`: the prompt contains the bare
  example (`toContain('a new noteLine that SAYS the view changed, e.g. "now
  likes it" or')` passes), and
  `countFeedbackLines(['now likes it'], ['412 Oak Ave, Decatur'])` -> expected
  `{ feedbackLines: 1, ... }`, RECEIVED `{ feedbackLines: 0,
  unlabeledAddressLines: 0 }` - FAIL. The text conflict is quoted above. Whether
  the model actually drops the label is UNVERIFIED (no API call by mandate).
- Fix: write the examples WITH a label, e.g. `"123 Main St, Decatur: now likes
  it"` / `"123 Main St, Decatur: back on the fence"`, and say in the feedback
  bullet that a change of mind still names the property by its label - the one
  repetition the reconcile rule allows (rule :157-164 stays verbatim per D4).
  Pin the labeled wording in extractionSchema.test.ts. This must land BEFORE
  Cameron's paid gate run: any prompt edit changes the extraction prompt
  fingerprint (FW2 report: no record exists yet). Consider one never-written
  feedback control whose profile notes already carry a line on the same home,
  so the gate sees a change of mind at all.
- Status: PLAUSIBLE (text conflict and count blindness CONFIRMED; model
  behavior unverified).
- Class: REGRESSION (FW2-1's example text; it works against B1's own D5.2
  naming rule).

## R3-2 - LOW - A never-written run whose git reads fail at both ends passes, certifying "unknown (git failed)"

- Where: app/scripts/extraction-prompt-probe.ts:1219-1228 (gitInfoOf returns
  `{ commit: 'unknown (git failed)', dirty: false }` on any failure),
  :1237-1239 (measuredCodeChanged: equal commit strings -> no change),
  :1764-1773 (runNeverWritten passes on `changed === false`). Spec D7
  (design.md:559-562): "The record carries the commit ... A change to any of
  these after a passing run requires a new run."
- What happens: when git cannot answer at both reads (git not on the shell's
  PATH, or a repository git refuses - e.g. its dubious-ownership check on a
  mapped or network drive, which is how W: is mounted), both reads return the
  same sentinel, the check sees "no change", and the gate run PASSES with
  "- Commit: unknown (git failed)". The record then certifies no commit, so
  the D7 rule "a change after a passing run requires a new run" cannot be
  applied to it. FW2-3's own doc states the principle the other way round -
  "no answer is no certificate" (:1234) - but applies it only to the diff.
  Cameron's sign-off would have to notice the sentinel.
- Proof: throwaway `_r3_realgit.test.ts`: a GitRunner answering 128 to every
  command -> gitInfoOf twice = `{ commit: 'unknown (git failed)', dirty: false
  }`, and `measuredCodeChanged(dead, root, before, after)` -> expected true
  (no certificate), RECEIVED false - FAIL. The pre-FW2 checkoutChanged compared
  the same strings, so the gap predates FW2-3.
- Fix: a never-written run whose BEFORE read is unknown fails ("git could not
  read the commit - no certificate"), and an unknown AFTER read counts as a
  change (it already does, via the diff's 128). One test through the injected
  git dep.
- Status: CONFIRMED (mechanism); the trigger is environmental: PLAUSIBLE.
- Class: REGRESSION (B1's probe not meeting its own D7 record rule in a failure
  mode; the record and checks are B1 code).

## 2. The FW2 diff reviewed cold

## R3-3 - LOW - The whole-line guard still drops a change of mind on the second oscillation, worded exactly as the prompt now asks

- Where: app/src/services/extraction/apply.ts:306-313 (whole-line equality
  against EVERY existing line, any date), with prompt.ts:181-184 (the two
  example phrases). R2-adjudications.md:16 and :41-48 ("One case stays: a
  flip back to EXACTLY an earlier line's words is still dropped").
- What happens: FW2-1 asks the model to word a change of mind AS a change and
  hands it one phrase per direction. A tenant who wavers more than once
  produces exactly those phrases again: Oct 20 "<home>: on the fence", Oct 22
  "<home>: now likes it", Oct 27 "<home>: back on the fence", Nov 2 the tenant
  likes it again -> "<home>: now likes it" is identical to the Oct 22 line and
  is dropped; the box's latest view of that home stays "back on the fence"
  (and symmetrically for the fence side). Nothing counts a guard drop
  (FW2 divergence 5), so the loss is silent - the R2-1 defect, moved one
  oscillation later. The ruling's "one case" is therefore not an accident of
  wording but the expected outcome of the prompt's own wording; a model can
  avoid it only by scanning the whole unbounded box for an identical line and
  inventing a third phrasing.
- Proof: throwaway `_r3_noteguard.test.ts`, filterNoteLines with floor 0.7:
  (a) existing Oct 20 "on the fence", Oct 22 "now likes it", Oct 27 "back on
  the fence" (all "412 Oak Ave, Decatur: ..."), candidate "412 Oak Ave,
  Decatur: now likes it" (0.95) -> expected append [that line], RECEIVED [] -
  FAIL; (b) the mirror (likes it / back on the fence / now likes it, then
  "back on the fence") -> RECEIVED [] - FAIL.
- Fix: a design call for Cameron (see Adjudication challenges): either R2-1's
  original same-date guard (drop only a candidate equal to a line carrying
  THIS run's prefix - the F1 retry, which re-extracts minutes later; a
  retry across UTC midnight would append once more), or, for a line naming a
  sent property, compare only against the LATEST existing line that names the
  same label (identical to the current view = a repeat; identical to an older
  view = a change back). Either way rewrite the prompt's "a line identical to
  an earlier notes line is never written again" sentence to match.
- Status: CONFIRMED (mechanism); the model reusing the example phrase is
  PLAUSIBLE.
- Class: REGRESSION (B1's D5.2 "a CHANGE of mind is a new line"; FW2-1 does not
  cure R2-1, only defers it).

## R3-4 - LOW - The guard strips the [Auto - <date>] prefix from every existing line but not from the candidate

- Where: app/src/services/extraction/apply.ts:309-313 (existing lines:
  `line.trim().replace(LEADING_AUTO_PREFIX, '').trim()`; candidate parts:
  `part.trim()` only), :943 (write: `${prefix} ${line}`).
- What happens: the two sides are normalized differently. A model line that
  echoes an existing line WITH its prefix ("[Auto - Oct 19] works nights
  downtown" - the prompt tells the model those lines are its own, prompt.ts:139-140)
  no longer matches the stripped existing line, so it is appended as
  "[Auto - Oct 27] [Auto - Oct 19] works nights downtown" - a verbatim repeat
  under a double prefix. The substring guard FW2-1 replaced dropped it
  (`existing.includes(line)`). A retry stays idempotent (the doubled line
  strips back to the candidate), so this is a duplicate, not a loss.
- Proof: throwaway `_r3_noteguard.test.ts`: existing "[Auto - Oct 19] works
  nights downtown", candidate the same text -> expected append [], RECEIVED
  [that line] - FAIL.
- Fix: one normalizer for both sides (trim, strip a leading auto prefix, trim)
  applied to each candidate part as well; optionally strip a model-supplied
  prefix before writing so the box never carries a double prefix. Add the
  echo case to the FW2-1 describe.
- Status: CONFIRMED (mechanism); the echo is PLAUSIBLE model behavior.
- Class: REGRESSION (introduced by FW2-1).

## R3-5 - INFO - A model line holding a line break is written as one prefixed line plus unprefixed continuation lines

- Where: app/src/services/extraction/schema.ts:276-283 (the parser keeps text
  unmodified), apply.ts:321 (clamp trims the ends only), apply.ts:943 (the
  prefix goes on the first physical line only); FW2-1's PIN
  extractionNoteLines.test.ts ("a candidate holding a line break") writes
  `${PREFIX} toured on Monday\nliked the yard` and FW2 divergence 3 entrenches
  the shape (fenced runs) instead of normalizing it.
- What happens: the continuation line carries no `[Auto - <date>]` prefix, so
  every per-line reader takes it for staff text: lib/caseworkers.ts
  hasAiCaseworkerNote (:75-83) skips it, and B2's per-line attach would treat
  a continuation of a feedback line ("...: on the fence" / "worried about the
  commute") as a home-less staff line. Rare: the prompt asks for a phrase.
- Proof: code reading; FW2's own PIN shows the written form.
- Fix (B2 or a later slice): collapse CR/LF runs in a model line to " / "
  before the guard and the write, as prompt.ts toSingleLine does for
  transcript text; the fenced multi-line guard then reduces to plain line
  equality.
- Status: CONFIRMED.
- Class: NOT A REGRESSION (main wrote `${prefix} ${line}` the same way).

Swept with no finding: CRLF (both guard sides trim each physical line, so a
"\r" never survives); system lines (same guard, trimmed, unfloored); the cap
after the guard (unchanged); lib/caseworkers.ts AUTO_PREFIX agrees with
LEADING_AUTO_PREFIX on every autoPrefix output, including an invalid clock's
"[Auto - Jan NaN]"; the dashboard Notes card (NotesText, Card.tsx:455-482,
plain pre-wrap - nothing parses lines) and AiRunDetail NotesLines (counts
only); jobs/extraction.ts counts over `appendedLines` (unchanged; the snapshot
is read at :483 before the model call, so the guard and the model see the
same box); the probe's writtenLines (no case carries profile notes, so FW2-1
changes no probe verdict except through the prompt fingerprint); no consumer
of the removed `gitInfo` dep outside historical plan text; `git status` does
not fail on a concurrent commit's index.lock (it skips its opportunistic
index write); spawnSync's null status (a signal) reads -1, a git that cannot
start throws into the 'unknown' path.

## 3. Adjudication challenges

- FW2-1 ruling (R2-adjudications.md:16, "Retry idempotency (same or a later
  date) and verbatim-repeat dedupe are kept"; For Cameron :41-48). Spec D4
  (design.md:266) keeps "the verbatim retry guard", whose purpose (apply.ts
  rule 4, :284-287; adversarial F1) is the SAME transcript re-extracted after
  a complete() failure; D5.3 (design.md:398) says "No new filter"; D5.2
  (design.md:379-380) says "a CHANGE of mind is a new line". Dedupe across
  DATES is not something the spec asks for - it was a side effect of the
  substring test - and R3-3 shows the residual it keeps is the expected
  output of the prompt FW2-1 wrote, not one odd case. I would put R2-1's
  same-date guard (or the latest-line-per-label rule in R3-3) to Cameron as
  the default, with "a cross-midnight retry appends once more" as its stated
  cost, rather than "a flip back is dropped" as the accepted one.
- FW2-3 scope (R2-adjudications.md:18, "app/src and app/scripts ... Same scope
  for each --baseline side"). The probe certifies "the exact production
  request" (extraction-prompt-probe.ts:2-4) and spec D7 (design.md:559) "the
  commit"; the request is also built by the installed @anthropic-ai/sdk
  (app/package.json:16, root package-lock.json). MEASURED_PATHS
  (extraction-prompt-probe.ts:1216) leaves those manifests out, so since
  FW2-3 a dirty lockfile no longer marks the record "(tracked files
  modified)" (the whole-checkout status did). On the --baseline side the
  scope also counts app/scripts, which that side never runs (the branch's
  probe drives both sides; only BASE_PATHS modules load, :169-200), so an
  unrelated dirty script in main's shared checkout marks the Baseline line.
  Low stakes - the label is informational and modules load once, at the
  start - but the scope would read truer as app/src + app/scripts + the
  manifests on the measured side, app/src + the manifests on the baseline.

## 4. FW2 items verified

- FW2-1: REAL for R2-1's second half (a label that ends another label: the
  12 / 112 Oak St test appends) and for the contained-wording form; each new
  append test fails under the old `includes()` guard by inspection, matching
  the FW2 report's reverted-fix run. NOT FIXED for R2-1's first half - deferred
  by ruling to the prompt, whose remedy recurs (R3-3). New: R3-4 (prefix
  asymmetry) and R3-1 (bare examples).
- FW2-2: REAL. The comments and e2e/support/selectors.md:60 match the code:
  no `noValidate` on `<form id="contact-edit-form">`
  (ContactEditForm.tsx:699), Save is `type="submit" form="contact-edit-form"`
  (:693), so native validation runs first. Aside for e2e authors: Playwright's
  `fill()` refuses a non-numeric string on a number input, so driving `1e`
  takes `pressSequentially`, not `fill`. The stale FW-11 test comment remains
  as FW2 disclosed.
- FW2-3: REAL. The fakeGit tests discriminate (pathspecs pinned by exact
  argv), and real git on win32 through the exported functions agrees:
  gitInfoOf on the head -> its sha, clean; measuredCodeChanged 512cf98d ->
  e385c6b5 (app/src) true, e385c6b5 -> 8e19c05c (dashboard, e2e) false,
  8e19c05c -> 13674070 (app/scripts) true, f7d4a94f -> 28450c2d (records)
  false; an unknown revision -> true (exit 128); a missing root -> unknown,
  not dirty. Residual: R3-2 (both reads unknown passes).
