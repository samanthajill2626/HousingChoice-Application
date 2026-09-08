---
id: e2e-image-viewer-scroll-flake
title: outbound-MMS viewer scroll setup and lifecycle checkpoints
type: bug
severity: med
status: in-progress
area: e2e
created: 2026-08-31
refs: e2e/tests/dashboard-next/outbound-mms.spec.ts, docs/superpowers/reviews/2026-09-02-outbound-mms-scroll-flake/diagnostic-and-fix.md
---

## Symptom

Reopened 2026-09-07: the same desktop test now fails before opening the viewer
with `trigger is not visible` when earlier MMS tests populate the Timeline.
The three-test reproducer and measured setup geometry are documented in
`docs/superpowers/reviews/2026-09-07-outbound-mms-scroll-recheck/diagnosis.md`.
The 2026-09-02 delivery re-anchor fix below remains valid for its measured
512-to-500 signature; it did not fix this populated-history setup failure.

The desktop image-viewer case in `outbound-mms.spec.ts` intermittently observed
different Timeline or AppFrame offsets while the modal was open. Two full-suite
failures were reported on 2026-08-31 and 2026-09-01. On 2026-09-02, the exact
focused case reproduced the currently reported mismatch: expected Timeline
`scrollTop` 512 and received 500. The MMS send, fake-provider media record,
authenticated image response, and rendered Timeline thumbnail all completed.

The related `outbound-mms-viewer-scroll-capture-flake` issue was a duplicate and
remains as a resolved pointer to this canonical record.

## Root cause

The failing trace identified the first owner movement:

- The pre-open baseline and dialog-visible phase both reported AppFrame 20 and
  Timeline 512, with Timeline maximum 512.
- The pointer was inside the viewer canvas when the dialog became visible.
- 178 ms later, a Timeline character-data mutation and delivery-status class
  change to the success tone committed.
- In the same commit, Timeline moved from 512 to 500 while its scroll height,
  client height, and maximum remained unchanged. A native Timeline scroll event
  followed. AppFrame remained 20.
- Every wheel and pan-bound phase after that stayed at 500. Out-of-viewport pan
  endpoints hit no background element.

The test captured its baseline before the just-sent MMS reached the rendered
terminal `Delivered` state. Its setup used `scrollIntoView`, which left the
Timeline at the browser's true bottom (512). The delivery refetch rebuilt
`clusters`; Timeline's intentional layout effect then restored its message
sentinel anchor (500). The viewer did not scroll the background, and the owner
geometry did not clamp.

This was an unstable test lifecycle checkpoint caused by delayed Timeline
anchoring. It was not product pointer leakage, a resource constraint, or a
parallel-worker race.

## Resolution

The test now waits for the matching outbound bubble to visibly reach its
terminal `Delivered` state before arranging and capturing the viewer scroll
baseline. This is a state-based lifecycle condition, not a timeout or arbitrary
delay.

The exact equality contract remains intact and is checked after opening the
viewer, after wheel zoom, after every bounded pan, immediately before the
while-open assertion, and after Escape restores focus and closes the dialog.
Trace-gated diagnostics now also capture canvas bounds, pointer coordinates,
the element under the pointer, and both named scroll owners at each phase.

The red run and Playwright trace were preserved locally before rerunning under:

`W:\tmp\outbound-mms-scroll-flake\.artifacts\red-scroll-512-to-500-20260902`

## Verification

Before adversarial review:

- `npm run typecheck -w @housingchoice/e2e`: passed.
- Targeted dashboard Timeline/viewer unit tests: 4 files, 33 tests passed.
- Exact traced focused browser test: 1 passed.

Final post-review verification is recorded with the branch review artifacts.

After the review fix, E2E workspace typecheck passed again and the exact traced
focused browser test passed again. Independent re-review returned PASS with no
remaining findings.
