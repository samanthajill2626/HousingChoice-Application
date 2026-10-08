# S10 report - browser specs, pins and records

Date: 2026-10-08. Authorized Caseworkers feature mission, S10 Tasks 10.1-10.12
including 10.8a. Worktree W:/tmp/caseworkers, feat/caseworkers, clean start
ac482f40. Parent owns Task 10.13, Task 10.14, independent review and live QA.
No app/dashboard source ownership. Spec revision 15 and plan assembly notes
are binding. Raw command/cwd/log/exit evidence: .superpowers/sdd/S10/.
Every command uses a scoped runner with a hard outer timeout.

## Task 10.1 - existing profiler and mutation catalog pins

Verification only: the route exclusion, registry TODO, makeCaseworker catalog
entry, dismissPossibleCaseworker catalog entry and raw-count 120 pin each
appear exactly once. The profiler issue exists and is open in the regenerated
issue index. S8 source pins, issue and README were not rewritten.
S1-S9 prerequisites and CP2 ac482f40 verified; no MERGE_HEAD and clean start.

- Cwd W:/tmp/caseworkers/e2e: npx vitest run performance/routes.test.ts
  performance/mutationCatalog.test.ts, exit 0, 30 tests in 2 files.
- Same cwd: npx vitest run, exit 0, 503 tests in 22 files.
- Cwd W:/tmp/caseworkers: npm run issues, exit 0, 390 open / 199 closed;
  no warnings. INDEX.md is ignored and not staged.

No RED claim: this is the plan's skip-if-done verification. No browser run,
aggregate root gate, infrastructure action or dependency change occurred.
This report records the evidence as produced; Task 10.1 needs no source commit.

## Task 10.2 - nav/preset pins; C5 blocks focused browser proof

Task 10.1 evidence commit: a38c5c82. Added the Caseworkers Workspace nav pin
and the planned Caseworker preset flow, including the assigned 375px geometry
and normal-click/aria-pressed assertions for all six choices. The existing S8
Relationships assertion is present exactly once and remains untouched.

- Cwd W:/tmp/caseworkers: npm run typecheck -w @housingchoice/e2e, exit 0.
- Same cwd: npx eslint e2e/tests/dashboard-next/contact-create.spec.ts
  e2e/tests/dashboard-next/frame.spec.ts, exit 0.
- Same cwd: npm run e2e -w @housingchoice/e2e --
  tests/dashboard-next/contact-create.spec.ts tests/dashboard-next/frame.spec.ts,
  exit 1, 7 passed / 1 failed / 0 skipped in 19.6s (runner 20.3s).
  Hard timeout 2700 seconds; completed naturally, no timeout or abort.
- Added-line ASCII and git diff --check pass.

### C5 - the six-choice KindPicker clips choices at 375px

The strict test at e2e/tests/dashboard-next/contact-create.spec.ts:201 fails
before any click can scroll a clipped button into view. At viewport 375x800,
the group spans x=33..342, y=201.75..258.75 (309x57). All segment boxes share
y=202.75 and height 55; measured horizontal geometry:

| Choice | x | Width | Right edge |
| --- | --- | --- | --- |
| Tenant | 34 | 64.484375 | 98.484375 |
| Landlord | 98.484375 | 77.25 | 175.734375 |
| Partner | 175.734375 | 68.203125 | 243.9375 |
| Caseworker | 243.9375 | 93.046875 | 336.984375 |
| Property Manager | 336.984375 | 77.71875 | 414.703125 |
| Other | 414.703125 | 57.8125 | 472.515625 |

The screenshot visually confirms that Property Manager and Other are clipped.
dashboard/src/routes/contact/KindPicker.module.css:11 defines a non-wrapping
flex segmentBar with overflow hidden; the segments keep their intrinsic
minimum sizes. This is a product responsive defect, not a selector failure.
No source fix or weakened assertion was made. The click loop and preset save
are intentionally not claimed as passing: the geometry prerequisite stopped
this case. The other six existing contact-create cases and frame case pass.

Evidence preserved by COPY (no original artifact removed):
.superpowers/sdd/S10/artifacts/10.2-clipping-2026-10-08T17-18-55-578Z/
contains test-results, html-report, results.json, lane.json, extracted
kind-picker-375px-geometry.json and kind-picker-375px.png. The failed test
folder also has test-failed-1.png, video.webm and error-context.md.
No trace was collected by the default no-retry configuration; geometry and
screenshots are decisive for this non-timing failure. The full captured run
is .superpowers/sdd/S10/10.2-browser.log. Previous browser artifacts were
copied before the run to artifacts/10.2-before-browser-2026-10-08T17-18-01-803Z/.

Parent accepted C5 for a minimal source fix and requested this planned handoff.
The strict test and finding are committed red at the parent's direction.
Task 10.2 remains incomplete. Tasks 10.3-10.12, including 10.8a, have not
started; no issue files were added and no documentation wording task was done.

Cwd W:/tmp/caseworkers: npm run e2e:stop, exit 0: no running session; retained
state stale or absent. Lane 13 ports 10301/10311/10321/10331 were checked after
stop and have no listener. Every owned runner has an exit marker. No browser,
interactive lane or command is left active. Source and command ownership are
released to the parent until Task 10.2 resumes after its C5 fix.

## Task 10.2 closeout - C5 fixed by parent

Resumed at clean 73031298, the parent's minimal responsive fix and tracked
C5-responsive-fix.md. Parent reran the unchanged strict contact-create/frame
command: exit 0, 8 passed / 0 failed / 0 skipped in 16.7s. All six normal
clicks, aria-pressed checks, save, stored partner/Caseworker and tab row pass.
At 375px the group is x=33,width=309; every button is 153px wide, at x=34 or
188, with right edge at most 341 inside the group right edge 342.
Parent also passed 104 picker/create/edit unit tests and bare root typecheck.
Evidence and screenshot inspection are recorded in C5-responsive-fix.md;
raw artifacts are .superpowers/sdd/C5/artifacts/green/ and checkpoint C5-*.
No redundant rerun. Task 10.2 is complete; source test commit eadf5bbc plus
parent correction 73031298. Ownership resumed after all parent commands and
lane listeners ended.

## Task 10.3 - verify existing organization wire pins

Task 10.2 closeout commit: 67fd85f9. Existing S5 usage pin kindLocked active=3,
OrgRecordField organization and README dev-seam field list all present; no
source changes or duplicate pins. Per skip-if-done Step 1, ran only Step 5's
browser command from W:/tmp/caseworkers: npm run e2e -w @housingchoice/e2e --
tests/dashboard-next/org-lists.spec.ts. Exit 0, 15 passed / 0 failed in 34.6s.
Raw evidence 10.3-browser.*, prior artifacts copied to
artifacts/10.3-before-browser-2026-10-08T17-25-59-191Z/. No RED claim.

## Task 10.4 - share-wording verification; recipient picker reachability defect

Task 10.3 evidence commit: efc839e4. The stale share-wording scan over e2e is
empty. Every planned test declaration line remains current. No pins needed
editing. All commands below ran from W:/tmp/caseworkers through the single
npm workspace hop, with 2700-second browser hard limits and no child-log flag.

The planned browser command was npm run e2e -w @housingchoice/e2e -- with
these exact arguments (each relative to e2e):

- tests/dashboard-next/broadcasts.spec.ts:96
- tests/dashboard-next/broadcasts.spec.ts:231
- tests/dashboard-next/landlord-activity.spec.ts:67
- tests/dashboard-next/listing-activity.spec.ts:85
- tests/dashboard-next/listing-activity.spec.ts:162
- tests/dashboard-next/matching-entry-points.spec.ts:103
- tests/dashboard-next/matching-entry-points.spec.ts:192
- tests/dashboard-next/share-skip-fix.spec.ts:156
- tests/dashboard-next/share-sent-outcome.spec.ts:621
- tests/dashboard-next/org-lists.spec.ts:318
- tests/dashboard-next/org-lists.spec.ts:447
- tests/scenarios/sending-unit.spec.ts

Result: exit 1, 12 passed / 1 failed in 2.1m (runner 128.888s), no skipped.
The failed property-page matching case resolves its Add a tenant option,
but a normal click at matching-entry-points.spec.ts:228 repeats element is
outside of the viewport until the 60-second test budget. No copy mismatch.
Original screenshot/video/error-context/report copied to
.superpowers/sdd/S10/artifacts/10.4-batch-failure-2026-10-08T17-29-43-876Z/.

Isolation: the same npm command with only
 tests/dashboard-next/matching-entry-points.spec.ts:192 and E2E_TRACE=1
exits 0, 1 passed in 10.8s. This does NOT excuse the prior failure: the
shorter candidate list places the picker higher. Captured run:
10.4-matching-trace.*. Preserved before the next run under
artifacts/10.4-before-batch-trace-2026-10-08T17-30-47-349Z/.

Reproduction: the same command with E2E_TRACE=1 and the FIRST SEVEN arguments
of the batch (the failing case plus its exact six predecessors) exits 1,
6 passed / 1 failed in 1.6m (runner 94.518s). The same option click fails
for the same outside-viewport reason. Full trace/screenshot/video/context
copied to artifacts/10.4-trace-reproduction-2026-10-08T17-32-29-575Z/.
The failed folder is dashboard-next-matching-en-2c0ce-and-picked-single-recipient-chromium;
trace.zip in that copied test-results folder is the decisive artifact.
Raw logs/commands/exits: 10.4-browser.*, 10.4-matching-trace.*,
10.4-batch-trace.* under .superpowers/sdd/S10/.

### Finding - ContactSearchField can place its whole option list below the viewport

Trace viewport is 1280x720. The final snapshot's body-portaled listbox starts
at top 722.797px, left 264px, width 992px. Its max-height expression is
max(9rem, min(-15px, 60vh)). Thus no part of the option can receive a normal
pointer click. The list resolves immediately; this is layout reachability,
not slow data. ContactSearchField.tsx:128 anchors only below the input
(rect.bottom + 4); :136 floors the height at 9rem. Its CSS :64 makes the
list fixed under document.body, outside the route scroll owner. AppFrame's
.main has height 100%; main.content is a separate overflow-y:auto region
(AppFrame.module.css:331,386). Scrolling the list cannot move that fixed
portal into the viewport. No force click, enlarged viewport, retry excuse,
source fix or weakened assertion was used.

ContactSearchField.tsx, ContactSearchField.module.css and
RecipientPreview.module.css are byte-unchanged at merge base
1861e154e5c72ed8a60945ca425d26d35d89149b. This alone does NOT establish a
pre-existing failure: the new nav row and copy could alter the trigger.
Baseline browser reproduction has not been performed; attribution remains
open for the parent. Raw trace parsing stays ignored in S10/trace-reference/.

E2e typecheck command npm run typecheck -w @housingchoice/e2e exits 0.
Task 10.4 remains incomplete because the required batch is red. Per scope,
stop/report on this production-source defect; later S10 tasks remain
unstarted. All owned commands finished naturally, no abort. npm run e2e:stop
exits 0 with no running session. Lane 13 ports 10301/10311/10321/10331 were
checked after stop and have no listeners. Ownership is released to parent
for the finding's attribution and disposition. No source files changed in
this Task 10.4 pass.
