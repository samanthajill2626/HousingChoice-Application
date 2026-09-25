---
id: outbound-mms-viewer-trigger-visibility-full-suite
title: Outbound-MMS viewer trigger can be non-visible only in the full E2E suite
type: bug
severity: med
status: resolved
area: e2e
created: 2026-09-02
resolved: 2026-09-24
refs: e2e/tests/dashboard-next/outbound-mms.spec.ts:587-625, docs/superpowers/reviews/2026-09-02-comms-clickable-links/final-gate-adjudication.md, docs/issues/e2e-outbound-mms-viewer-trigger-not-visible.md
---

**Resolution (2026-09-24) - duplicate.** This is the same failure as
[`e2e-outbound-mms-viewer-trigger-not-visible`](e2e-outbound-mms-viewer-trigger-not-visible.md),
filed in parallel the same day and fixed there in `f8d72a2e` (2026-09-07).
Same test (`outbound-mms.spec.ts:517`, case (a)); same throw site - the spec's
only `trigger is not visible`, raised inside the `trigger.evaluate` at `:591`,
and this run's log reads `outbound-mms.spec.ts:591:42`; and the same
pass-alone / fail-in-suite shape. The canonical issue's diagnosis explains that
shape and shows it is not full-suite-only: earlier specs leave MMS history in
the Timeline, so the conditional 180px cap was skipped and centering pushed the
trigger below the viewport; a three-test sequence reproduces it. A full suite on
the fixed code (`ca4317c8`, recorded in
`docs/superpowers/reviews/2026-09-08-a2p-consent-e2e-fix/adjudication.md`)
passed all six outbound-MMS cases. Kept rather than deleted, per the
[issue lifecycle](README.md#lifecycle); the original report follows.

**Problem.** A full hermetic E2E run on 2026-09-02 failed the outbound-MMS
image-viewer test while arranging its scroll owners: `trigger.evaluate` raised
`trigger is not visible`. The suite otherwise reported 266 passing cases. The
same file passed twice in isolation on the identical synchronized commit, with
all 6 cases passing in 46.1 and 44.9 seconds.

The recorded base also has a red result in this file, but at a different,
historical viewer-scroll assertion (expected Timeline scroll top 512, received
500). That older symptom is already documented as resolved in
[[e2e-image-viewer-scroll-flake]]. Do not conflate the two without a trace that
shows the same first scroll owner movement.

**Suggested fix.** Reproduce under the full suite with trace evidence and
identify why `scrollIntoViewIfNeeded()` can leave the named attachment trigger
outside the viewport after the test arranges its scroll owners. Preserve the
current state-based Delivered wait and exact viewer scroll contract; do not
paper over the result with a timeout or by weakening the visibility assertion.
