---
id: statustransition-activity-test-missing-deadlines-dep
title: makeServiceWithActivity test helper omits placementDeadlinesRepo → 2 milestone tests throw (pre-existing on main)
type: bug
severity: med
status: resolved
area: app
created: 2026-07-03
resolved: 2026-07-03
refs: app/test/statusTransition.test.ts:918, app/src/services/statusTransition.ts:476
---

**Problem.** The `makeServiceWithActivity` test helper (added by `feat/activity-coverage`)
wires the transition service WITHOUT `placementDeadlinesRepo`. But
`feat/placement-deadline-model` made that dep required and calls
`placementDeadlinesRepo.listByPlacement(placementId)` **unguarded** on every transition
(`statusTransition.ts:476`). So the two "placement stage milestone" tests
(`statusTransition.test.ts` ~:969, ~:978) — which use `makeServiceWithActivity` and then
call `transitionPlacement` — throw `Cannot read properties of undefined (reading
'listByPlacement')` before reaching their assertions.

This is **pre-existing on `main`**: `main`'s `makeServiceWithActivity` is byte-identical
(omits the dep) and its service requires + calls it unguarded, so an equivalent run on
`main` fails the same two tests. It landed via the `activity-coverage` ×
`placement-deadline-model` integration — `activity-coverage`'s helper was written before
the dep became required, and the merges didn't reconcile the helper. It surfaced when
syncing `main` into `feat/approval-and-move-in` and re-greening.

**Resolution (2026-07-03).** Added `placementDeadlinesRepo: world.placementDeadlinesRepo`
to `makeServiceWithActivity` (mirrors `makeService`; `FakeWorld` already provides the
repo). Fixed on `feat/approval-and-move-in` (commit ec364a9) AND directly on `main`
(commit cf39006, at Cameron's request) — main's app vitest suite is green again.

**Related, still-open pre-existing debt (main + this branch):** `main`'s test
*typecheck* (`tsc -p app/tsconfig.test.json`, part of `npm run typecheck`) is ALSO red
with `TS2532 Object is possibly 'undefined'` in `contactsCrud.test.ts:408` and the
`statusTransition.test.ts` milestone tests (`ev[0]` array-access without a guard) — more
`activity-coverage` test debt that `npm test` (vitest) doesn't catch. NOT fixed here (not
this feature's code); flagged to Cameron. Trivial (guard/assert the array access).
