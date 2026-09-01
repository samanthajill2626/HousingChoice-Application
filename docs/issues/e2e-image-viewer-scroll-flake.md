---
id: e2e-image-viewer-scroll-flake
title: outbound-mms image-viewer scroll assertion fails intermittently under full-suite load
type: bug
severity: med
status: open
area: e2e
created: 2026-08-31
refs: e2e/tests/dashboard-next/outbound-mms.spec.ts:470, e2e/tests/dashboard-next/outbound-mms.spec.ts:630
---

## Symptom

The first test in `outbound-mms.spec.ts` intermittently reaches the assertion
historically reported at line 463, now at line 630 after diagnostic code was
added, with different scroll offsets from the values captured immediately before
the image viewer opens. Both known occurrences were in full-suite runs:

| Date | Expected | Received | Full-run result |
| --- | --- | --- | --- |
| 2026-08-31 | AppFrame 20, Timeline 509 | AppFrame 0, Timeline 421 | 258 passed, 1 failed |
| 2026-09-01 | Timeline 509 | Timeline 797 | 261 passed, 1 failed |

The two failures moved in opposite directions. The newer failure added 288px to
the Timeline offset; the older failure removed 88px from Timeline and reset
AppFrame from 20 to 0. No single scroll-lock or bottom-repin explanation accounts
for both observations without additional geometry evidence.

## Verified evidence

- The expected values are not hardcoded. The test arranges both scroll owners,
  then captures their live `scrollTop` and `scrollLeft` values at lines 470-509.
- The viewer is portaled outside the inert application background. There is no
  viewer scroll-lock code writing these owners while the dialog is open.
- A programmatic `scrollTop` write fires a `scroll` event in Chromium, so manually
  dispatching another `scroll` event would not make a missing write observable.
- The relevant viewer, Timeline, and test blobs were unchanged across the green
  and red commits examined for the 2026-09-01 occurrence.
- The file passed 6/6 in isolation after each reported failure. A fresh traced
  main baseline on 2026-09-01 also passed 6/6. That narrows the problem to
  full-suite state or timing; it does not excuse the failure.
- The fresh traced baseline arranged Timeline at its maximum scroll offset
  (`top=193`, `maximumTop=193`) and stayed there without a native scroll event.
- A fresh traced full run passed all 6 outbound-MMS cases. Its target case began
  at Timeline `top=509`, `maximumTop=809`. Three background mutations changed
  `scrollHeight` from `989` to `997`, then `975`, and finally `977`; the offset
  stayed `509`, while the final maximum became `797`.
- The newer historical failure's received value was exactly that control maximum:
  expected `509`, received `797`. This strongly supports a snap to bottom after a
  Timeline refresh in that occurrence. It does not prove which write triggered it,
  and it does not explain the older opposite-direction Timeline movement plus
  AppFrame reset.
- The full-run browser artifacts from both historical failures were overwritten
  before they could be inspected. Their screenshots and paths are not evidence
  that can still be recovered.

## Contract boundary

The approved product contract is that the inert background cannot be scrolled by
the user while the viewer is open, and that the exact captured offsets are
restored when the viewer closes. The while-open assertion is stricter: it also
requires background layout updates to leave the raw offsets unchanged for the
entire open interval. A product update can legally change underlying geometry
while the modal is open, so the source of any movement must be identified before
deciding whether to change product code or narrow that assertion.

## Open questions

The missing evidence is the first event that changes either scroll owner and the
geometry at that instant. For the newer occurrence, the leading hypothesis is a
Timeline cluster refresh reaching the `atBottomRef` branch and assigning
`scrollTop = scrollHeight` after the test captured an offset 288px above the final
maximum. The open question is why that ref would still be true after programmatic
arrangement moved the stream away from the bottom. The older occurrence still
requires a different write or a larger layout shift. Plausible sources include a
cross-spec actor, a periodic application refresh, or a resize that clamps or
repins a scroll owner. Pan pointer leakage remains lower probability because the
viewer is portaled above an inert background.

## Diagnostic experiment

Run the full suite with `E2E_TRACE=1` and a trace-gated page-side recorder in the
failing test. The recorder must not alter product behavior. It records:

- phase samples after scroll arrangement, viewer open, zoom, and every pan;
- native `scroll` events for AppFrame and the Timeline stream;
- relevant DOM mutations and resize notifications;
- `scrollTop`, `scrollHeight`, `clientHeight`, maximum scroll, and bounding boxes
  for both owners and the route root at every sample;
- compact changed-node descriptions plus Timeline header, upcoming-panel,
  load-older, new-messages-pill, and child-count state.

Attach the recorder JSON before the while-open assertion and again after dismissal.
If any run fails, copy the complete Playwright result directory and JSON report to
a durable diagnostic directory before any rerun. Do not use `E2E_CHILD_LOG_DIR`:
redirected child output changes timing for this symptom.

The 2026-09-01 traced control completed 258 passed / 4 failed in 41.0 minutes; all
six outbound-MMS cases passed. Its complete report and the four non-target failure
traces are preserved under
`W:\tmp\outbound-mms-scroll-flake\.artifacts\full-trace-20260901-1239-86db0010`.

## Fix decision after evidence

- A pointer-driven owner scroll is a product isolation defect.
- A background layout change with correct dismissal restoration means the
  while-open assertion
  over-specifies the contract; keep the dismissal assertion and replace the
  while-open raw-offset assertion with proof that viewer gestures never target
  the background owners.
- A resize or mutation that should not occur during this test should be fixed or
  explicitly awaited at its source.
- Cross-spec state must be isolated at the originating actor rather than hidden by
  retrying or polling the final offset.
