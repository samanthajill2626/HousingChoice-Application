# Planner handback review - adjudications (WP1 B1)

Branch tip reviewed: c70a56c4 (gates and code at 89016353; the two later
commits are records). Reviewers (opus, read-only, no test runs):
- conformance.md - spec-conformance, spec + charter section 20 + work map.
- adversarial.md - plan-blind: diff + repo + AGENTS.md, no spec/plan/records.

Rule: a finding that contradicts a decision Cameron made in the conversation
(intent.md) is REJECTED as by design and named; a deviation from the spec
that only Cameron can settle goes to him as a RULING; a confirmed defect in
B1 code that is cheap and in scope would go to a fix wave (none found).

## Conformance (90 of 95 conform; 1 blocking, 1 high, 1 medium, 5 low)

| id | sev | ruling |
|---|---|---|
| PC-3 | blocking | EXPECTED. The never-written gate run is Cameron's (Q2, 2026-10-26), on claude-sonnet-5-5, after any prompt change. Merge waits on it. |
| PC-1 | high | RULING FOR CAMERON. The Notes retry guard now drops a model line only as a same-day repeat (system lines any date); spec D4 / charter 6.4 kept today's any-date substring guard. The build changed it because the old guard silently drops a change of mind back to earlier words, which spec D5.2 requires to be written. Planner recommends KEEP and record it (spec rev 11, charter 20 item 12); the model sees the notes and is told not to repeat them, so the guard is a backstop. Revert is the alternative (code + FW3-2 prompt wording). |
| PC-2 | medium | REJECT. The grader's NOT EXCLUDED defaults (pronoun, household by relationship, mobility aid) are Cameron's confirmed calls (2026-10-27: "The grader defaults that you use look good to me"; plan PR54 resolved). Each line still prints under its case for his sign-off. |
| PC-4 | low | RECORD. A truncated grader call leaves the run ungraded (listed under "Lines the grader did not judge"), not counted as a truncation. Visible at sign-off. |
| PC-5 | low | ACCEPT AS BUILT. --baseline is stricter than the spec (2-of-3 measured, branch truncation fails); flag renamed; RUNBOOK documents it. |
| PC-6 | low | ACCEPT AS BUILT. .env.example uncomments four existing extraction vars at their code defaults (the env-defaults-explicit rule); no behavior change. |
| PC-7 | low | ACCEPT AS BUILT (build ruling FW-9): the assistance-animal control's therapist mention is told to the grader; still scored as a control. |
| PC-8 | low | ACCEPT AS BUILT; goes with PC-1. |

## Adversarial (0 blocking, 1 high, 2 medium, 9 low; 2 low pre-existing)

| id | sev | ruling |
|---|---|---|
| PA-1 | high | REJECT AS BY DESIGN, RE-SURFACED. The never-written list does not cover the four fields: Cameron, 2026-10-26, "No, I don't think that the never-written list should cover new free-text fields too", after the planner named the church example. The reviewer's concrete case (the gate's own "near my mosque" message landing in area preference as a live write, gate still PASS) is shown to Cameron once; the gate record lists every proposed field value and flags excluded content there, so he sees it at sign-off. |
| PA-2 | medium | DEFER TO B2. The PROPERTIES SENT block carries no staff decline; B2's properties seen shows the staff outcome next to the feedback lines, so the ranker reads both. Named for B2's spec. |
| PA-3 | medium | ACCEPT AS COVERED. gate-run-commands.md:39 keeps the floor unset or 0.7 and the record prints the floor used. Lowering the production floor later means re-running the gate; noted for the RUNBOOK owner, no code. |
| PA-4 | low | REJECT AS BY DESIGN. The no-address bullet was removed on Cameron's call (charter 20 item 9); postal filter kept. |
| PA-5 | low | RECORD. Pre-existing run-log retention of raw model output (admin-only, 90-day TTL). |
| PA-6 | low | RECORD. The commit certificate accepts a dirty tracked tree; the gate sheet runs it on the committed branch. |
| PA-7 | low | ACCEPT. One re-run on --baseline is spec D7. |
| PA-8 | low | ACCEPT. Same-model grader by design; Cameron's sign-off overrules. |
| PA-9 | low | RECORD. Test seam falls back to real deps when one is omitted; no current test reaches the network (both reviewers confirm). |
| PA-10 | low | RECORD. Two hand-written copies of the never-written list (prompt, grader); both carry PR58 text; a drift test is a cheap follow-up. |
| PA-11 | low | ACCEPT. Production held 0 priority strings (charter); legacy strings read as off. |
| PA-12 | low | ACCEPT AS SPEC. Dollars keep the pets rule (spec D3). |
| PA-13 | low | RECORD. Unused `unlabeled` count in the block renderer. |
| PA-P1, PA-P2 | low | PRE-EXISTING; not B1. |

Decision changes: none made by the planner. Two items go to Cameron: PC-1
(keep or revert the retry guard) and PA-1 (re-confirm with the example).

## Cameron's rulings (2026-10-27, after the verdict)

- PC-1: REVERSED the planner's recommendation. Cameron: "For the notes retry
  guard, we are feeding old messages into the agent so what happens if the
  extraction agent pulls out the old information since the retry guard is
  gone?" The planner confirmed the window re-sends up to 30 days of
  already-extracted messages (jobs/extraction.ts:80-90), so the same-day guard
  let a re-extracted old fact through on every later run. Cameron: "Yes -
  restore the any-date retry guard over whole lines, keep the prefix stripping
  and whole-line matching, re-run the gates." Applied by the planner directly
  (planner fix PF-1): filterNoteLines drops a model or system line equal to a
  run of whole lines under any date, prefixes removed on both sides; the
  `prefix` input and the probe's PROBE_NOTE_PREFIX are gone; the prompt again
  says an identical line is never written and asks for a change back worded
  differently ("likes it again"); tests re-pinned; spec rev 11 (D4); issue
  notes-guard-stale-reread-vs-flip-back updated. The prompt fingerprint
  changes, so the never-written gate run must be on this commit or later.
- PA-1: Cameron: "Fields can stay outside the never written list." No change.

## Re-review of PF-1 (68168b4c) - adversarial reviewer continued

0 blocking, 0 high, 0 medium, 2 low.

| id | sev | ruling |
|---|---|---|
| PA-R-1 | low | RECORD. A line-broken model line with a copied prefix on an INNER line can write an Auto line with an old date. Closed by the fix already filed in extraction-note-line-break-unprefixed-continuation (collapse line breaks before the guard and the write). |
| PA-R-2 | low | TO CAMERON as an option, not applied (beyond his named fix). The guard matches identical text only; a re-emitted old fact differing by a trailing period, case or a doubled space is written again. Option: compare a folded form (lowercase, collapsed spaces, trailing punctuation dropped) on both sides, writing the original. |

Gates re-run by the planner at a0371f40 (PF-1 + records), quiet tree,
2026-10-28 00:07-00:28 UTC: typecheck 0; npm test 0 (app 545 / 11770 passed,
1 skipped; dashboard 272 / 5633; 22/509, 34/275, 13/111; 0 [dynamoAdmin]);
smoke 0; e2e 0 (383 passed, 17.6m); eslint on 87 files 0, no output.
