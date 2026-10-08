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
