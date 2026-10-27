# WP1 B1 Ranking inputs - build orchestrator handback (2026-10-27)

**MERGE-READY PENDING the never-written gate run** (Cameron, the TESTING key,
claude-sonnet-5-5; commands in `gate-run-commands.md`) on
`feat/wp1-b1-ranking-inputs` (W:\tmp\wp1-b1-ranking-inputs). All five repo
gates green at **89016353**; every later commit is records only (the S7
report, the gate sheet, this handback). 0 commits behind main (main is still
d0e2c2d8; the one sync was "Already up to date"). **UNMERGED (human gate).**
No infra and nothing broken until a deploy; post-merge: deploy dev + prod
(Cameron's ask).

## Work map

| Item | Result | Commits | Notes |
|---|---|---|---|
| Phase 1 research | done | 99ef3176, 0815616e | 10 parallel delta readers; 50 raised: 2 BLOCKERs (dashboard requirements.test.ts pins PROPERTY_FORM_FIELDS twice; an S4.2 test passed `undefined` to a defaulted parameter), 24 MINOR, 23 NOTE -> binding `build-research/WORKLIST.md` WL-1..WL-42 |
| S1 tenant matching inputs | shipped | 8e476f42..7f692aa8 | list module + mirror + drift test, PATCH/create parsers, edit form, intake rows/chips, full-world tenant; + WL-1 `.vProse` (free-text rows keep line breaks and wrap) |
| S2 Priority | shipped | 17901c04..8cd6feb5 | boolean validator, 36-row tables (3 of them, WL-4), New/Edit checkbox, row + pill (WL-5: AA-contrast amber) |
| S3 extraction reconciles the four | shipped | 9bcbdee2..8b89e49b | 16 targets / 11 tenant-only, `text_field_filled`, coercion by kind (one rule, accept delegates), CURRENT PROFILE, prompt guidance, run-detail order + label, every count |
| S4 Notes lines | shipped | 0a6434a4..6d56b5d4 | `{ text, confidence }`, EXTRACTION_FACT_MIN_CONFIDENCE (0.7, fail-fast), `filterNoteLines`, demoted runs append nothing, run-record counts, widened prompt + never-written list (named, WL-14) |
| S5 feedback lines | shipped | be9b7982..be5177a1 | propertyLabel / labelMatches leaf, `getDisplaysByIds({ requireComplete })`, PROPERTIES SENT block + fingerprint, required job deps, run-failing reads, no-address bullet deleted (PR50), feedback counts + run detail |
| S6 the probe | shipped | edd8e56a..cf43789e | never-written data + model grader (structured-output client in the adapter), exported `main` + guard, `--suite never-written`, `--baseline`, fake driver note, RUNBOOK, env templates, GLOSSARY |
| S7 e2e + gates + self-QA + sheet | shipped | 7b3fdcaa..67d877cc, fdae5623, 89016353, a12a39c2 | 3 new/extended e2e specs; gates below; self-QA found and fixed SQA-1; `gate-run-commands.md` |
| Review R1-R4 + FW1-FW4 | done | 789a84ef..fa9552d4 | below |
| Never-written gate run | PENDING (Cameron) | - | PR1: no agent ran the probe or grader against a real model or read the key |

Deviations from the plan text are all recorded with reasons in the slice
reports (`slices/S1..S7`) and fix-wave reports (`code-review/FW1..FW4`).
None changes spec behavior except the three rulings for Cameron below.

## Gates on the final code commit 89016353 (bare, from the worktree)

Battery 2026-10-27T22:51:51Z - 23:11:24Z, logs `.superpowers/sdd/gates-p6/`:

- `npm run typecheck` - **EXIT=0**
- `npm test` (as `env -u ANTHROPIC_API_KEY -u AI_EXTRACTION_MODEL timeout 1500 npm test`) - **EXIT=0**:
  app 545 files / 11772 passed + 1 skipped; dashboard 272 / 5633; e2e
  workspace 22 / 509; 34 / 275; 13 / 111; 0 `[dynamoAdmin]` lines.
- `npm run smoke` - **EXIT=0**: "smoke-dist: OK - 1760 import specifier(s) across 306 emitted file(s) resolve under plain Node."
- `npm run e2e` (under `timeout 2700`) - **EXIT=0**: "383 passed (16.5m)".
- Gate 5 `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')` -
  87 files, **EXIT=0**, no output (no error in any touched file; no
  pre-existing error to name).

Earlier battery at 67d877cc (pre-review): all five EXIT=0 (e2e 383 passed,
16.3m). No gate was ever red; nothing flaked; no re-run.

## Size

106 files changed outside docs/superpowers (code, tests, RUNBOOK, GLOSSARY,
env templates, docs/issues), +10212 / -367 vs the merge base. 87 build
commits (99ef3176..a12a39c2 plus this handback) on top of the planner's
design commits.

## Review, fix waves, adjudications

- R1 (67d877cc): conformance 145 rows - 142 CONFORMS, 1 PARTIAL, 2 MISSING
  (pending by design); plan-blind adversarial 1 HIGH, 3 MEDIUM, 8 LOW, 3
  INFO. The HIGH: `--baseline` passed with nothing measured (every call
  failing on both sides). FW1 (16 items, 9db3360a..0f271f74): baseline
  measurement bar, entry-by-entry grader parsing, PARTIAL sections, canonical
  same-checkout guard, git read before/after, endpoint print, ungraded
  statement, portion badInput guard, no maxLength, docs.
- R2 (0f271f74): 1 MEDIUM, 2 LOW, all REGRESSION - the Notes retry guard's
  substring test silently dropped feedback D5.2 requires; FW-11 rested on a
  jsdom-only premise (browsers block the path natively); the probe's git
  checks counted the gate record. FW2 (e385c6b5..28450c2d).
- R3 (28450c2d): 1 MEDIUM, 3 LOW REGRESSION + 1 filed - bare change-of-mind
  examples could lose the label; the whole-line guard still dropped a second
  oscillation; a prefix asymmetry; git-failed runs certified nothing. FW3
  (c619eea1..aca3ccda).
- R4 (aca3ccda): 1 LOW REGRESSION (`--baseline` certified an unknown commit)
  + 2 INFO docs. FW4 (f04f1bb8..b4226d38), a 12-line mirror of R4-verified
  code, verified by the orchestrator; the loop closed with no open
  REGRESSION (`code-review/R4-adjudications.md`).
- Records: `code-review/R1-conformance.md`, `R1-adversarial.md`,
  `R1..R4-adjudications.md`, `R2..R4-review.md`, `FW1..FW4-report.md`.

## For Cameron (decisions taken by the build; overrule any)

1. **The Notes retry guard** (spec D4 kept it "as is"): it is now a SAME-DAY
   guard for model lines and an any-date dedupe for apply's own system
   lines, because the old substring guard silently dropped a tenant's
   change of mind back to earlier words (D5.2). Costs, plainly: a model that
   re-emits an OLDER view of a home word for word on a later day writes that
   stale view as the newest line; a fact repeated word for word on a later
   day is written again; a retry across UTC midnight or of a capped run
   appends once more; "same day" is month and day of any year. Filed for B2
   to measure: `docs/issues/notes-guard-stale-reread-vs-flip-back.md`.
2. **FW-9** (spec D7 "control cases plant none"): the assistance-animal
   control tells the grader the excluded fact its message carries (the
   therapist); it stays scored as a control. Rule on it at the gate sign-off.
3. **The change-of-mind prompt wording** (FW3-2): a change of mind still
   names the property by its label ("123 Main St, Decatur: now likes it");
   the gate has no case that exercises it (no case carries earlier Notes
   lines) - add one if you want it measured.
4. Recorded BY DESIGN, raised independently by the plan-blind reviewer:
   ADV-4 the removed no-address bullet means a client's own address in
   shapes other than "Current address ..." can reach the Notes box (offer: a
   gate control for it); ADV-5 confidence is clamped, so an out-of-range 40
   clears the floor; ADV-6 a model `write` with a different number over a
   filled portion lands (pets rule); ADV-13 the four fields sit outside the
   never-written list (a field leak is reported, never failing); ADV-14 a
   typo in EXTRACTION_FACT_MIN_CONFIDENCE stops startup even with
   extraction off (fail-fast as specified).
5. UI behavior: a pasted text over 500 characters now gets the server's
   message instead of a silent cut (FW-12); an UNPARSEABLE portion entry
   gets the browser's own "Please enter a number." (native validation runs
   first), the server's copy shows for parseable bad values (12.5, 20001).

## Live self-QA (`self-qa.md`)

Hermetic lane, project Playwright MCP (Chromium 155), measured at 360-1440
px: the four fields (trim, `$1,200 / month`, wrapping long unbroken values,
clear -> REMOVE, the bad-value messages), Priority (row, AA pill, flyer JSON
and page carry nothing, New/Edit forms), two extraction runs (fills, a
chip, the floor, a feedback line, `text_field_filled` on a filled field, the
run-detail counts) and a chip accept. One B1 defect found and fixed:
SQA-1, the run detail's 64-character fingerprint spilled past its region in
the narrow detail column (fdae5623; CSS source pin + e2e geometry assertion,
both RED first; re-measured 0 at every width). Screenshots:
W:\tmp\wp1-b1-ranking-inputs\.playwright-mcp\b1-qa-*.png (gitignored).

## Issues

Filed: `extraction-text-field-write-races-staff-fill`,
`contact-edit-form-notes-save-drops-auto-lines`,
`extraction-note-line-break-unprefixed-continuation`,
`notes-guard-stale-reread-vs-flip-back`;
`number-input-unparseable-entry-silently-ignored` filed then closed
`wontfix` (jsdom-only premise). Appended: `voice-extraction-window-demotion-persistence`
(a demoted run now withholds Notes lines), `extraction-fields-to-notes` (no
reader filters on `source` yet).

## Post-merge

- Deploy dev then prod (Cameron's ask). No Terraform, no new table or GSI,
  no data migration; production holds 0 `priority` values.
- No new REQUIRED env var: EXTRACTION_FACT_MIN_CONFIDENCE is optional and a
  blank or absent value reads as 0.7 (RUNBOOK); `secrets:sync` is not owed.
- Every extraction run after the deploy carries a new prompt fingerprint
  (expected); the gate record must be on the final prompt.
- Nothing is broken until any of this is applied.

## Mission health

0 cold-dispatch misfires, 0 agent deaths, 0 recoveries; 27 children (10
research readers, 8 slice implementers - S6 split in two, S7's e2e part
separate - 5 reviewers and 4 fix waves). One orchestrator-side stuck shell call (a `python -`
heredoc) was stopped and is now a recorded trap.
