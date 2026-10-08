# C5 correction - contact kind choices at phone width

Date: 2026-10-08. Parent-owned in-scope correction during S10 Task 10.2.
The worker committed the strict failing browser test and empirical finding at
eadf5bbc, then released ownership with a clean tree and lane 13 stopped.
This was a normal defect handoff, not an agent recovery.

At 375x800, the previous non-wrapping segment bar was 309px wide, while the
six choices extended to x=472.515625 past its x=342 right edge. Property
Manager and Other were clipped. S10-report.md contains the measured RED and
preserved failure evidence. The parent independently viewed that screenshot.

The correction in dashboard/src/routes/contact/KindPicker.module.css uses a
two-column grid at the existing modal phone breakpoint (599px), with token
borders between choices. An odd final choice spans both columns when there
are five choices. The desktop row and selection behavior are unchanged.
No page width cap, new dependency or API/data change was introduced.

Focused verification, all run from this worktree:

- Dashboard cwd: npx vitest run src/routes/contact/KindPicker.test.tsx
  src/routes/contact/ContactCreateForm.test.tsx
  src/routes/contact/ContactEditForm.test.tsx: exit 0, 104 tests in 3 files,
  runner 24.307 seconds. Existing act warnings remain.
- Root cwd: bare npm run typecheck: exit 0, all five workspaces,
  30.148 seconds.
- Root cwd: npm run e2e -w @housingchoice/e2e --
  tests/dashboard-next/contact-create.spec.ts tests/dashboard-next/frame.spec.ts:
  exit 0, 8 passed, 0 failed, 0 skipped, 16.7 seconds (runner 17.312 seconds).
  Original RED artifacts were copied before this rerun. No source was edited
  while the browser run was active.

The unchanged strict browser assertion now measures the group at
x=33,y=175,width=309,height=110.5. All six buttons are 153x35.5, in columns
x=34 and x=188; their rightmost edge is x=341, inside the group's x=342 edge.
All six real clicks and their aria-pressed assertions passed, followed by the
Caseworker preset save and stored partner/Caseworker checks. The parent
personally viewed the passing screenshot and confirmed visible labels.

Raw commands/logs/exits: .superpowers/sdd/checkpoints/C5-unit.*,
C5-typecheck.*, C5-browser.*. Copied original artifacts:
.superpowers/sdd/C5/artifacts/before-green/. Passing report and extracted
geometry/screenshot: .superpowers/sdd/C5/artifacts/green/.
Lane 13 ports 10301/10311/10321/10331 have no listener after the completed run.
No command remains active. S10 can resume at Task 10.2 closeout; the final
five gates and independent review still follow the complete browser slice.
