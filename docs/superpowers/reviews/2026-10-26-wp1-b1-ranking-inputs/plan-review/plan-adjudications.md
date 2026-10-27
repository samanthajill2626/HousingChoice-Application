# Plan review adjudications - WP1 B1 Ranking inputs

Plan: docs/superpowers/plans/2026-10-26-wp1-b1-ranking-inputs.md
Spec: docs/superpowers/specs/2026-10-26-wp1-b1-ranking-inputs-design.md (rev 8)

## Round 1 (plan v1 @952b2b2e; reviewers A and B, opus, independent)

Reports: plan-review/round1-reviewer-a.md (9 findings),
plan-review/round1-reviewer-b.md (10 findings). Merged: 13. Accepted 13,
rejected 0, deferred 0. Every accepted finding becomes a planner ruling
(plan section 4, PR29-PR41) and is written through into the slice text,
marked `[PRnn]` at the changed step.

Both reviewers walked every D1-D7 bullet, spec 4 surface and spec 5 test
line to a task and found coverage complete; every defect is at a SEAM
between slices drafted in parallel, or in commit hygiene.

| # | Sources | Sev (reviewer) | Finding | Ruling | Decision changed? |
|---|---|---|---|---|---|
| M1 | A1 | HIGH | All 17 S3/S4 commit steps run bare `git add`/`git commit` with no `-C <worktree>` and no status / MERGE_HEAD read; a reset shell commits the shared main index | ACCEPT - PR29: every git command carries `-C W:/tmp/wp1-b1-ranking-inputs`; S3/S4 commit blocks rewritten in the S1/S5 form | no (hygiene; prevents a main-HEAD move) |
| M2 | A2, B3 | HIGH | S6's probe code targets S4/S5 APIs that do not exist (`propertiesSentBlock.ts`, `renderPropertiesSentBlock(rows, displays)`, `filterNoteLines` without `prefix`, `.lines`); `loadBaseModules` would treat the branch as pre-B1; the builder would improvise how the gate builds the block and could bypass `selectSentRows` | ACCEPT - PR30: the exact seam code (block through `selectSentRows` then `renderSentPropertiesBlock`; `SENT_BLOCK_PATH`; `prefix`; `.append`) written into S6.2/S6.3; S6.4 proves the signed-up line | YES - the gate must exercise production `selectSentRows` (spec D7 "certifies production code") |
| M3 | A3, B4 | MEDIUM | S4.3 updates only one of two exact `ApplyOutcome` pins (extractionApply.test.ts:207, :268-279); S5.7's replacement text drops S4's counts | ACCEPT - PR31: S4.3 edits both pins; S5.7 anchors on the post-S4 text and gives the full post-S5 text for both | no |
| M4 | A4, B1 | MEDIUM/HIGH | S4.6's "verbatim" case pins 'Addresses NEVER go in noteLines', which S5.5 removes per PR17 | ACCEPT - PR32: S4.6 drops that assertion (S4 does not own the bullet, PR17); S5.5 owns its replacement pin | no |
| M5 | A5, B2 | MEDIUM/HIGH | S6.6's fake-driver comment spells `area_preference`, which S3.3's readers pin forbids in that file; S6.10 would mis-file the red as unrelated | ACCEPT - PR33: the comment uses `<field key>`; S6.6 runs the readers test | no |
| M6 | A6, B5 | MEDIUM | PR10 / S4.5 / S5.8 disagree on where feedback counts and the fingerprint render; S5.8's zero-count test cannot pass inside S4's guard | ACCEPT - PR34: option (a), all in S4's "Notes lines" region; guard widened to any of the five counts present or `notedLines > 0`; fingerprint an item there; S5.8 tests query that region | no (PR10 was already the intent; this makes it buildable) |
| M7 | A7 | LOW | S6.3 `factFloor` calls a full `loadConfig` on a synthetic env instead of S4.1's exported parser | ACCEPT - PR35: `parseExtractionFactMinConfidence` | no |
| M8 | A8 | LOW | WI3 sweep is word-only; `suggestionResolution.ts:46` "passes 12" survives | ACCEPT - PR36: S3.8 fixes :46; WI3 grep adds `\b12\b` (each hit reviewed) | no |
| M9 | A9, B7 | LOW | S6 lists `secrets:sync` as a handback item, contradicting PR22; a sync writes the key EMPTY | ACCEPT - PR37: struck from S6; RUNBOOK notes a blank value reads as 0.7 | no |
| M10 | B6 | LOW | Rulings that depart from spec text are not flagged for Cameron; precedence spec vs ruling undefined | ACCEPT - PR38: section 0 states it; the deviations (PR16, PR17, PR21, PR22, PR24, PR41) are listed at the launch gate | no |
| M11 | B8 | LOW | The probe's price table values are unverified and pinned by a test | ACCEPT - PR39: rows marked "unverified, Cameron confirms at the launch gate"; the cost line in the record is informational, never a pass condition | no |
| M12 | B9 | LOW | S7 gives no exact command to run one new e2e spec | ACCEPT - PR40: the e2e README form (README:185-206) written into section 11 | no |
| M13 | B10 | LOW | Banned terms matched as a union at word starts will flag home facts ("grade-level", "black mold", "senior citizen", "country") and force paid re-runs | ACCEPT - PR41: single words that are ordinary home vocabulary become phrase forms; the list is shown to Cameron at the launch gate | no (the spec's zero-hit rule stands) |

Decision changes this round: 1 (M2 - the gate's block path). Round 2
runs (continue reviewer A: more unique accepted findings, incl. the only
commit-hygiene HIGH; it gets reviewer B's report path).

## Round 2 (plan v2 @25812156; reviewer A continued with the re-review charge)

Report: plan-review/round2-reviewer-a.md (4 findings). The reviewer
re-verified PR29-PR37 and PR39 against the tree and the S4/S5 text:
anchors match and the seam signatures line up. Accepted 4, rejected 0.

| # | Sev | Finding | Ruling | Decision changed? |
|---|---|---|---|---|
| R2-1 | MEDIUM | S7 commits between specs run against one long-lived `e2e:session`; the preflight rejects a server stamped at an older commit (e2e/support/preflight.ts:96-135), so S7.2/S7.3 die in globalSetup | ACCEPT - PR43: start ONE session at S6's final commit; write and run S7.1-S7.3 against it with NO commit in between; stop it; then commit S7.1-S7.3 one task at a time | no (sequencing) |
| R2-2 | MEDIUM | PR41's phrase-only union swaps false FAILs for false PASSES: a case's own fact paraphrased ("the only Black resident", "expecting her first child", "moved to the US two years ago") scores clean; `expecting in` hits "Expecting inspection Friday" | ACCEPT - PR44: per-case STRICT terms (spec D7 "Each case carries banned terms"), bare words included, checked only against that case's own lines; PLUS the phrase-form union checked against every line; drop `expecting in` | YES - gate detection rule |
| R2-3 | LOW | PR38's deviation list is incomplete (PR9, PR23, PR25 missing); S5 C7's one-space flattening has no ruling | ACCEPT - PR45: S5 C7 accepted (one-space flattening in the leaf, since toSingleLine cannot be imported there); PR38's list extended with PR9, PR23, PR25, PR44, PR45 | no |
| R2-4 | LOW | With PR42 a run that failed at the model call renders "0 appended" as if apply ran; PR42's test is prose only | ACCEPT - PR46: inside the region the `notedLines` row renders only when an S4/S5 count is present or `notedLines > 0`; a fingerprint-only run shows the fingerprint item alone; the test is written as code | no |

Decision changes this round: 1 (R2-2). Round 3 runs after the write-through.

## Round 3 (plan v3 @058f3e7c; reviewer A continued) - TERMINAL

Report: plan-review/round3-reviewer-a.md (3 findings). The reviewer
confirmed PR43's one-session sequence against the e2e preflight (HEAD
compare only) and PR46's region JSX and tests against S4.5's anchors.
Accepted 3, rejected 0. No decision changed (a test login and term-list
tuning), so per the stop rule this is the terminal round: folded in, no
round 4.

| # | Sev | Finding | Ruling | Decision changed? |
|---|---|---|---|---|
| R3-1 | MEDIUM | S7.2 test 4 and S7.5 open the AI run detail, which is admin-only (aiRuns.ts:137); the file's devLogin is the VA user (dev.ts:326, :333-336) | ACCEPT - PR47: that step dev-logs in as `founder@example.com`, as ai-run-log.spec.ts does | no |
| R3-2 | MEDIUM | Strict lists miss bare-number ages ("Two kids (4 and 11)") and "U.S." / "United States" / "America" | ACCEPT - PR48: each children's-ages case carries its literal ages as strict terms; national origin adds `u.s`, `united states`, `the states`, `america`; the term-shape check allows `.` | no |
| R3-3 | LOW | `expecting`, `tone`, `light`, `condition` are likely in a correct line of their own case | ACCEPT - PR49: `expecting` narrowed to `expecting a` / `expecting her` / `expecting his` / `expecting their`; `tone`, `light`, `condition` dropped | no |

## Round 4 (plan v5 @0823dd21; reviewer A continued) - the launch-gate revision, at the cap

Cameron revised two decisions at the launch gate (spec rev 9; charter
section 20 items 9-10): the no-address prompt bullet is deleted (PR50) and
a model grader replaces the banned-word lists (PR51; S6 redrafted by a
fresh opus drafter, assembled by the planner; PR52 fixes a pre-existing
dry-run print mismatch the drafter found). Round 4 reviewed that revision.
Report: plan-review/round4-reviewer-a.md (5 findings). Accepted 5,
rejected 0. The reviewer confirmed S5.5's RED reason, the adapter seam
(SDK only in adapters/extraction.ts, stubbed in its one test), no test
reaching the network, the S6.1-S6.4 names against the S6.2 harness, the
2-of-3 bar, and the call/cost arithmetic.

| # | Sev | Finding | Ruling | Decision changed? |
|---|---|---|---|---|
| R4-1 | MEDIUM | The grader allows a pronoun, so a sex-case line "She lives alone ..." grades clean; no Cameron ruling allows it | ACCEPT - PR54: kept as a DEFAULT and put to Cameron at the launch gate with the other allowances | no (his call at the gate) |
| R4-2 | MEDIUM | An ungraded run's lines are never shown to Cameron; a leak there still reads PASS on every automatic check | ACCEPT - PR55: "Lines the grader did not judge" section, a test, gate step 2 sends him there | yes (a record surface added) |
| R4-3 | LOW | "my mom" (household control) and "I use a wheelchair" (accessibility control) sit on an unaddressed boundary; one flip fails the gate | ACCEPT - PR54: both stated as allowed in the grader prompt, defaults for Cameron at the gate | no |
| R4-4 | LOW | S6.10 Step 5 expects one `createStructuredOutputClient` probe line; S6.4's header adds a second | ACCEPT - PR56 | no |
| R4-5 | LOW | The S5 coverage map still names the own-address rule | ACCEPT - PR57 | no |

Round 4 is the hard cap. It changed one decision (R4-2, a review surface
in the record), so per the cap rule the open items go to Cameron as a
decision at the launch gate rather than a round 5: PR54's allowances and
whether "sex" covers sexual orientation and gender identity.
