# S3 (dashboard) build research - findings

Scope: plan Tasks 3.1-3.6 (plan lines 2244-4803) against the live tree
(HEAD 34e79ec7, merge-base main 5c0d3f6a). Spec D8, D9.

Summary: no BLOCKER, no MAJOR. Every Edit anchor is found exactly once, no
new file exists yet, every plan file lints clean (react-hooks v7 included),
typechecks clean at every task stage, and every RED/GREEN count the plan
states was reproduced by running the plan's own tests in a scratch copy of
dashboard/src (final folder: 8 files, 74 tests green; App.test.tsx also
green; e2e/performance/mutationCatalog.test.ts 4 passed with the new GET).
Evidence: `.superpowers/sdd/build-research/S3-reference.md` (gitignored).

## S3-F1 - MINOR - Task 3.4 Step 2 states the wrong RED reason for one case

- Plan: Task 3.4 Step 2, plan lines 3769-3772.
- Live: the test as written in the plan, plan lines 3678-3680; today's
  dashboard/src/routes/public/HousingFairIntake.tsx:10-48 renders no
  "Housing authority" label.
- What is wrong: the plan says "gives up after 10 seconds" fails RED "with a
  TypeError reading `mock.calls[0]`". The test calls `authoritySelect()`
  (plan line 3679) BEFORE it reads `getHousingAuthorities.mock.calls[0]`
  (plan line 3680), so on today's code it fails on "Unable to find a label
  with the text of: Housing authority". Observed in a run of the plan's
  test file. The 12 failed / 6 passed count is correct; only the stated
  reason is wrong, which can mislead the "red for the stated reason" check
  in ground rule 0.
- Correction: in plan lines 3770-3772, move "gives up after 10 seconds" into
  the "Unable to find a label with the text of: Housing authority" group, so
  the sentence reads: "...most with \"Unable to find a label with the text
  of: Housing authority\" (\"gives up after 10 seconds\" included, because it
  queries the select before reading the mock); \"aborts the list read on
  unmount\" with a TypeError reading `mock.calls[0]` (the list is never
  read); the StrictMode case on `toHaveBeenCalledTimes(2)` (0 calls)."

## S3-F2 - MINOR - stale e2e line cite in the S3 notes for S5

- Plan: S3 "Notes for S5", plan lines 2334-2337.
- Live: e2e/tests/dashboard-next/public-pages.spec.ts:380 (inside the test
  "/join: standalone intake with no session -> thank-you (no reveal)" at
  :371) is the /join "Sign me up" click. Line :352 is a flyer voucher-size
  assertion on `/p/:unitId`.
- What is wrong: the note cites `public-pages.spec.ts:352` as an existing
  spec that clicks "Sign me up" on /join. The claim itself holds (the
  button is disabled only while the list read is pending, and Playwright's
  click waits for enabled); only the line number is stale. The
  a2p-compliance.spec.ts:123,129 cites are correct.
- Correction: replace `public-pages.spec.ts:352` with
  `public-pages.spec.ts:380` in plan line 2336.
