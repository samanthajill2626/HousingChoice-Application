# Plan design review - adjudications

Plan: `docs/superpowers/plans/2026-10-13-primary-contact-integrity.md`
(v1 @08fd4208). Spec: rev 6. Reviewer severity is the reviewer's;
"decision changed" is the planner's call.

## Round 1 (plan v1 @08fd4208)

Reports: `R1-reviewer-a.md` (6 findings; also re-checked all 190 Edit
old_strings and every region marker against the tree - no anchor defects -
and found no mutation surface or reader missing), `R1-reviewer-b.md` (3
findings). 9 findings, 7 distinct. Re-checked in the plan text before
accepting: the three scalar reads (repo restore, `clearedLandlordHeir`, fake),
the S2.5/S2.6 and S2.7/S2.8 windows, the S3.7 subset and S4.13's missing lint.

Result: 7 ACCEPT, 0 REJECT. Decisions changed: YES (P1) -> round 2.

| id | findings | verdict | decision changed? | resolution in v2 |
|---|---|---|---|---|
| P1 | A1, B1 | ACCEPT | yes | Restore paths decide "was the old landlord the primary?" from the FLAG only (S2.7 real repo, S2.8 `clearedLandlordHeir`, S2.8 fake); with no hand-off the restore write re-aligns the scalar to the stored flag (row marked primary, else REMOVE) without reading it. New S2.8 test: a stale scalar naming the cleared landlord does not move the primary off a live flagged contact. Spec 9.2 corrected (main HAD two scalar readers, both dropped). |
| P2 | A2, B2 | ACCEPT | no | Section 0 states the two in-S2 windows (S2.5->S2.6, S2.7->S2.8) where the real route answers 500; no e2e or live session inside S2. |
| P3 | B3 | ACCEPT as watch item | no | Section 3 watch item: the 60 concurrent delete Scans in `roster-paging.spec.ts` at gate 4 - measure and report if it slows, never tune silently. Per-lane units tables are small. |
| P4 | A3 | ACCEPT | no | Section 0: the vitest globalSetup probes DynamoDB Local on every app run; start it or use `ALLOW_SKIP_DYNAMO_TESTS=1` for fake-only runs (never a gate). S1's "no DynamoDB needed" reworded. |
| P5 | A4 | ACCEPT | no | S3.7 gains the whole app workspace run (AWS-env check, bare); S4.13 gains a baseline-compared eslint step on the dashboard files the branch touched. |
| P6 | A5 | ACCEPT (spec wording) | no | Spec 4.7 bullet narrowed to writes that touch the PRIMARY; a deleted flagged primary on a write that does not touch it stays until the next eligible write or the script (stated, no new behavior - a non-goal-safe reading). |
| P7 | A6 | ACCEPT | no | Rulings R2 corrected to the real import chain; S2 contract item 11 and S5 contract item 3 marked SUPERSEDED in place. |
