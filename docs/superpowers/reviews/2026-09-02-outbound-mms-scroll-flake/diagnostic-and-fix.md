# Outbound MMS Scroll Flake Diagnosis and Fix

Date: 2026-09-02
Branch: `fix/outbound-mms-scroll-flake`
Synced main: `a2602e32`

## Scope

This is an authorized small fix for the desktop image-viewer portion of
`e2e/tests/dashboard-next/outbound-mms.spec.ts`. The work stayed in
`W:\tmp\outbound-mms-scroll-flake` and did not modify
`feat/message-transport-fidelity`.

## Diagnostic method

The trace-gated page recorder sampled both named scroll owners before opening,
immediately after opening, after wheel zoom, before and after every pan bound,
before the failing assertion, and after Escape. Each sample included owner
geometry, viewer canvas bounds, the last pointer coordinates, and the element
under the pointer. Mutation, resize, and native owner-scroll events were also
recorded.

`E2E_TRACE=1` was enabled. `E2E_CHILD_LOG_DIR` was explicitly unset because
redirected child output changes timing for this symptom.

## Red proof

The exact focused command was invoked serially from clean harness starts:

`npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/outbound-mms.spec.ts --grep "fake records media"`

The first two exact invocations passed. The third failed in 6.5 seconds at the
while-open equality assertion:

- expected AppFrame 20 and Timeline 512;
- received AppFrame 20 and Timeline 500.

The complete failure report, screenshot, video, trace, error context, and JSON
report were copied before any rerun to:

`W:\tmp\outbound-mms-scroll-flake\.artifacts\red-scroll-512-to-500-20260902`

## First transition

The recorder sequence was:

1. Baseline: Timeline top 512, maximum 512, distance from bottom 0.
2. Dialog visible: the same offsets and geometry; the pointer was inside the
   viewer canvas.
3. 178 ms later: a Timeline text mutation and status-class change to the success
   tone; Timeline top became 500 while maximum stayed 512.
4. A native Timeline scroll event followed at top 500.
5. Wheel zoom and all four pan bounds remained at top 500. The out-of-viewport
   pan endpoints had no element under the pointer.

AppFrame never moved. No resize occurred. Because maximum stayed 512, the 12 px
change was not a geometry clamp. Because it coincided with the Timeline status
commit while the pointer remained in the portaled viewer, it was not gesture
leakage.

## Root cause

The test captured scroll before the outbound bubble reached rendered terminal
delivery. Its setup left Timeline at the browser's true bottom, 512. The delayed
delivery refetch changed `clusters`, causing Timeline's intentional layout effect
to call its message-sentinel anchor restoration, which moved the owner to 500.

This is a test lifecycle race with delayed Timeline anchoring. It is unrelated to
Playwright worker concurrency or machine resource pressure.

## Fix

The test waits for `Delivered` within the matching outbound bubble before it
arranges and captures the scroll baseline. The wait is scoped to the unique MMS
body token and is satisfied by product state, not elapsed time.

Exact owner equality is now asserted after dialog open, after wheel zoom, and
after every pan bound in addition to the existing while-open and post-Escape
checks. The viewer behavior and production code are unchanged.

## Focused proof before review

- `npm run typecheck -w @housingchoice/e2e`: exit 0.
- `npm test -w @housingchoice/dashboard -- src/routes/contact/streamAnchor.test.ts src/ui/imageViewer/scroll.test.ts src/ui/imageViewer/ImageViewerProvider.test.tsx src/ui/imageViewer/ImageViewer.test.tsx`: exit 0, 4 files and 33 tests passed.
- Exact focused E2E with trace enabled and child logs disabled: exit 0, 1 passed
  in 21.8 seconds; test body 7.9 seconds.

No aggregate `npm test` or full E2E suite was run.
