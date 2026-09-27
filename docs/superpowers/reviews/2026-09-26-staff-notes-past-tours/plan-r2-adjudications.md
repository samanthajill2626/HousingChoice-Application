# Plan review round 2 - adjudications

Plan: v5 @20039fc3 -> v6 (this round). Spec DRAFT 4 (one precision edit:
4.5, how the Past view's state resets).
Reviewer: A continued (`plan-r2-reviewer-a.md`, 6 findings; every R1
adjudication conceded except one contest, accepted below). It rebuilt every
v5-changed dashboard file in a scratchpad, linted them against the repo's
config and typechecked all three workspaces at 0 base errors.
Planner: Fable, overnight unattended run.

Counts: 6 findings -> 6 ACCEPT (1 changed how a task is built), 0 REJECT.

| # | finding | ruling |
|---|---|---|
| R2-1 | `waitFor` is used nine times in the ToursPage tests but never imported (already in v4; both R1 reviewers missed it) | ACCEPT. Task 7 step 1 adds it to the `@testing-library/react` import. |
| R2-2 | keying the tours routes by view remounts the whole page on every tab click: every contact and unit lookup refetches behind a spinner (a regression of the existing Active/Closed tabs), the spec's "one component instance" sentence becomes false, and `bulkBusyRef` stops guarding across a mid-batch switch | ACCEPT - build shape changed. The batch state, the data hook and the runner move into a Past-only child `PastToursView` that mounts while Past shows and unmounts on a tab switch; the page keeps the lookups and the tabs; App.tsx and the test wiring carry NO keys. Lint-clean by construction (no effect, no key). Spec 4.5 reworded. The existing "Active view" test asserts the Past hook is never called there. |
| R2-3 | the orphan recipe's `node e2e/support/lane.mjs` reserves a 240 s lane lease and can print another lane's ports | ACCEPT. The recipe reads `e2e/.artifacts/lane.json` BEFORE `e2e:stop`, proves the ports free with `Get-NetTCPConnection`, and branches on "failure named" vs "timed out with no failure yet". |
| R2-4 | the gate-5 baseline note names one of three pre-existing errors in touched files and attributes by line | ACCEPT. All three named (`useTours.ts` set-state-in-effect, `TourDetail.tsx` purity, `TenantFile.tsx` unused import) with "attribute by rule and context, lines shift". |
| R2-5 | two tests read the DOM synchronously right after a resolved `findByRole` / `waitFor`, possibly before the batched render commits | ACCEPT. `findBy*` / `findAllBy*` throughout those two tests. |
| R2-6 (CONTEST of A1/B2) | the Task 6 header-comment bullet still says "to now" and omits the Needs-placement exception | ACCEPT. Fixed. |

## Round 3

R2-2 changed how Task 7 is built (a new child component), so a narrow round 3
runs on that delta only, with reviewer A continued. Hard cap 4; this is round
3 of the plan review.
