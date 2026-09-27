# Planner verdict - feat/staff-notes-past-tours

Date: 2026-09-27 (morning, still under the overnight unattended rule)
Planner: Fable (this session). Orchestrator: Fable (build-orchestrator), resumed
once after the planner's usage-limit death (infra tier; recovery budget unused).

## VERDICT: MERGE-READY - UNMERGED (human gate)

Branch `feat/staff-notes-past-tours` at `W:\tmp\staff-notes-past-tours`,
code head `c673011a`, tip `dd25c23b` (records only after the code head),
cut from and 0 behind `main` @0dafe3c1 (main did not move overnight).

Merge (PowerShell, from the main checkout, only when you are ready):

    git merge --no-ff feat/staff-notes-past-tours

No infra, dependency, deploy, seed-world or message-catalog change. No
post-merge operation owed. Cleanup (worktree, branch, doc stamping) only on
your explicit go.

## For Cameron's decision (not blocking the merge)

1. **Stale-page overwrite of staff notes** (adversarial A-1, MEDIUM; issue
   `staff-notes-stale-page-overwrite`). Two staff on the same tenant: the
   second Save silently replaces the first's newer note, and the old text is
   unrecoverable (the audit row has field names only). Spec Q12 chose
   last-write-wins on purpose (parity with every contact field); the reviewer's
   point is that THIS box exists to hold hand-typed facts that matter. The
   field already carries `staff_notes_updated_at`, so a 409-on-stale guard is
   cheap. Your call whether to build it before Sam uses the box in anger.
2. The decisions taken alone overnight: spec section 9 (Q1-Q14) and handback
   section 2 (OD-1..OD-7, X-1, F-8, F-10, A-2, 840px). The ones with product
   weight: Past runs THROUGH the end of today and today's still-scheduled tours
   stay on Active (Q9); a toured tour with a move-forward outcome and no
   placement shows as "Needs placement" (Q3); no-show rows have no way off the
   list until they age out at 90 days (Q11, issue filed); a toured tour with no
   date never appears (Q10, issue filed); `/tours/past` is excluded from the
   `perf:pages` route pin rather than registered as a 32nd profiler surface
   (OD-1, issue filed); Past rows align on fixed action slots and stack up to
   840px panes (OD-7).

## Gates (bare, from the worktree, quoted exit codes)

Orchestrator, on the gated tree `03768233` (code head `9382e0c7`), after the
ONE main sync ("Already up to date"): typecheck 0; test 0 (app 7207 passed,
1 skipped; dashboard 3425; e2e-vitest 499; fake-twilio 245; fake-twilio-web
111); smoke 0; e2e run 1 EXIT 1 `286 passed / 1 failed` (the open issue
`group-reply-live-rollup-full-suite-flake`, untouched path, isolated green
27.1 s, new evidence appended to the issue), run 2 EXIT 0 `287 passed
(26.6m)`; lint 1 = the 3 merge-base errors only.

Planner, independently, on `821d8a36` (same code head), quiet tree, 12:14Z:

| gate | exit |
|---|---|
| `npm run typecheck` | 0 |
| `npm test` | 1 - app 375/376: the one failure is the OPEN registered `tour-reminders-earlier-tie-break-test-ms-race` (file untouched by this branch, on main since 2026-09-26); re-run alone twice: 0, 0. Every other workspace green. 0 `[dynamoAdmin]` lines. |
| `npm run smoke` | 0 |
| `timeout 2700 npm run e2e` | 0 - `287 passed (28.3m)`, with the voicemail mission's e2e live concurrently |
| `npx eslint <touched files>` | 1 - `3 problems`, exactly the merge-base baseline (unused `FieldSource` import in TenantFile; `react-hooks/purity` in TourDetail, shifted; `react-hooks/set-state-in-effect` in the pre-existing `useClosedTours`, shifted). No new error; every new file clean. |

Delta since those runs: ONE code commit, `c673011a` - the Past row link's
accessible name now ends with its state chip (a screen-reader fix from my
adversarial review), the perf ledger's three Tours citations refreshed to
HEAD's lines, one comment. Proportionate re-verification on `c673011a`:
dashboard and e2e typecheck 0; `ToursPage.test` + `useTours.test` 66/66;
`e2e/performance/routes.test.ts` 24/24; lint on the four touched files clean;
the two new Playwright specs isolated on a fresh hermetic stack: `2 passed`.
Not re-run on `c673011a`: the app workspace's suites and smoke (no app file
changed) and the other 285 e2e specs (nothing they touch changed). Say so if
you want the full five on the final commit before merging; it is ~40 minutes.

## Reviews and adjudications (all records committed in this directory)

- Design: spec 3 rounds (37 + 9 + 4 findings), plan 3 rounds (29 + 6 + 3);
  every finding adjudicated in `spec-r*-adjudications.md` /
  `plan-r*-adjudications.md`.
- Build: research (4 readers), R1 spec-conformance CONFORMS 0/2/7, R1
  adversarial plan-blind 0/3/3 (three probe-reproduced bugs, all fixed
  red-first), fix wave 1 (F-1..F-11), R2 re-review 0/1/4, fix wave 2, live
  self-QA with wire proofs and eleven screenshots (`self-qa.md`).
- Planner: conformance CONFORMS (10 low), adversarial 0 blocking / 1 medium /
  7 low; adjudications in `planner-review-adjudications.md`. Fixed by me:
  A-4 (accessible name), C-4/A-6 (citations), C-3 (comment). Filed by me:
  `staff-notes-stale-page-overwrite` (decision), `contact-patch-fans-out-on-every-field`
  (debt, pre-existing). Accepted as known: a batch straddling a tab switch or
  route change shows no per-row result (the list refresh is the truth); the
  busy flag has no timeout or progress text; focus drops to body after
  Save/Cancel; `resetBulkBatchStoreForTests` is exported from production code.

## Issues on the branch (10)

Design phase: `extraction-prompt-read-staff-notes`,
`staff-notes-on-landlord-partner-files`, `tours-scheduled-range-query-unpaginated`,
`past-tab-timeless-toured-tours`, `past-tab-no-show-rows-need-an-exit`,
`tour-conversion-pending-placeholder-view-link`. Build:
`perf-pages-tours-past-surface`, `tours-patch-status-precondition`. Planner
review: `staff-notes-stale-page-overwrite`, `contact-patch-fans-out-on-every-field`.
Plus evidence appended to `group-reply-live-rollup-full-suite-flake` and a note
on `staff-notes-on-landlord-partner-files`.

## Incidents

- The first orchestrator died at 03:36Z on the usage limit (planner side);
  the 1:28am timer fired, a fresh orchestrator resumed from the ledger with
  nothing redone. Recovery tally 0 of 2.
- While clearing my stale transcript mirror at 01:29 I matched on the script
  name and stopped every `transcript-tail` process on the box, which included
  the voicemail-greeting mission's live.log mirror. Its build was unaffected;
  its live.log stopped updating then. Recorded in memory so it is filtered by
  path next time.
