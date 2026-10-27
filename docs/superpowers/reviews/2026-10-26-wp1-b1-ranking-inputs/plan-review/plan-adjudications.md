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
