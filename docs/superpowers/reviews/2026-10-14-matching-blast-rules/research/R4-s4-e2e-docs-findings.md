# R4 findings - S4 e2e, docs, completion (plan section 8)

Reader R4, 2026-10-18, live tree `W:/tmp/matching-blast-rules` (code = main
@a2b3d80d). Byte-exact backing, the anchor table, the e2e inventory and the
ruling map: `.superpowers/sdd/R4-s4-e2e-docs-reference.md` (gitignored).

Summary: every S4 anchor (42) is FOUND and unique; F1-F22 and F24-F26 hold (F23
is stale but harmless); the e2e inventory finds no breaking spec the plan
misses except the AR22 draft-delete test, which has no step text in Task 4.1;
every Task 4.1 repair, traced against S1-S3's binding behavior, fixes its spec;
the a2p path (c) test keeps `skipped_no_consent === 1`; the lint backlog premise
(22 errors across 17 files, 14/4/2/2) re-measured TRUE on this tree.

## R4-1 - CORRECTION - gate-5 baseline counts only plugin-prefixed rules

- Plan: section 8, Task 4.4 Step 5 (plan :12722-12736); the same counting is
  what the AR38/AR42 lint-record step relies on.
- Evidence: Step 5 tallies rules with
  `grep -oE "(react-hooks|@typescript-eslint)/[a-z-]+"`. This repo's config also
  makes BARE core rule ids errors: `tseslint.configs.recommended` turns on
  `no-var`, `prefer-const`, `prefer-rest-params`, `prefer-spread`
  (node_modules/@typescript-eslint/eslint-plugin/dist/configs/eslint-recommended-raw.js:39-43),
  and eslint.config.mjs adds `no-restricted-syntax` on `app/src`. A new error
  of those rules in a touched file shows in neither tally, so the step's "the
  rest are pre-existing" rule would misattribute it (BroadcastComposer.tsx and
  useComposerDraft.ts are the dirty-at-base files where this bites; a clean
  file is equally blind). Second trap, measured: react-hooks errors embed an
  `<abs path>:<line>:<col>` line in stylish output, so counting drive-path lines
  on main reads 40, not the true 17 files.
- Correction: tally rule ids from JSON, both sides, e.g.
  `npx eslint --format json "REL" > head.json` and
  `npx eslint --format json --stdin --stdin-filename "REL" < base.txt > base.json`,
  then count `messages[].ruleId` with `severity === 2` per file (a short `node -e`
  over the JSON); any rule id whose HEAD count exceeds BASE is the branch's and
  BLOCKING. For the AR38 lint record, take errors, files (entries with
  `errorCount > 0`) and per-rule totals from `npx eslint . --format json`
  (or count only path lines not ending in `:<n>:<n>`).

## R4-2 - NOTE - AR22 has no step text in Task 4.1 (ruling map)

- Plan: AR22 (plan :480-488) vs Task 4.1 Steps 2, 3, 11 (plan :10916-11986),
  which never touch the draft-delete test.
- Evidence: e2e/tests/dashboard-next/broadcasts.spec.ts:411-416 captures the
  FIRST `POST /api/broadcasts` after the heading; the hook deletes a superseded
  draft when a newer one lands (dashboard/src/routes/broadcasts/useComposerDraft.ts:206,
  :220), and AR23 moves the first create to after the org list loads.
- What the implementer adds (binding via AR22): an edit to broadcasts.spec.ts
  :404-416 - record every create response with `page.on('response')` armed
  before the :408 `page.goto`, wait for `Preview recipients` enabled, take the
  LAST create and read its JSON before the :419 navigation; add `type Response`
  to the :1 import. Step 2: a red draft-delete test on the S3 tip is a known
  AR22 race, not a "stop and diagnose". Step 11's commit message names it. A
  code sketch is in the reference, section 9. Stricter option: match the create
  whose `body_template` equals the typed text.

## R4-3 - NOTE - S2's docs ask is not carried into Task 4.3

- Plan: S2 "Notes for other slices" (plan :6420-6424) asks the RUNBOOK /
  GLOSSARY wording to say a filter blast's preview and its no-body (path c)
  send fail closed (503 `audience_rules_unavailable`) on a failed tours or
  decline read; Task 4.3 Steps 1-3 (plan :12411-12472) say nothing about it.
- Spec section 7 does not require it. Orchestrator's call: either add one
  sentence to the GLOSSARY Matching entry (Step 1) or drop the S2 note.

## R4-4 - NOTE - Task 4.4 text superseded by AR28 and AR38/AR42

- Task 4.4 Step 0 (plan :12588-12590) says the early sync is optional ("you
  MAY"); AR28 makes it MUST before any gate.
- Task 4.4's header (plan :12579) says "No commit"; AR27/AR38/AR42 add a final
  docs-only commit of docs/issues/lint-backlog-repo-wide.md (new dated status
  paragraph after the frontmatter, frontmatter `title` counts and `updated:`,
  AGENTS.md untouched). Expected after S3: 20 errors across 17 files (12
  set-state-in-effect, 4 refs, 2 purity, 2 immutability). S3's note (plan
  :10648, "21 across the same 18 files") is superseded.
- Step 2's prose "the 23 pre-existing errors" is AGENTS.md's dated figure; the
  measured base is 22 (cosmetic).
