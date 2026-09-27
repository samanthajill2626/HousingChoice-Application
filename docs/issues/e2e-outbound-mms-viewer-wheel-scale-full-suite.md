---
id: e2e-outbound-mms-viewer-wheel-scale-full-suite
title: Outbound-MMS viewer's discrete-wheel zoom stopped one step short (scale 7, expected 8) once in a full e2e run under load
type: bug
severity: low
status: open
area: e2e
created: 2026-09-27
refs: e2e/tests/dashboard-next/outbound-mms.spec.ts:517, e2e/tests/dashboard-next/outbound-mms.spec.ts:729
---

**Problem.** In one full `npm run e2e` (the send-outcome-reconcile gate run
P3d, 2026-09-27, commit 1d3bc869, code 52220729; 287 passed, 2 failed, 23.7m)
`outbound-mms.spec.ts:517` "(a) attach + send an image: the fake records media
AND the timeline renders it" failed in its viewer section:

```
Expected: 8
Received: 7
- Timeout 15000ms exceeded while waiting on the predicate
> 729 |     await expect.poll(() => readViewerScale(page)).toBe(8);
```

The file passed ALONE twice on the same code (`13 passed (1.3m)`, EXIT 0, run
together with `landlord-onboarding.spec.ts`), and the next full run on the same
code was `289 passed (23.2m)`, EXIT 0. The branch touches no viewer, media or
composer code.

This is not the closed signatures in
[`e2e-image-viewer-scroll-flake`](e2e-image-viewer-scroll-flake.md) (a scroll
baseline raced by the delivery re-anchor) or
[`outbound-mms-viewer-trigger-visibility-full-suite`](outbound-mms-viewer-trigger-visibility-full-suite.md)
(the trigger not visible): the viewer opened and zoomed; it stopped one
discrete step short of the scale the test polls for.

**Conditions.** The run was under known contention: the same worktree's
read-only reviewer ran single-file vitest suites against the shared DynamoDB
Local container during it, and an issue-filing agent worked in the tree. The
same run's other failure was a scenario spec (a sighting in
[`e2e-scenario-specs-rotate-failures-full-suite`](e2e-scenario-specs-rotate-failures-full-suite.md)).

**Hypothesis, unproven.** The test sends discrete `page.mouse.wheel` steps and
polls the viewer's scale after them without re-sending a step; if the browser
coalesces two wheel events into one while its main thread is busy, and the
viewer advances one step per event rather than per delta, one step is lost and
the poll can never reach its target. A trace of a failing run (retries are 0 and
traces are on-first-retry, so the gate captured none) or a run under
deliberate CPU load would decide it.

**Suggested fix.** First reproduce under load. If coalescing is the cause,
either make the viewer step by accumulated delta, or have the test wheel until
the scale reaches its target (bounded) instead of asserting after a fixed count
of events.
