---
id: move-prompt-modal-loses-filled-date-under-load
title: The Schedule-inspection move prompt lost a filled date between fill and confirm - a user typing when a live tick lands would lose it too
type: bug
severity: med
status: open
area: dashboard
created: 2026-08-24
refs: dashboard/src/routes/placements/MovePromptModal.tsx:190, dashboard/src/routes/placements/PlacementDetail.tsx:719, e2e/scenarios/steps.ts:3544, e2e/tests/scenarios/approval-and-move-in.spec.ts:223
---

**Sighting 2 (2026-08-24, `fix/test-suite-wave3` gate RE-run, 250/3, 27.4m).**
:223 failed AGAIN in the re-run, but at an EARLIER step ('App: placement is at Awaiting inspection') with a plain-timeout shape - slowness, not necessarily the input-loss mechanism. Keep the two signatures separate when tallying: the empty-field-with-open-dialog snapshot from run 1 is the input-loss evidence; this one is load.
IMPORTANT CONTEXT for both runs that day: the re-run raced a LIVE concurrent
feature mission on the same machine (a dozen Playwright MCP browser processes,
a live test-server, Codex runtimes), and the suite ran 27.4m against a healthy
21m baseline. All three failures in that run were already-filed load-sensitive
issues; treat sightings from it as heavy-load data points, not baselines.


**Sighting (2026-08-24, `fix/test-suite-wave3` gate run, 252 passed / 1
failed, 21.0m).** `approval-and-move-in.spec.ts:223` (inspection FAILS ->
Lost) timed out clicking "Confirm move" in the Schedule-inspection dialog. The
failure-time page snapshot (`error-context.md`, PRESERVED this time) is the
evidence that makes this a product bug and not test noise:

```
- dialog "Schedule inspection" [active]
  - textbox "Inspection date"          <- EMPTY
  - button "Confirm move" [disabled]   <- validity-gated on the date
```

The step sequence is fill-then-click (`steps.ts:3544`): the `fill(date)`
RESOLVED (no error), Playwright then resolved the Confirm button as
enabled-visible-stable ("done scrolling" in the call log), and by the time the
click could dispatch the field was EMPTY and the button disabled - where it
stayed for the rest of the 30s budget. A value that was present and then was
not: whatever cleared it would clear a HUMAN's typed date the same way when it
fires mid-entry. Same class as the merged `codex/modal-focus-stability` fix
(the shared Modal dropping keystrokes on parent re-render).

**What the evidence rules out, and what it leaves.**

- The input is CONTROLLED with no effects (`value={inspectionDate}`,
  `useState(initial?.inspectionDate ?? '')`, zero `useEffect` in the modal), so
  the value cannot drift without a state reset.
- A FULL PlacementDetail remount is ruled out: `pending` (the state that mounts
  the dialog) would have reset to null and the dialog would have vanished. It
  is still open in the snapshot.
- That leaves a remount of the MODAL SUBTREE alone - state survives in the
  parent, the modal re-initializes from `initial.inspectionDate =
  placement.inspection_date`, which is undefined before the move commits ->
  empty field, disabled button. The obvious suspect (the `status === 'loading'`
  early-return unmounting children during an SSE-driven refetch) is weakened by
  the refetch-in-place design note at `PlacementDetail.tsx:162` (no synchronous
  loading reset), so the exact remount trigger is UNPROVEN. The failure video
  exists; watch it before theorizing further.

**Measurements.** Full suite: 1/1 occurrence in this run; the same spec FILE
carries `placement-stage-more-actions-suite-only-flake` (:318, a different
test, 2026-08-23) - two load-sensitive sightings in one file, both in the
placement-stage dialog machinery. Solo run of the whole spec file, same commit, minutes later: 5 passed (2.7m) - the remount trigger needs suite-level load, consistent with an SSE/refetch race rather than deterministic logic.

**Suggested fix (product-side, small).** Make the modal's field state survive a
remount OR stop the remount:
- give `MovePromptModal` a stable `key` and verify nothing conditionally
  unmounts it while `pending` is set; or
- lift the draft value into the `pending` state that already owns the dialog's
  existence, so a child remount cannot lose it.
Spec-side workarounds (re-fill on empty) would mask a real user-facing loss and
are the wrong lane.

**Deliberately not fixed on `fix/test-suite-wave3`:** that branch is test
hardening; this is dashboard product code. Filed with the evidence instead.
