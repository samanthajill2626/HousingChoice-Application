# R2 - S2 app rules in the routes - research findings

Reader R2 (area R2-s2-app-routes), 2026-10-18. Live-tree drift check of plan
section 6 (Tasks 2.1-2.5, plan lines 3931-6429) against
`feat/matching-blast-rules` @01782138 (code == main @a2b3d80d), with S1's task
code (plan 662-3930) applied on paper per AR21.

Result: every S2 anchor is FOUND (or FOUND-AFTER-S1) except Task 2.5 C-Edit 8,
which S1 replaces by design; every "Facts the tasks rely on" bullet holds (two
line hints are off by one); the three invariant sweeps found no unlisted
writer, reader or recipient path. Baseline: `app/test/broadcastApi.test.ts`
109/109 green at base; the Task 2.5 grep gate prints exactly the 7 predicted
lines. Byte-exact backing, the anchor table and the sweep tables:
`.superpowers/sdd/R2-s2-app-routes-reference.md` (gitignored run state).

Counts: BLOCKING 0, CORRECTION 2, GAP 0, NOTE 2.

## R2-1 (CORRECTION) - Task 2.3 uses the superseded truncation message (AR32)

- Plan location: section 6, Task 2.3 Step 1 T-Edit 1 (plan :5544-5546) and
  Step 3 I-Edit 2, the truncated branch of the 400 body (plan :5858-5859).
- Evidence: both lines carry
  `audience resolution was truncated (more than ${MAX_BROADCAST_RECIPIENTS} candidates) - the audience could not be read completely`.
  Ruling AR32 (plan :537-540) replaces it: "the resolver's read bound is
  pages x page size, not the recipient cap", and "Every test asserting it
  uses this exact string". Plan 1.1 (:125) still shows the old text too; AR32
  amends it. Live route today: `app/src/routes/broadcasts.ts:1010-1012`; the
  only test on it: `app/test/broadcastApi.test.ts:683`.
- Correction: in BOTH places use exactly
  `audience resolution was truncated - the audience could not be read completely`
  (a plain string; no template needed). T-Edit 1 becomes
  `expect(send.body.message).toBe('audience resolution was truncated - the audience could not be read completely');`
  and the I-Edit 2 ternary's true branch returns that string. The over-cap
  branch stays byte-identical to AR8 (plan :5860 matches AR8 and the test at
  :5720). RED reasons in Step 2 are unchanged (today's text holds U+2014 and
  the narrowing advice).

## R2-2 (CORRECTION) - Task 2.5 C-Edit 8's old_string cannot match after S1; AR9 says insert only

- Plan location: section 6, Task 2.5 Step 2 C-Edit 8 (plan :6231-6256);
  ruling AR9 (plan :416-420) supersedes S2 CONTRACT ISSUE 4.
- Evidence: the C-Edit 8 old_string is the pre-S1 "Audience:" paragraph
  (`app/src/routes/broadcasts.ts:14-18`). S1 Task 1.5 Step 6 (plan
  :3708-3753) replaces lines 14-28 wholesale, so that text no longer exists
  when Task 2.5 runs (NOT FOUND, deterministically). AR9: S2 "only ADDS the
  tour-hold / fail-closed sentence to S1's 'Audience:' text, never rewriting
  it". The plan's fallback names the sentence but no anchor, and the sentence
  carries no fail-closed clause although AR9 names one.
- Correction: skip the primary replacement. Anchor on the two lines that are
  byte-identical before and after S1 and unique in the file (base :17-18, S1
  plan :3736-3737):
  ```
  // Opted-out + unreachable are ALWAYS excluded. The send fans out through the
  // SHARED A2P throttle (the broadcast.send job + worker a2pBucket).
  ```
  and replace them with (ASCII; S1's D1/D2 lines above stay untouched):
  ```
  // Opted-out + unreachable are ALWAYS excluded. A tenant with an unresolved
  // tour (D4) or a #27 decline is listed for review but not checked by default
  // (checkedByDefault, D5), and the no-body filter send (c) leaves them out
  // (D6); a failed tours or decline read fails a filter preview and that send
  // closed (503 audience_rules_unavailable). The send fans out through the
  // SHARED A2P throttle (the broadcast.send job + worker a2pBucket).
  ```
  (Drop the "a failed tours or decline read ..." clause if the orchestrator
  reads AR9's "fail-closed" as already carried by the C-Edit 7 route lines.)
  The Step 1/Step 3 grep gate is unaffected (no gate pattern lives in this
  paragraph).

## R2-3 (NOTE) - cross-slice precision, no instruction change required

- Task 2.1 I-Edit 1 (plan :4655-4669): the "If S1 already added an import
  from '../lib/blastAudienceRules.js'" branch ALWAYS applies - S1 Task 1.4
  Step 4 (plan :3160) adds `import { authoritiesOfFilter, MAX_FILTER_AUTHORITIES, wireAudienceFilter } from '../lib/blastAudienceRules.js';`
  after `broadcasts.ts:82`. Merge into that statement (merged text in the
  reference, section 9). Conversely Task 2.1 T-Edit 1's conditional never
  applies: S1 adds no blastAudienceRules import to
  `app/test/broadcastApi.test.ts`, so the plain insert after :42 is right.
- Line hints that drifted (text anchors are correct): C-Edit 6's two lines
  are `app/src/repos/contactsRepo.ts:1397-1398` and the U+2014 sits on 1397
  (plan :6204-6205 says 1396-1397 / "line 1396"); `seedOrgNames.test.ts`'s
  `orgValues` broadcasts loop is :84-89 and the pinned test :141-146 (facts
  :4075-4076 say :83-88 / :142-147).
- S2's note to S1 (plan :6403-6406) says S1 should not touch
  `broadcasts.ts:652-705`; S1 Task 1.4 Step 7 does edit :697-699 (the 201
  echo). Harmless: S2's Task 2.2 I-Edit 5 anchor (:695-696) stays
  byte-identical.
- Task 2.4 edits `matrix.ts`, but the slice-end run (plan :6280) does not
  include `app/test/seedMatrix.test.ts`; it pins only status,
  `_listPartition` and `skipped_no_consent` of the seeded broadcasts
  (:490-510), so it stays green (gate 2 runs it anyway).

## R2-4 (NOTE) - two router dep docs go stale-by-omission (optional touch)

- Evidence: `app/src/routes/broadcasts.ts:124-129` documents
  `listingSendsRepo` as "the preview's not-interested labels and the
  follow-ups list" and `:130` `toursRepo` as "the tours a decline (and a
  follow-up row) is measured against". After S2 both also feed draft
  create's estimate and send path (c), and `toursRepo` gains the open-tours
  read (D4/D5). Spec section 7 does not list these lines, and they are not
  wrong, only incomplete.
- Suggestion (optional, no gate depends on it): Task 2.1 or Task 2.5 may add
  one clause to each, e.g. "...; since matching-blast-rules also the open-tour
  holds (D4) read by buildReviewRows and send path (c)".
