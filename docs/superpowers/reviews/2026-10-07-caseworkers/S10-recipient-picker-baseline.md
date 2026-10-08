# S10 recipient picker failure - baseline attribution

Date: 2026-10-08. Parent authorized a clean detached-baseline diagnostic in
W:/tmp/caseworkers only. No shared-main HEAD, dependency, source or test
assertion was changed. Feature state was restored before this record.

## Finding

The Add a tenant contact search can put its entire fixed listbox below the
viewport. This is empirically pre-existing at merge base 1861e154, not caused
by Caseworkers navigation or recipient copy. It remains a real product defect
and a red Task 10.4 verification, not an excused timing failure.

The property-page hand-picked recipient case resolves its option immediately,
then normal click retries fail because the option is outside the viewport
(e2e/tests/dashboard-next/matching-entry-points.spec.ts:228). With a populated
preview list from the same six predecessor cases, both feature and baseline
traces have a 1280x720 viewport and identical listbox coordinates: top 722.797,
left 264, width 992, with max-height max(9rem, min(-15px, 60vh)). The portal
starts below the viewport before its first option. An isolated run passes
because the preview holds fewer rows; that does not close the defect.

ContactSearchField measures input bottom + 4 and only positions BELOW it;
the 9rem max-height floor does not move the list above the input
(dashboard/src/routes/contact/ContactSearchField.tsx:128,135).
ContactSearchField.module.css:64 makes this a fixed document.body portal.
The route's main.content scroll container cannot bring that fixed box into
view (dashboard/src/app/AppFrame.module.css:386). The picker TSX/CSS and
RecipientPreview.module.css have no diff from the merge base. Baseline's
older nav and tenant copy reproduce identical coordinates, accounting for
the alternative that the Caseworkers nav addition caused this trigger.

## Exact comparison

All runs used cwd W:/tmp/caseworkers, E2E_TRACE=1 and a 2700-second hard cap.
The common command was npm run e2e -w @housingchoice/e2e -- followed by:

- tests/dashboard-next/broadcasts.spec.ts:96
- tests/dashboard-next/broadcasts.spec.ts:231
- tests/dashboard-next/landlord-activity.spec.ts:67
- tests/dashboard-next/listing-activity.spec.ts:85
- tests/dashboard-next/listing-activity.spec.ts:162
- tests/dashboard-next/matching-entry-points.spec.ts:103
- tests/dashboard-next/matching-entry-points.spec.ts:192

| Revision | Runner label | Result | Runner time |
| --- | --- | --- | --- |
| Feature efc839e4 | 10.4-batch-trace | exit 1, 6 passed / 1 failed | 94.518s |
| Detached base 1861e154 | 10.4-base1861-trace | exit 1, 6 passed / 1 failed | 94.527s |

Both failures are the seventh case, at the same click, with 60s test budgets;
no run was aborted. Actual baseline HEAD and original declaration lines were
verified in a separate call before launch, including its original tenant-worded
share assertions. The earlier full Task 10.4 batch had 12 pass / 1 fail; its
other results remain recorded in S10-report.md. No force click or enlarged
viewport was used, and the timing-sensitive investigation did not set
E2E_CHILD_LOG_DIR.

Artifacts under .superpowers/sdd/S10/ (all copied before later runs):

- Feature: artifacts/10.4-trace-reproduction-2026-10-08T17-32-29-575Z/.
- True baseline: artifacts/10.4-base1861-failure-2026-10-08T17-39-39-901Z/.
- Each contains results.json, HTML report, screenshot, video, error-context,
  and test-results/dashboard-next-matching-en-2c0ce-and-picked-single-recipient-chromium/trace.zip.
- Raw commands/logs/exits: 10.4-batch-trace.* and 10.4-base1861-trace.*.
- Extracted raw snapshot/network reference: trace-reference/ and
  baseline-trace-reference/ (ignored; findings are kept in this record).

## Checkout discipline and procedural correction

Recorded original branch feat/caseworkers at
5c45536d68a74179c15602aa5fb141870a61842b, clean, no MERGE_HEAD and lane 13
ports free. Exact package.json/package-lock.json/npm-shrinkwrap.json basename
comparison covered seven tracked dependency files across both revisions and
found no changes; no install was needed. Ignored state was preserved.

The first preflight used an overly broad *lock* pattern, which matched
mission-block.md and correctly stopped before detaching. An incorrectly
sequenced following invocation still ran on feature HEAD; its misleading
label 10.4-baseline-trace is NOT BASELINE EVIDENCE. It completed exit 1,
6 pass / 1 fail and was preserved separately under
artifacts/10.4-excluded-feature-repeat-2026-10-08T17-37-01-956Z/.
Correction: separate calls for preflight, detachment, actual HEAD verification
and launch, and exact dependency basenames. Only 10.4-base1861-trace is the
real baseline run.

After the true baseline run, npm run e2e:stop exited 0 (nothing running),
all lane 13 ports 10301/10311/10321/10331 had no listener, and the detached
checkout was clean. A separate git switch restored feat/caseworkers;
a separate read verified branch, exact original HEAD and clean status.
Every command has completed. No production or test source changed here.

Existing issues were searched first. The resolved late-scroll dismissal
issue is a different signature (list disappears); the resolved property-first
issue concerns a UnitSearchField overlay intercepting a click. Neither tracks
this visible but offscreen ContactSearchField list. Filed separately as
[contact-search-popover-below-viewport](../../../issues/contact-search-popover-below-viewport.md).
Parent owns the scope decision and any source fix. Task 10.4 stays baseline-red.

Registry validation: npm run issues exited 0 with 391 open / 199 closed /
590 total and no schema warning. Raw result: .superpowers/sdd/S10/10.4-picker-issue.*.
