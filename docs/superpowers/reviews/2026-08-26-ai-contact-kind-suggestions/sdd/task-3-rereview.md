# Task 3 fix wave 1 re-review

## Verdict

- **SPEC-CONFORMANCE: FAIL**
- **TASK-QUALITY: CHANGES REQUIRED**
- Original findings: 1 addressed, 1 not addressed
- New critical/important findings: 0

Review was read-only. No tests were run. Evidence is from the exact
`3f96cfa5..fd65d9ce` fix diff, current committed source, the original review,
fix report, Task 3 brief, approved design/plan, and live worklist.

Cold review found no new critical or important defect in the fix code. The
consistent-read correction is complete, and the job-level fake now persists and
deletes a real suggestion row with an explicit interleaving. However, the
load-bearing marker transition is still fabricated before the interleaving, so
the original high finding remains open.

## Original findings

### HIGH - Job-level finalization handoff: NOT ADDRESSED

The fix materially improves the test but does not model the required marker
state machine. `beginFinalization` seeds the marker with the already-terminal
`superseded_by_human_edit` verdict at
`app/test/extractionJob.test.ts:976-979`. Production `beginFinalization` creates
an empty verdict map at `app/src/repos/aiRunsRepo.ts:203-212`; the terminal
verdict is created later by `setVerdict` at
`app/src/repos/aiRunsRepo.ts:420-435`.

The new test does prove several previously missing facts:

- finalization begins before apply (`extractionJob.test.ts:976-980,1038-1040`);
- `putSuggestion` actually persists the type row and observes it before the
  route-shaped handoff (`:1015-1023`);
- the row is deleted, `setVerdict` is invoked after the put and before `putRun`,
  and the row is absent afterward (`:1024-1027,1037-1040`);
- `putRun` receives the still-pending apply decision and merges only when that
  incoming verdict is pending (`:981-990,1041-1044`);
- the extraction-owned successful-delete counterexample remains covered at
  `:949-969`.

But `setVerdict` is not load-bearing. Because the marker is terminal from
`beginFinalization`, making the `setVerdict` body leave the marker unchanged
would still produce the terminal merged record at `:983-990`; the sequence
assertion would still pass because `setVerdict` pushes its label before mutating
the marker at `:996-1001`. Thus the test cannot detect a broken terminal marker
write, and it does not prove that the post-put route action created the verdict
that `putRun` merged. This misses the required causal handoff in approved design
`docs/superpowers/specs/2026-08-26-ai-contact-kind-suggestions-design.md:324-331,506-508,565-568`
and plan `docs/superpowers/plans/2026-08-26-ai-contact-kind-suggestions.md:768-780`.

Required correction: initialize a pending/empty marker at
`beginFinalization`; have `setVerdict` transition that marker to terminal only
after the persisted suggestion is deleted; make `putRun` merge only a terminal
marker over an incoming pending decision. The final verdict assertion must then
fail if the `setVerdict` mutation is removed or moved outside the post-put,
pre-`putRun` window.

### MEDIUM - Consistent reads in race/retry tests: ADDRESSED

Every reconciliation state and retry read now pins the owner id plus
`{ consistentRead: true }`:

- classified and newer-Unknown cleanup:
  `app/test/extractionApply.test.ts:463-491`;
- replacement/marker preservation: `:494-504`;
- both conflict-retry reads: `:507-520`;
- stable Unknown, missing contact, and read failure: `:523-559`;
- all four bounded conflict reads: `:562-575`.

Removing the consistent-read option from the production call at
`app/src/services/extraction/apply.ts:740-742` now breaks these assertions.

## New-finding sweep

No new critical or important breakage found in `fd65d9ce`. The stateful
suggestion map in `makeRepo` persists by exact suggestion item id and deletes by
the same contact/target identity (`app/test/extractionJob.test.ts:164-200`), so
the new absence assertion is meaningful. The exact sequence assertion also pins
the delete between persistence and `putRun`; the sole remaining defect is that
the terminal marker state exists too early, as adjudicated above.
