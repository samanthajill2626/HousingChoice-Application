---
id: outbound-mms-viewer-scroll-capture-flake
title: outbound-mms.spec.ts (a) - the viewer scroll-owner capture is timing-sensitive after the pan-bounds drags (1 in 4 full runs)
type: bug
severity: low
status: open
area: e2e
created: 2026-09-01
refs: e2e/tests/dashboard-next/outbound-mms.spec.ts, docs/superpowers/reviews/2026-08-31-tour-reminder-ladder-phase-b/handback.md
---

## Symptom

`e2e/tests/dashboard-next/outbound-mms.spec.ts:247` ("(a) attach + send an image ...")
failed ONCE in four full `npm run e2e` runs on 2026-09-01, all on the same dashboard
code (branch `feat/tour-reminder-ladder-phase-b`, which does not touch the contact
page, the timeline, the MMS viewer, or the outbound-mms spec):

```
expect(scrollWhileOpen).toEqual(expectedScroll)   // outbound-mms.spec.ts:463
  timeline: { left: 0, top: 509 }   expected
  timeline: { left: 0, top: 797 }   received
```

The assertion captures `[data-viewer-test-timeline].scrollTop` while the viewer dialog
is open, immediately after four 12-step `page.mouse` pan drags to the viewer's bounds
(`:440-451`). The received `top` is 288px further down than the value captured before
the viewer opened.

## Evidence

- Full runs on the same code: 262/262 (@ee873111), 261/262 (@b9247388 - this failure).
  Earlier the same day on the same dashboard files: 261/261 (@66229715), 261 pass +
  1 unrelated fail (@9b6d972c). So 1 failure in 4 full runs.
- Isolated re-run through the e2e workspace immediately after the failure:
  `cd e2e && npx playwright test tests/dashboard-next/outbound-mms.spec.ts` ->
  6 passed (50.9s), including (a).
- Artifacts of the failing run: `e2e/.artifacts/test-results/dashboard-next-outbound-mm-
  2eb52-AND-the-timeline-renders-it-chromium/` (screenshot, video, error-context.md).
- Branch causality ruled out: `git diff ec32170a...b9247388 -- dashboard/src` touches
  `RemindersPanel` (tour page), `ScheduledCard` (a `discontinued` label branch the lean
  world cannot produce), `DeadlinesNudgesCard` (a label entry), `RosterConfirmDialog`
  (prose), `api/types.ts` (unions/labels). None renders on `/contacts/contact-tenant-0001`
  with lean data, and none changes layout height.

## Hypothesis

One of the pan drags (the "top bound" / "bottom bound" moves of +-4000/5000px) scrolls the
timeline stream behind the dialog when the pointer-up lands outside the viewer canvas,
or the timeline's own scroll-restore settles after the capture. Either way the capture
is a race between the drag's side effects and the `evaluate`, with no settle wait.

## Suggested fix

Capture the scroll owners BEFORE the pan-bounds loop (the property under test is
"opening the viewer did not scroll the owners", which does not need the pans), or
`expect.poll` the capture with a short settle. Not a product defect; not this
mission's file.
